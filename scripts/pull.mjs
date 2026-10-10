#!/usr/bin/env node
// Pulls the official price lists into local storage (data/store/) and rebuilds the
// files the page loads. Run it as often as you like; each run picks up where the
// last one stopped.
//
//   node scripts/pull.mjs                 all lists, up to 4 minutes
//   PRI_MINUTES=60 node scripts/pull.mjs  a long run (for the first copy of the medicines list)
//   PRI_LISTS=p,s node scripts/pull.mjs   some lists only
//
// With BLOB_READ_WRITE_TOKEN set, the hosted site's Blob storage is used instead of
// data/store/, which is how a GitHub Action or any other machine can feed the site.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPull } from './lib/pull.mjs';
import { fileStorage, storageFromEnv } from './lib/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storage = storageFromEnv(path.join(ROOT, 'data', 'store'));
const seeds = fileStorage(path.join(ROOT, 'site', 'seed'));
const minutes = Number(process.env.PRI_MINUTES || 4);
const lists = (process.env.PRI_LISTS || 'p,s,phs,ph').split(',').map((s) => s.trim());

runPull({
  storage,
  deadlineAt: Date.now() + minutes * 60 * 1000,
  lists,
  base: process.env.PRI_BASE_URL,
  pauseMs: process.env.PRI_PAUSE_MS ? Number(process.env.PRI_PAUSE_MS) : undefined,
  seed: (key) => seeds.readJson(`${key}.json`),
})
  .then((summary) => {
    console.log(`\nstorage: ${storage.kind}; outputs: data/groceries.json, data/medicines.json, data/meta.json`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = Object.entries(summary.lists).map(([k, v]) => `| ${k} | ${v.rows} | ${v.steps.join('; ')} |`);
      return import('node:fs/promises').then(({ writeFile }) => writeFile(process.env.GITHUB_STEP_SUMMARY, `### Price lists\n\n| List | Rows | Work |\n| --- | --- | --- |\n${rows.join('\n')}\n`, { flag: 'a' }));
    }
    return undefined;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
