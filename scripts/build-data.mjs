#!/usr/bin/env node
// Builds the compact files the page loads (site/data/) from the raw lists (data/raw/).
//
//   node scripts/build-data.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTS, BASE_URL } from './lib/pfu.mjs';
import { CATEGORY_IDS, MEDICINE_CLASSES, buildGroceries, buildMedicines } from './lib/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const OUT_DIR = path.join(ROOT, 'site', 'data');

async function readRaw(key) {
  try {
    return JSON.parse(await readFile(path.join(RAW_DIR, `${key}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// One item per line keeps the files diff-friendly and still compact.
const lines = (head, key, items) =>
  `${JSON.stringify(head).replace(/}$/, '')},"${key}":[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]}\n`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const raw = {};
  for (const key of Object.keys(LISTS)) raw[key] = await readRaw(key);
  const generatedAt = new Date().toISOString();

  // Groceries and household goods: lists p (regular) and s (subsidised).
  const groceryLists = ['p', 's'].filter((key) => raw[key]).map((key) => ({ list: key, headers: raw[key].headers, rows: raw[key].rows }));
  const groceries = buildGroceries(groceryLists);
  const catIndex = new Map(CATEGORY_IDS.map((id, i) => [id, i]));
  await writeFile(
    path.join(OUT_DIR, 'groceries.json'),
    lines(
      { v: 1, generatedAt, cats: CATEGORY_IDS, types: groceries.types },
      'items',
      groceries.items.map((p) => [p.name, p.brand, p.ean, catIndex.get(p.cat), p.history]),
    ),
  );

  // Medicines kept on the site: the subsidised list (and the full list if it has been pulled).
  const medicineLists = ['phs', 'ph'].filter((key) => raw[key]).map((key) => ({ list: key, headers: raw[key].headers, rows: raw[key].rows }));
  const medicines = buildMedicines(medicineLists);
  const classIndex = new Map(MEDICINE_CLASSES.map((id, i) => [id, i]));
  await writeFile(
    path.join(OUT_DIR, 'medicines.json'),
    lines(
      { v: 1, generatedAt, classes: MEDICINE_CLASSES },
      'items',
      medicines.items.map((m) => [m.name, classIndex.get(m.cls), m.sub, m.brand, m.batches]),
    ),
  );

  const latest = (rows, headers) => {
    const col = headers.findIndex((h) => /effective/i.test(h));
    let best = '';
    for (const row of rows) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row[col] || '');
      if (m && `${m[3]}-${m[2]}-${m[1]}` > best) best = `${m[3]}-${m[2]}-${m[1]}`;
    }
    return best;
  };
  const meta = {
    generatedAt,
    lists: Object.fromEntries(
      Object.entries(LISTS).map(([key, def]) => [
        key,
        raw[key]
          ? {
              title: def.title,
              url: BASE_URL + def.path,
              onSite: true,
              fetchedAt: raw[key].fetchedAt,
              rows: raw[key].rows.length,
              latestEffective: latest(raw[key].rows, raw[key].headers),
              ...(key === 'ph' ? { complete: Boolean(raw.ph.complete), officialTotal: raw.ph.reportedTotal || null } : {}),
            }
          : { title: def.title, url: BASE_URL + def.path, onSite: false },
      ]),
    ),
    counts: {
      products: groceries.stats.products,
      subsidisedProducts: groceries.stats.subsidisedProducts,
      medicines: medicines.stats.medicines,
      medicineBatches: medicines.stats.batches,
    },
  };
  await writeFile(path.join(OUT_DIR, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  console.log('groceries:', JSON.stringify(groceries.stats));
  console.log('medicines:', JSON.stringify(medicines.stats));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
