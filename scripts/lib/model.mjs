// Turns raw rows from the official lists into the products the site shows.
// Pure functions, shared by the build script and the tests.

import { isoDate } from './pfu.mjs';

// ---- small helpers ---------------------------------------------------------

export const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

/** Letters and digits only: "Abena Slip L4 /packet" -> "ABENASLIPL4PACKET". */
export const squash = (s) => fold(s).replace(/[^A-Z0-9]/g, '');

export const words = (s) => fold(s).split(/[^A-Z0-9]+/).filter(Boolean);

export function price(cell) {
  const n = Number.parseFloat(String(cell || '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

export function dateNumber(cell) {
  const iso = isoDate(cell);
  return iso ? Number(iso.replace(/-/g, '')) : 0;
}

/** Barcode digits, or '' when the cell holds no usable code. */
export function cleanEan(cell) {
  const raw = String(cell || '').trim();
  if (!/^[\d\s-]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : '';
}

/** True for a well-formed EAN-8, UPC-A, EAN-13 or GTIN-14 (length and check digit). */
export function validEan(digits) {
  if (!/^(\d{8}|\d{12,14})$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false; // 0000000000000 and the like are placeholders
  const ds = digits.split('').map(Number);
  const check = ds.pop();
  let sum = 0;
  ds.reverse().forEach((d, i) => {
    sum += d * (i % 2 ? 1 : 3);
  });
  return (10 - (sum % 10)) % 10 === check;
}

const tidyName = (s) =>
  String(s || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ');

function tidyBrand(brand, name) {
  const b = tidyName(brand);
  if (!b || /^(n\/?a|nil|none|-+|\.+)$/i.test(b)) return '';
  if (squash(b) === squash(name)) return '';
  return b;
}

// ---- grocery categories ----------------------------------------------------

// Order matters: the first pattern that matches the official "Commodity Type" wins.
export const CATEGORY_RULES = [
  ['infant-milk', /infant milk/i],
  ['milk-powder', /milk powder/i],
  ['infant-food', /infant food/i],
  ['rice', /\brice\b/i],
  ['pasta', /pasta|macaroni|spaghetti/i],
  ['pulses', /pulses|lentil/i],
  ['oil', /edible oil/i],
  ['butter', /butter|margarine/i],
  ['cheese', /cheese/i],
  ['cereals', /cereal/i],
  ['canned-fish', /sardine|tuna|mackerel|pilchard|canned fish/i],
  ['canned-meat', /pork|poultry|sausage|corned|luncheon/i],
  ['frozen-veg', /frozen/i],
  ['canned-veg', /canned (vegetables|tomato)/i],
  ['tea', /\btea\b/i],
  ['baby-diapers', /baby diaper/i],
  ['adult-diapers', /adult diaper/i],
  ['sanitary', /sanitary|tampon/i],
  ['soap', /soap|detergent/i],
  ['toilet-paper', /toilet paper/i],
  ['animal-feed', /animal feed/i],
];

export const CATEGORY_IDS = [...CATEGORY_RULES.map(([id]) => id), 'other'];

export function categoryOf(type) {
  for (const [id, pattern] of CATEGORY_RULES) if (pattern.test(type)) return id;
  return 'other';
}

// ---- groceries -------------------------------------------------------------

function columns(headers) {
  const find = (re) => headers.findIndex((h) => re.test(h));
  return {
    date: find(/effective/i),
    batch: find(/batch/i),
    brand: find(/brand/i),
    name: find(/commodity name/i),
    type: find(/commodity type/i),
    ean: find(/ean/i),
    m: find(/\(M\)/),
    r: find(/\(R\)/),
  };
}

const numbersIn = (s) => new Set((fold(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.').replace(/^0+(?=\d)/, '')));

/**
 * Pack size read from a name, so "5KGS" and "20KG" are told apart and "1KG" equals "1000 G".
 * Returns { amounts: Set of "5000g" / "750ml", packs: Set of multipliers like "4" in "4X100G" }.
 */
export function packSize(name) {
  const text = fold(name).replace(/(\d),(\d)/g, '$1.$2');
  const amounts = new Set();
  const packs = new Set();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(KGS?|KILOS?|GMS?|GRS?|GRAMS?|G|MLS?|LTRS?|LITRES?|LITERS?|LTS?|L|CL)(?![A-Z])/g)) {
    const n = Number(m[1]);
    const unit = m[2];
    if (/^K/.test(unit)) amounts.add(`${n * 1000}g`);
    else if (/^G/.test(unit)) amounts.add(`${n}g`);
    else if (/^ML/.test(unit)) amounts.add(`${n}ml`);
    else if (unit === 'CL') amounts.add(`${n * 10}ml`);
    else amounts.add(`${n * 1000}ml`);
  }
  for (const m of text.matchAll(/(\d+)\s*X\s*(?=\d)|(?:^|[^A-Z0-9])X\s*(\d+)(?![.\d]*\s*(?:KG|G|ML|L|CL))/g)) packs.add(String(Number(m[1] || m[2])));
  return { amounts, packs };
}

const disjoint = (a, b) => a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

/**
 * Two names recorded under the same barcode: are they one product?
 * Importers retype names ("ABENA SLIP L4 PREMIUM" / "Abena Slip L4 Premium 18 pieces /packet")
 * and sometimes reuse a barcode for another pack or flavour. A wrong merge would hide a
 * product, so this errs on the side of keeping entries apart.
 */
export function sameProductName(a, b) {
  const sa = squash(a);
  const sb = squash(b);
  if (sa === sb) return true;
  const pa = packSize(a);
  const pb = packSize(b);
  if (disjoint(pa.amounts, pb.amounts) || disjoint(pa.packs, pb.packs)) return false;
  const sameAmounts = pa.amounts.size > 0 && pa.amounts.size === pb.amounts.size && [...pa.amounts].every((x) => pb.amounts.has(x));
  if (!sameAmounts && disjoint(numbersIn(a), numbersIn(b))) return false;
  if (sa.startsWith(sb) || sb.startsWith(sa)) return true;
  // Same words in another order ("1KG MACARONI CARREFOUR" / "CARREFOUR MACARONI 1000G").
  const wa = new Set(words(a).filter((w) => !/\d/.test(w)));
  const wb = new Set(words(b).filter((w) => !/\d/.test(w)));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared >= 2 && shared / Math.max(wa.size, wb.size) >= 0.8;
}

/**
 * rawLists: [{ list: 'p' | 's', headers, rows }]
 * Returns { items, types, stats } where each item is one product with its
 * approved prices, newest first.
 */
export function buildGroceries(rawLists) {
  const stats = { rows: 0, noName: 0, noPrice: 0, noDate: 0, products: 0, subsidisedProducts: 0, unmappedTypes: {} };
  const types = [];
  const typeIndex = new Map();
  const records = [];

  for (const { list, headers, rows } of rawLists) {
    const c = columns(headers);
    for (const row of rows) {
      stats.rows++;
      const name = tidyName(row[c.name]);
      if (!name) {
        stats.noName++;
        continue;
      }
      const m = price(row[c.m]);
      const r = price(row[c.r]);
      if (!m && !r) {
        stats.noPrice++;
        continue;
      }
      const date = dateNumber(row[c.date]);
      if (!date) {
        stats.noDate++;
        continue;
      }
      const type = String(row[c.type] || '').trim();
      if (!typeIndex.has(type)) {
        typeIndex.set(type, types.length);
        types.push(type);
      }
      const cat = categoryOf(type);
      if (cat === 'other' && type) stats.unmappedTypes[type] = (stats.unmappedTypes[type] || 0) + 1;
      // Codes that fail the check digit are importers' internal references or typos: no use to a shopper.
      const code = cleanEan(row[c.ean]);
      const ean = validEan(code) ? code : '';
      records.push({ name, brand: tidyBrand(row[c.brand], name), ean, eanOk: Boolean(ean), type: typeIndex.get(type), cat, date, m, r, sub: list === 's' ? 1 : 0 });
    }
  }

  // Newest first, so the first record of a product carries its current name.
  records.sort((a, b) => b.date - a.date || b.sub - a.sub || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const products = [];
  const byEan = new Map(); // barcode -> products that carry it
  const byName = new Map(); // squashed name + brand -> product without a barcode
  for (const rec of records) {
    let product;
    if (rec.eanOk) {
      const candidates = byEan.get(rec.ean) || [];
      // Two different names approved on the same day are two entries on the official list
      // (another importer, another flavour): keep them apart.
      product = candidates.find(
        (p) =>
          p.names.some((n) => squash(n) === squash(rec.name)) ||
          (sameProductName(p.name, rec.name) && !p.history.some((h) => h[0] === rec.date)),
      );
      if (!product) {
        product = { name: rec.name, names: [rec.name], brand: rec.brand, ean: rec.ean, cat: rec.cat, history: [] };
        candidates.push(product);
        byEan.set(rec.ean, candidates);
        products.push(product);
      } else if (!product.names.includes(rec.name)) {
        product.names.push(rec.name);
      }
    } else {
      // No barcode: the same name is the same product unless two different brands are stated.
      const key = squash(rec.name);
      const candidates = byName.get(key) || [];
      const brand = squash(rec.brand);
      product = candidates.find((p) => {
        const other = squash(p.brand);
        return !brand || !other || brand.includes(other) || other.includes(brand);
      });
      if (!product) {
        product = { name: rec.name, names: [rec.name], brand: rec.brand, ean: '', cat: rec.cat, history: [] };
        candidates.push(product);
        byName.set(key, candidates);
        products.push(product);
      }
    }
    if (!product.brand && rec.brand) product.brand = rec.brand;
    if (!product.history.some((h) => h[0] === rec.date && h[1] === rec.sub && h[2] === rec.m && h[3] === rec.r)) {
      product.history.push([rec.date, rec.sub, rec.m, rec.r, rec.type]);
    }
  }

  // A product recorded once without its barcode and once with it is one product.
  const bySquash = new Map();
  for (const p of products) {
    const key = squash(p.name);
    if (!bySquash.has(key)) bySquash.set(key, []);
    bySquash.get(key).push(p);
  }
  const dropped = new Set();
  for (const group of bySquash.values()) {
    const withCode = group.filter((p) => validEan(p.ean));
    const without = group.filter((p) => !validEan(p.ean));
    if (withCode.length !== 1 || !without.length) continue;
    for (const p of without) {
      for (const h of p.history) {
        if (!withCode[0].history.some((x) => x[0] === h[0] && x[1] === h[1] && x[2] === h[2] && x[3] === h[3])) withCode[0].history.push(h);
      }
      dropped.add(p);
    }
    withCode[0].history.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  }

  const today = todayNumber();
  const items = products
    .filter((p) => !dropped.has(p))
    .map((p) => {
      p.history.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
      const before = p.history.length;
      p.history = collapseHistory(p.history, today);
      stats.repeatsMerged = (stats.repeatsMerged || 0) + before - p.history.length;
      return p;
    })
    .sort((a, b) => b.history[0][0] - a.history[0][0] || (fold(a.name) < fold(b.name) ? -1 : 1));

  stats.products = items.length;
  stats.subsidisedProducts = items.filter((p) => p.history[0][1] === 1).length;
  return { items, types, stats };
}

// ---- medicines -------------------------------------------------------------

export const MEDICINE_CLASSES = ['diabetes', 'hypertension', 'cardio', 'cancer', 'other'];

const CLASS_PATTERNS = [
  ['diabetes', /DIAB|DIAT[BE]|ANITDIA/],
  ['hypertension', /HYPERTEN|HYERTEN|HYPERTN|HIPERTEN/],
  ['cardio', /CARDIO|CARDOV|CARDIV|CARDIA|CADIOV|VASCU|VACUL|VASUL|LIPID|COAGUL/],
  ['cancer', /CANCER|ONCOL|NEOPLAS/],
];

function classIn(text) {
  const letters = fold(text).replace(/[^A-Z]/g, '');
  for (const [id, pattern] of CLASS_PATTERNS) if (pattern.test(letters)) return id;
  return '';
}

/**
 * Importers append the therapeutic class to the product name in many spellings:
 * "TELTAS 40 H (CARDIOVASCULAR)", "TRIATEC 5MG X 30 TAB (SC)-ANTI-HYPERTENSIVE".
 * Returns the class and the name without that tail.
 */
export function splitMedicineName(full) {
  const name = tidyName(full);
  const match = CLASS_TAIL.exec(name);
  if (match && match.index > 0) {
    const head = name
      .slice(0, match.index)
      .replace(/\(\s*\w{0,3}\s*$/, '') // a bracket left open by the cut, e.g. "(U"
      .replace(/[\s\-–(,'"]+$/, '');
    const cls = classIn(match[0]);
    if (head && cls) return { cls, name: head };
  }
  return { cls: classIn(name) || 'other', name };
}

// The class label at the very end of a name, with whatever punctuation leads into it:
// " (CARDIOVASCULAR)", "- ANTI-HYPERTENSIVE", "-'ANTI-HYPERTENSIVE'", " ( ANTI CANCER)".
const CLASS_WORD = '(?:DIAB|DIAT[BE]|HYPERTEN|HYERTEN|HYPERTN|CARDIO|CARDOV|CARDIV|CARDIA|CADIOV|CANCER|ONCOL)[A-Za-z]*';
const CLASS_TAIL = new RegExp(`[\\s\\-–(,'"]*(?:\\b(?:ANTI|ANIT)[\\s-]*)?${CLASS_WORD}(?:[\\s\\-/]+[A-Za-z]+){0,3}[\\s)'"]*$`, 'i');

/**
 * rawLists: [{ list: 'phs' | 'ph', headers, rows }]
 * One item per medicine name, each with its approved batches, newest first.
 */
export function buildMedicines(rawLists) {
  const stats = { rows: 0, noName: 0, noPrice: 0, noDate: 0, medicines: 0, batches: 0 };
  const byKey = new Map();
  for (const { list, headers, rows } of rawLists) {
    const c = columns(headers);
    for (const row of rows) {
      stats.rows++;
      const full = tidyName(row[c.name]);
      if (!full) {
        stats.noName++;
        continue;
      }
      const m = price(row[c.m]);
      const r = price(row[c.r]);
      if (!m && !r) {
        stats.noPrice++;
        continue;
      }
      const date = dateNumber(row[c.date]);
      if (!date) {
        stats.noDate++;
        continue;
      }
      const { cls, name } = splitMedicineName(full);
      const sub = list === 'phs' ? 1 : 0;
      const key = `${sub}|${squash(name)}`;
      let item = byKey.get(key);
      if (!item) {
        item = { name, cls, sub, brand: '', batches: [], latest: 0 };
        byKey.set(key, item);
      }
      if (date > item.latest) {
        item.latest = date;
        item.name = name;
        if (cls !== 'other') item.cls = cls;
      }
      const brand = tidyBrand(row[c.brand], full);
      if (brand && !item.brand && squash(brand) !== squash(name) && !/^(tablets?|capsules?)$/i.test(brand)) item.brand = brand;
      const batch = String(row[c.batch] || '').trim();
      if (!item.batches.some((b) => b[0] === date && b[1] === batch && b[2] === m && b[3] === r)) item.batches.push([date, batch, m, r]);
    }
  }
  const items = [...byKey.values()];
  for (const item of items) {
    item.batches.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    stats.batches += item.batches.length;
  }
  items.sort((a, b) => b.latest - a.latest || (fold(a.name) < fold(b.name) ? -1 : 1));
  stats.medicines = items.length;
  return { items, stats };
}

// Today in Mauritius as yyyymmdd.
export function todayNumber(now = new Date()) {
  const d = new Date(now.getTime() + 4 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * The same price approved again on another date (same list, same Mauritius and
 * Rodrigues prices) tells a shopper nothing, and the official list often replaces the
 * older entry with the newer one: keep one entry per unchanged price. The newer date is
 * kept, as on the official list, unless it is still in the future, in which case the
 * entry in force today is kept. History is newest first.
 */
export function collapseHistory(history, today = todayNumber()) {
  const out = [];
  for (const h of history) {
    const prev = out[out.length - 1];
    if (prev && prev[1] === h[1] && prev[2] === h[2] && prev[3] === h[3]) {
      if (prev[0] > today) out[out.length - 1] = h; // the newer one is not in force yet
      continue;
    }
    out.push(h);
  }
  return out;
}
