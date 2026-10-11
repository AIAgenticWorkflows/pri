#!/usr/bin/env node
// Checks that this machine can reach the site's Blob storage, and shows what is in
// it. Run it before a long pull, and any time to see how far the copy has got.
//
//   npm run check
//
// BLOB_READ_WRITE_TOKEN is read from the terminal or from .env.local in the project
// folder. The token itself is never printed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanToken, loadEnv } from './lib/env.mjs';
import { blobStorage } from './lib/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaded = loadEnv(ROOT);

const say = (...lines) => console.log(lines.join('\n'));
const fail = (...lines) => {
  say(...lines);
  process.exit(1);
};

const HOW_TO_COPY = [
  'How to get the token:',
  '  1. In Vercel open the pri project, then Storage, then the Blob store connected to it.',
  '     (If there is no store yet: Create Database, Blob, and connect it to the project.)',
  '  2. Open the ".env.local" tab of the store and press "Copy Snippet".',
  '  3. Paste it into a file named .env.local in the project folder (next to package.json).',
  '     The file is ignored by git, so the token never gets committed.',
  '  4. Run "npm run check" again.',
];

say(loaded.length ? `read ${loaded.join(' and ')}` : 'no .env.local file in the project folder');

const raw = process.env.BLOB_READ_WRITE_TOKEN;
if (!raw) fail('BLOB_READ_WRITE_TOKEN is not set.', '', ...HOW_TO_COPY);

const token = cleanToken(raw);
if (token !== raw) say('note: quotes or spaces around the token were ignored');

if (!token.startsWith('vercel_blob_rw_')) {
  fail(
    `This is not a Blob read-write token: it starts with ${JSON.stringify(token.slice(0, 8))} and is ${token.length} characters long.`,
    'A Blob token starts with vercel_blob_rw_ and is about 70 characters long.',
    'Account tokens (Vercel settings, Tokens) and project IDs are different things and will not work.',
    '',
    ...HOW_TO_COPY,
  );
}
const storeId = token.split('_')[3] || '?';
if (token.length < 50) {
  fail(
    `The token is only ${token.length} characters long, so it is probably cut short (a masked field shows only part of it).`,
    '',
    ...HOW_TO_COPY,
  );
}
say(`token: looks right (Blob store ${storeId}, ${token.length} characters)`);

let blob;
try {
  blob = await import('@vercel/blob');
} catch {
  fail('The @vercel/blob package is not installed: run "npm install" in the project folder first.');
}

let blobs;
try {
  ({ blobs } = await blob.list({ token, limit: 100 }));
} catch (err) {
  fail(
    `Vercel refused the token: ${err.message}`,
    'So the value is wrong even though it has the right shape: it may be cut short, copied from a',
    'masked field, from a store that was deleted, or from another Vercel account.',
    '',
    ...HOW_TO_COPY,
  );
}

say(`storage: reachable, ${blobs.length} file${blobs.length === 1 ? '' : 's'} in the store`);
if (!blobs.length) {
  say('', 'The store is empty. Start the first copy with:', '  npm run pull            (4 minutes, to try it)', '  PRI_MINUTES=720 npm run pull   (a long run, for the first full copy)');
  process.exit(0);
}

const kb = (n) => `${Math.round(n / 1024).toLocaleString('en-GB')} kB`;
for (const b of blobs.sort((a, c) => a.pathname.localeCompare(c.pathname))) {
  say(`  ${b.pathname.padEnd(24)} ${kb(b.size).padStart(10)}   ${new Date(b.uploadedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
}

const storage = blobStorage(token);
const state = await storage.readJson('state.json');
const meta = await storage.readJson('data/meta.json');
const ago = (iso) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
};

say('');
if (state) {
  if (state.lock) say(`a pull is running now (started ${ago(state.lock.at)} by ${state.lock.by})`);
  if (state.lastRun) say(`last run: ${ago(state.lastRun.at)} (${state.lastRun.seconds} s); ${state.runs || 0} runs so far`);
  if (state.lastError) say(`last error: ${ago(state.lastError.at)}: ${state.lastError.message}`);
}
if (meta && meta.lists) {
  say('lists:');
  for (const [key, l] of Object.entries(meta.lists)) {
    if (!l.onSite) {
      say(`  ${key.padEnd(4)} nothing yet`);
      continue;
    }
    const bits = [`${l.rows.toLocaleString('en-GB')} rows`];
    if (l.officialTotal) bits.push(`site says ${l.officialTotal.toLocaleString('en-GB')}`);
    bits.push(`newest read ${ago(l.topAt)}`);
    bits.push(`full read ${ago(l.fullPassAt)}`);
    if (key === 'ph') {
      if (l.searchesLeft === 0) bits.push(`${l.searchesDone} searches done`);
      else bits.push(`${l.searchesDone} searches so far`);
      if (l.textSearches) bits.push(`${l.textSearches} text searches${l.textSearchesToGo ? `, ${l.textSearchesToGo} queued` : ''}`);
      if (l.complete) bits.push('complete');
    }
    say(`  ${key.padEnd(4)} ${bits.join('; ')}`);
  }
  if (meta.counts) {
    say(`site: ${meta.counts.products.toLocaleString('en-GB')} products (${meta.counts.subsidisedProducts.toLocaleString('en-GB')} subsidised), ${meta.counts.medicines.toLocaleString('en-GB')} medicines, ${meta.counts.medicineBatches.toLocaleString('en-GB')} batches${meta.counts.medicinesWithBarcode !== undefined ? `, ${meta.counts.medicinesWithBarcode.toLocaleString('en-GB')} medicines with a barcode` : ''}`);
  }
}
