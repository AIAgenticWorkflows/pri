#!/usr/bin/env node
// Keeps a full copy of the official pharmaceutical price list (about 57,000 batches).
//
// The government site needs over a minute to serve each of its ~570 pages, far more
// than one build can wait for, so the copy is built up over several builds:
//   1. Start from the copy the live site already publishes (site/data/ph-store.json
//      on the production URL), or from data/raw/ph.json if there is one.
//   2. Read the newest pages until a page brings nothing new (the list is newest first).
//   3. With the time left, carry on reading older pages from where the last build stopped.
// Once every page has been read, only step 2 runs, so a daily build stays short.
//
// The build never fails because of this script: on any error it keeps the previous copy.
//
// Environment:
//   PRI_PH_BUDGET_MS   time allowed for reading pages (default 25 minutes)
//   PRI_PH_MAX_PAGES   stop after this many page reads (tests)
//   PRI_PH_CONCURRENCY pages read at the same time (default 3)
//   PRI_PREVIOUS_URL   where to find the previous copy (default: the production site)
//   PRI_PREVIOUS_FILE  a local previous copy instead (tests)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, LISTS, isoDate, parsePage } from './lib/pfu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_FILE = path.join(ROOT, 'data', 'raw', 'ph.json');
const STORE_FILE = path.join(ROOT, 'site', 'data', 'ph-store.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; PriBot/1.0; +https://www.aplica.biz)';

const BASE = process.env.PRI_BASE_URL || BASE_URL;
const LIST_PATH = LISTS.ph.path;
const BUDGET_MS = Number(process.env.PRI_PH_BUDGET_MS || 25 * 60 * 1000);
const MAX_READS = Number(process.env.PRI_PH_MAX_PAGES || 0);
const CONCURRENCY = Math.max(1, Number(process.env.PRI_PH_CONCURRENCY || 3));
const PAGE_TIMEOUT_MS = Number(process.env.PRI_TIMEOUT_MS || 240000);
const TOP_PAGES_MAX = 15;

const started = Date.now();
let reads = 0;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), 'ph:', ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeLeft = () => BUDGET_MS - (Date.now() - started);
const mayRead = () => (!MAX_READS || reads < MAX_READS) && timeLeft() > 0;

async function fetchPage(page) {
  reads++;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(BASE + LIST_PATH + (page ? `?page=${page}` : ''), {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parsePage(await res.text());
      if (!parsed.hasTable) throw new Error('no results table');
      return parsed;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(5000);
    }
  }
  throw new Error(`page ${page}: ${lastError.message}`);
}

async function loadPrevious() {
  const sources = [];
  if (process.env.PRI_PREVIOUS_FILE) sources.push(['file', process.env.PRI_PREVIOUS_FILE]);
  sources.push(['file', RAW_FILE]);
  const site = process.env.PRI_PREVIOUS_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/data/ph-store.json` : '');
  if (site) sources.push(['url', site]);
  let best = null;
  for (const [kind, where] of sources) {
    try {
      const text = kind === 'file'
        ? await readFile(where, 'utf8')
        : await (await fetch(where, { signal: AbortSignal.timeout(60000), headers: { 'cache-control': 'no-cache' } })).text();
      const data = JSON.parse(text);
      if (Array.isArray(data.rows) && (!best || data.rows.length > best.rows.length)) best = { ...data, from: where };
    } catch {
      // not there yet: the first build starts from nothing
    }
  }
  return best;
}

function serialise(result) {
  const { rows, ...head } = result;
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, '')},\n  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const previous = await loadPrevious();
  const rows = previous ? previous.rows.slice() : [];
  const seen = new Set(rows.map((row) => JSON.stringify(row)));
  let nextPage = previous && Number.isInteger(previous.nextPage) ? previous.nextPage : 1;
  let complete = Boolean(previous && previous.complete);
  log(previous ? `starting from ${rows.length} rows (${previous.from}), next older page ${nextPage}, complete ${complete}` : 'starting from nothing');

  let headers = previous && previous.headers;
  const add = (pageRows) => {
    let fresh = 0;
    for (const row of pageRows) {
      if (headers && row.length !== headers.length) continue;
      const id = JSON.stringify(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      fresh++;
    }
    return fresh;
  };

  let total = previous && previous.reportedTotal;
  let lastPage = previous && previous.lastPage;
  let newAtTop = 0;
  let olderRead = 0;
  try {
    // 1. Newest rows.
    const first = await fetchPage(0);
    headers = first.headers;
    total = first.total;
    lastPage = first.lastPage;
    newAtTop += add(first.rows);
    for (let n = 1; n < TOP_PAGES_MAX && previous && mayRead(); n++) {
      const page = await fetchPage(n);
      const fresh = add(page.rows);
      newAtTop += fresh;
      if (!fresh) break;
    }
    log(`${newAtTop} new rows at the top (${total} on the official list)`);

    // 2. Older pages, carrying on from the last build. New rows at the top push every
    // older row down, so step back by that many pages, plus one page of overlap.
    if (!complete) {
      let page = Math.max(1, nextPage + Math.floor(newAtTop / 100) - 1);
      let done = page;
      while (page <= lastPage && mayRead()) {
        const batch = [];
        while (batch.length < CONCURRENCY && page <= lastPage && (!MAX_READS || reads + batch.length < MAX_READS)) batch.push(page++);
        const results = await Promise.all(batch.map((n) => fetchPage(n).then((p) => [n, p], (err) => [n, err])));
        let failed = false;
        for (const [n, result] of results) {
          if (result instanceof Error) {
            log(result.message);
            failed = true;
            break;
          }
          add(result.rows);
          olderRead++;
          done = n + 1;
        }
        if (failed) break;
        if (olderRead % 30 < CONCURRENCY) log(`older pages read up to ${done - 1} of ${lastPage}, ${rows.length} rows`);
      }
      nextPage = done;
      if (nextPage > lastPage) complete = true;
    }
  } catch (err) {
    log(`stopped early, keeping what was collected: ${err.message}`);
  }

  if (!rows.length || !headers) {
    log('nothing collected and no previous copy; the site will search this list live only');
    return;
  }

  const dateCol = headers.findIndex((h) => /effective/i.test(h));
  rows.sort((a, b) => {
    const da = isoDate(a[dateCol]);
    const db = isoDate(b[dateCol]);
    if (da !== db) return da < db ? 1 : -1;
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const result = {
    list: 'ph',
    source: BASE + LIST_PATH,
    fetchedAt: new Date().toISOString(),
    headers,
    reportedTotal: total || null,
    lastPage: lastPage || null,
    rowCount: rows.length,
    nextPage,
    complete,
    partial: !complete,
    newAtTop,
    olderPagesRead: olderRead,
    seconds: Math.round((Date.now() - started) / 1000),
    rows,
  };
  const text = serialise(result);
  await mkdir(path.dirname(RAW_FILE), { recursive: true });
  await mkdir(path.dirname(STORE_FILE), { recursive: true });
  await writeFile(RAW_FILE, text);
  await writeFile(STORE_FILE, text);
  log(`saved ${rows.length} rows; ${complete ? 'full list collected' : `older pages left from page ${nextPage} of ${lastPage}`}; ${result.seconds} s`);
}

main().catch((err) => {
  // Never fail the build over this list.
  console.error('ph:', err);
});
