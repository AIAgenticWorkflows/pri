// Turns the stores (one per official list) into the three files the page loads:
// groceries.json, medicines.json and meta.json.

import { BASE_URL, LISTS } from './pfu.mjs';
import { CATEGORY_IDS, MEDICINE_CLASSES, buildGroceries, buildMedicines } from './model.mjs';

// One item per line keeps the files diff-friendly and still compact.
const lines = (head, key, items) =>
  `${JSON.stringify(head).replace(/}$/, '')},"${key}":[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]}\n`;

function latestDate(rows, headers) {
  const col = headers.findIndex((h) => /effective/i.test(h));
  let best = '';
  for (const row of rows) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row[col] || '');
    if (m && `${m[3]}-${m[2]}-${m[1]}` > best) best = `${m[3]}-${m[2]}-${m[1]}`;
  }
  return best;
}

/**
 * stores: { p, s, ph, phs } (any may be missing or empty).
 * Returns { groceries, medicines, meta } as text, plus the stats.
 */
export function buildOutputs(stores, { generatedAt = new Date().toISOString() } = {}) {
  const have = (key) => stores[key] && Array.isArray(stores[key].rows) && stores[key].rows.length && Array.isArray(stores[key].headers);
  const asList = (key) => ({ list: key, headers: stores[key].headers, rows: stores[key].rows });

  const groceries = buildGroceries(['p', 's'].filter(have).map(asList));
  const catIndex = new Map(CATEGORY_IDS.map((id, i) => [id, i]));
  const groceriesText = lines(
    { v: 1, generatedAt, cats: CATEGORY_IDS, types: groceries.types },
    'items',
    groceries.items.map((p) => [p.name, p.brand, p.ean, catIndex.get(p.cat), p.history]),
  );

  const medicines = buildMedicines(['phs', 'ph'].filter(have).map(asList));
  const classIndex = new Map(MEDICINE_CLASSES.map((id, i) => [id, i]));
  const medicinesText = lines(
    { v: 1, generatedAt, classes: MEDICINE_CLASSES },
    'items',
    medicines.items.map((m) => (m.eans.length ? [m.name, classIndex.get(m.cls), m.sub, m.brand, m.batches, m.eans] : [m.name, classIndex.get(m.cls), m.sub, m.brand, m.batches])),
  );

  const meta = {
    generatedAt,
    lists: Object.fromEntries(
      Object.entries(LISTS).map(([key, def]) => {
        const base = { title: def.title, url: BASE_URL + def.path };
        if (!have(key)) return [key, { ...base, onSite: false }];
        const st = stores[key];
        const entry = {
          ...base,
          onSite: true,
          fetchedAt: st.fetchedAt || null,
          rows: st.rows.length,
          latestEffective: latestDate(st.rows, st.headers),
          officialTotal: st.reportedTotal || null,
          topAt: st.topAt || null,
          fullPassAt: st.fullPassAt || null,
        };
        if (key === 'ph') {
          const tokens = st.tokens || {};
          entry.complete = Boolean(st.complete);
          entry.searchesDone = Object.values(tokens).filter((t) => t.done).length;
          entry.searchesLeft = st.slicesDone ? 0 : null;
          entry.resumePage = st.resumePage || 0;
          entry.lastPage = st.lastPage || null;
          entry.textSearches = st.cover ? st.cover.searches : 0;
          entry.textSearchesToGo = st.cover ? (st.cover.doneAt ? 0 : st.cover.stack.length) : null;
        }
        return [key, entry];
      }),
    ),
    counts: {
      groceryRows: groceries.stats.rows,
      groceryRowsSkipped: groceries.stats.noName + groceries.stats.noPrice + groceries.stats.noDate,
      products: groceries.stats.products,
      subsidisedProducts: groceries.stats.subsidisedProducts,
      medicines: medicines.stats.medicines,
      medicineBatches: medicines.stats.batches,
      medicinesWithBarcode: medicines.stats.withBarcode,
    },
  };

  return { groceries: groceriesText, medicines: medicinesText, meta, stats: { groceries: groceries.stats, medicines: medicines.stats } };
}
