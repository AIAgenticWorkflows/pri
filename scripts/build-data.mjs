#!/usr/bin/env node
// Builds the fallback copy of the page's data (site/seed-data/) from the stores
// committed in site/seed/. Fast: no network. The hosted site serves fresher files
// from Blob storage once the data pull (scripts/lib/pull.mjs) has run.
//
//   node scripts/build-data.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutputs } from './lib/outputs.mjs';
import { LISTS } from './lib/pfu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = path.join(ROOT, 'site', 'seed');
const OUT_DIR = path.join(ROOT, 'site', 'seed-data');

async function readStore(key) {
  try {
    return JSON.parse(await readFile(path.join(SEED_DIR, `${key}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const stores = {};
  for (const key of Object.keys(LISTS)) stores[key] = await readStore(key);
  const out = buildOutputs(stores);
  await writeFile(path.join(OUT_DIR, 'groceries.json'), out.groceries);
  await writeFile(path.join(OUT_DIR, 'medicines.json'), out.medicines);
  await writeFile(path.join(OUT_DIR, 'meta.json'), `${JSON.stringify(out.meta, null, 2)}\n`);
  console.log('groceries:', JSON.stringify(out.stats.groceries));
  console.log('medicines:', JSON.stringify(out.stats.medicines));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
