#!/usr/bin/env node
// Pulls the official price lists into local storage (data/store/) and rebuilds the
// files the page loads. Run it as often as you like; each run picks up where the
// last one stopped.
//
//   node scripts/pull.mjs                  all lists, up to 4 minutes
//   PRI_MINUTES=720 node scripts/pull.mjs  a long run, e.g. overnight for the first full copy
//   PRI_LISTS=p,s node scripts/pull.mjs    some lists only
//
// Progress is saved every couple of minutes; if the run is stopped, the next one
// carries on from there.
//
// With BLOB_READ_WRITE_TOKEN set (in the terminal or in a .env.local file in the
// project folder), the hosted site's Blob storage is used instead of data/store/,
// which is how any machine can feed the site. "npm run check" tests the token.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { runPull } from './lib/pull.mjs';
import { blobStorage, fileStorage, storageFromEnv } from './lib/storage.mjs';
import { cleanToken } from './lib/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);
const storage = storageFromEnv(path.join(ROOT, 'data', 'store'));
const seeds = fileStorage(path.join(ROOT, 'site', 'seed'));
const minutes = Number(process.env.PRI_MINUTES || 4);
const lists = (process.env.PRI_LISTS || 'p,s,phs,ph').split(',').map((s) => s.trim());

// Ctrl+C: let go of the lock so the next run can start at once. Progress is already saved.
let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nstopping: releasing the lock (press Ctrl+C again to quit at once)');
  try {
    const state = await storage.readJson('state.json');
    if (state && state.lock && state.lock.by === 'command line') {
      state.lock = null;
      await storage.writeText('state.json', `${JSON.stringify(state, null, 2)}\n`);
    }
  } catch (err) {
    console.error(`could not release the lock: ${err.message}`);
  }
  process.exit(130);
});

runPull({
  storage,
  deadlineAt: Date.now() + minutes * 60 * 1000,
  lists,
  base: process.env.PRI_BASE_URL,
  pauseMs: process.env.PRI_PAUSE_MS ? Number(process.env.PRI_PAUSE_MS) : undefined,
  seed: async (key) => {
    // Moving to Supabase: carry over what the old Blob store already holds, if it can
    // still be read; otherwise start from the copies in the repository.
    if (storage.kind !== 'blob' && cleanToken(process.env.BLOB_READ_WRITE_TOKEN)) {
      try {
        const old = await blobStorage().readJson(`stores/${key}.json`);
        if (old && Array.isArray(old.rows) && old.rows.length) {
          console.log(`${key}: carried over ${old.rows.length} rows from the old Blob store`);
          return old;
        }
      } catch (err) {
        console.log(`${key}: the old Blob store could not be read (${String(err.message).slice(0, 80)})`);
      }
    }
    return seeds.readJson(`${key}.json`);
  },
  by: 'command line',
  force: process.env.PRI_FORCE === '1',
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
