#!/usr/bin/env node
// Pulls the official maximum retail price lists from the Price Fixing Unit
// website and saves them, unmodified, under data/raw/ and site/data/.
//
//   node scripts/scrape.mjs
//
// Options (environment variables):
//   PRI_LISTS        comma-separated list keys to fetch (default: p,s,phs)
//   PRI_PASSES       full read-throughs per list, e.g. "p=2,s=2,phs=1" (the default)
//   PRI_KEEP_BUILDS  a row last seen this many builds ago is dropped (default: 3)
//   PRI_MAX_PAGES    stop after this many pages per list, for a quick test (default: all)
//   PRI_BUDGET_MS    stop reading after this long and keep what was collected (default: 36 min)
//   PRI_PAUSE_MS     pause between two requests to the same list (default: 400)
//   PRI_TIMEOUT_MS   time allowed for one page (default: 180000; the site is slow)
//   PRI_PREVIOUS_URL where the previous copy is published (default: the production site)
//
// Why several passes and a memory of previous builds: the site is a paged table
// sorted by date, newest first, and rows that share a date come back in an order
// that changes from one request to the next. A single read-through can therefore
// show a row twice and miss another. Reading the list twice, then keeping any row
// seen in one of the last few builds, closes those gaps; a row that really left
// the official list disappears from here after PRI_KEEP_BUILDS builds.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, LISTS, isoDate, parsePage } from './lib/pfu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const STORE_DIR = path.join(ROOT, 'site', 'data');
const USER_AGENT = 'Mozilla/5.0 (compatible; PriBot/1.0; +https://www.aplica.biz)';

const BASE = process.env.PRI_BASE_URL || BASE_URL;
const TIMEOUT_MS = Number(process.env.PRI_TIMEOUT_MS || 180000);
const PAUSE_MS = Number(process.env.PRI_PAUSE_MS || 400);
const MAX_PAGES = Number(process.env.PRI_MAX_PAGES || 0);
const BUDGET_MS = Number(process.env.PRI_BUDGET_MS || 36 * 60 * 1000);
const KEEP_BUILDS = Math.max(1, Number(process.env.PRI_KEEP_BUILDS || 3));
const PREVIOUS_URL = process.env.PRI_PREVIOUS_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/data` : '');
// The full pharmaceutical list (ph, about 57,000 batches) needs over a minute per page on the
// official site; scripts/pharma.mjs copies it bit by bit, so it is not read here by default.
const DEFAULT_LISTS = 'p,s,phs';
const WANTED = (process.env.PRI_LISTS || DEFAULT_LISTS)
  .split(',')
  .map((s) => s.trim())
  .filter((key) => key in LISTS);
const PASSES = Object.fromEntries(
  `p=2,s=2,phs=1,ph=1,${process.env.PRI_PASSES || ''}`
    .split(',')
    .map((part) => part.split('='))
    .filter(([key, n]) => key && Number(n) > 0)
    .map(([key, n]) => [key.trim(), Number(n)]),
);

const started = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const outOfTime = () => Date.now() - started > BUDGET_MS;

async function fetchPage(listPath, page, retries = 3) {
  const url = BASE + listPath + (page ? `?page=${page}` : '');
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const html = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) {
        const snippet = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        throw new Error(`HTTP ${res.status} after ${ms} ms${snippet ? `: ${snippet}` : ''}`);
      }
      const parsed = parsePage(html);
      if (!parsed.hasTable) throw new Error(`no results table in the response (${html.length} bytes, ${ms} ms)`);
      return { ...parsed, page, ms };
    } catch (err) {
      lastError = err;
      log(`  ${listPath} page ${page}: attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) await sleep(4000 * attempt);
    }
  }
  throw lastError;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// The copy from the last build: published by the live site, or saved in the repository.
async function loadPrevious(key) {
  const candidates = [];
  if (PREVIOUS_URL) {
    try {
      const res = await fetch(`${PREVIOUS_URL}/${key}-store.json`, { signal: AbortSignal.timeout(60000), headers: { 'cache-control': 'no-cache' } });
      if (res.ok) candidates.push({ ...(await res.json()), from: 'the live site' });
    } catch {
      // first build, or the site is unreachable: start from the repository copy
    }
  }
  const local = await readJson(path.join(RAW_DIR, `${key}.json`));
  if (local) candidates.push({ ...local, from: 'the repository' });
  const usable = candidates.filter((c) => Array.isArray(c.rows) && Array.isArray(c.headers));
  usable.sort((a, b) => (b.build || 0) - (a.build || 0) || b.rows.length - a.rows.length);
  return usable[0] || null;
}

async function scrapeList(key) {
  const { path: listPath } = LISTS[key];
  const t0 = Date.now();
  const previous = await loadPrevious(key);
  const build = ((previous && previous.build) || 0) + 1;
  log(`${key}: build ${build}, ${previous ? `${previous.rows.length} rows carried from ${previous.from}` : 'no previous copy'}`);

  const rows = new Map(); // row id -> { row, seen: build number the row was last read in }
  let headers = previous ? previous.headers : null;
  if (previous) {
    previous.rows.forEach((row, i) => {
      const seen = Array.isArray(previous.seen) && Number.isInteger(previous.seen[i]) ? previous.seen[i] : build - 1;
      rows.set(JSON.stringify(row), { row, seen });
    });
  }

  let malformed = 0;
  let fetched = 0;
  const add = (row) => {
    fetched++;
    if (headers && row.length !== headers.length) {
      malformed++;
      return false;
    }
    const id = JSON.stringify(row);
    const known = rows.get(id);
    if (known) {
      const fresh = known.seen < build;
      known.seen = build;
      return fresh;
    }
    rows.set(id, { row, seen: build });
    return true;
  };

  const totals = new Set();
  let reportedTotal = null;
  let lastPage = 0;
  let completePasses = 0;
  let pagesRead = 0;
  let stoppedEarly = false;
  const passes = MAX_PAGES ? 1 : PASSES[key] || 1;

  for (let pass = 1; pass <= passes && !stoppedEarly; pass++) {
    let n = 0;
    let last = Infinity;
    const foundBefore = fetched;
    for (; n <= last; n++) {
      if (outOfTime() || (MAX_PAGES && n >= MAX_PAGES)) {
        stoppedEarly = true;
        break;
      }
      if (n) await sleep(PAUSE_MS);
      const page = await fetchPage(listPath, n);
      pagesRead++;
      if (!headers) headers = page.headers;
      if (page.headers.length !== headers.length) throw new Error(`the table changed shape on page ${n}: ${page.headers.join(' | ')}`);
      totals.add(page.total);
      if (reportedTotal === null) reportedTotal = page.total;
      last = Math.max(page.lastPage, n);
      lastPage = Math.max(lastPage, last);
      for (const row of page.rows) add(row);
      if (n % 10 === 0 && n) log(`${key}: pass ${pass}, page ${n}/${last} (${page.ms} ms)`);
    }
    if (!stoppedEarly || (MAX_PAGES && n >= MAX_PAGES && n > last)) completePasses++;
    log(`${key}: pass ${pass} ${stoppedEarly ? 'stopped early' : 'done'}, ${fetched - foundBefore} rows read, ${rows.size} rows in total`);
  }

  // A second look at the top of the list for rows added while we were reading.
  let addedDuringRun = 0;
  if (!MAX_PAGES && !stoppedEarly) {
    for (let n = 0; n <= lastPage; n++) {
      await sleep(PAUSE_MS);
      const page = await fetchPage(listPath, n);
      pagesRead++;
      totals.add(page.total);
      const fresh = page.rows.filter(add).length;
      addedDuringRun += fresh;
      if (!fresh) break;
    }
  }

  // Rows not seen for a while have left the official list. Only prune after a complete
  // pass, otherwise rows we simply did not get to would be lost.
  let dropped = 0;
  if (completePasses > 0 && !MAX_PAGES) {
    for (const [id, entry] of rows) {
      if (entry.seen <= build - KEEP_BUILDS) {
        rows.delete(id);
        dropped++;
      }
    }
  }
  const carried = [...rows.values()].filter((entry) => entry.seen < build).length;

  // Stable order (newest first, then alphabetical) keeps day-to-day diffs small.
  const dateCol = headers.findIndex((h) => /effective/i.test(h));
  const entries = [...rows.values()].sort((a, b) => {
    const da = dateCol >= 0 ? isoDate(a.row[dateCol]) : '';
    const db = dateCol >= 0 ? isoDate(b.row[dateCol]) : '';
    if (da !== db) return da < db ? 1 : -1;
    const sa = JSON.stringify(a.row);
    const sb = JSON.stringify(b.row);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const result = {
    list: key,
    source: BASE + listPath,
    fetchedAt: new Date().toISOString(),
    build,
    headers,
    reportedTotal,
    lastPage,
    passes: completePasses,
    pagesRead,
    rowsFetched: fetched,
    rowCount: entries.length,
    rowsSeenThisBuild: entries.length - carried,
    rowsCarried: carried,
    rowsDropped: dropped,
    malformedRowsDropped: malformed,
    changedDuringRun: totals.size > 1 || addedDuringRun > 0,
    partial: Boolean(MAX_PAGES) || stoppedEarly,
    seconds: Math.round((Date.now() - t0) / 1000),
    seen: entries.map((entry) => entry.seen),
    rows: entries.map((entry) => entry.row),
  };
  log(`${key}: ${result.rowCount} rows (${result.rowsSeenThisBuild} read now, ${carried} carried, ${dropped} dropped) in ${result.seconds} s`);
  return result;
}

// One row per line, so a price change shows up as a one-line diff.
function serialise(result) {
  const { rows, seen, ...head } = result;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${headJson},\n  "seen": ${JSON.stringify(seen)},\n  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(STORE_DIR, { recursive: true });
  const metaFile = path.join(RAW_DIR, 'meta.json');
  const meta = (await readJson(metaFile)) || { lists: {} };
  meta.lists ||= {};

  const run = async (key) => {
    const previous = meta.lists[key] || {};
    try {
      const result = await scrapeList(key);
      const text = serialise(result);
      if (MAX_PAGES) {
        await writeFile(path.join(RAW_DIR, `${key}.partial.json`), text);
      } else {
        await writeFile(path.join(RAW_DIR, `${key}.json`), text);
        await writeFile(path.join(STORE_DIR, `${key}-store.json`), text);
      }
      const { rows, seen, ...summary } = result;
      meta.lists[key] = { ok: true, ...summary, lastSuccess: MAX_PAGES ? previous.lastSuccess || null : result.fetchedAt };
      return true;
    } catch (err) {
      log(`${key}: FAILED: ${err.message}`);
      meta.lists[key] = {
        ...previous,
        ok: false,
        list: key,
        source: BASE + LISTS[key].path,
        error: String(err.message || err).slice(0, 300),
        failedAt: new Date().toISOString(),
        lastSuccess: previous.lastSuccess || null,
      };
      return false;
    }
  };

  // The slow subsidised medicines list runs alongside the others; each list is read in page order.
  const chain = async (keys) => {
    const results = [];
    for (const key of keys) results.push(await run(key));
    return results;
  };
  const slow = WANTED.filter((key) => key === 'phs');
  const rest = WANTED.filter((key) => key !== 'phs');
  const outcomes = (await Promise.all([chain(rest), chain(slow)])).flat();

  meta.updatedAt = new Date().toISOString();
  await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

  const lines = ['| List | Result | Rows | Read now | Carried | Official total | Passes | Seconds | Note |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const key of WANTED) {
    const m = meta.lists[key];
    lines.push(
      m.ok
        ? `| ${key} | ok | ${m.rowCount} | ${m.rowsSeenThisBuild} | ${m.rowsCarried} | ${m.reportedTotal} | ${m.passes} | ${m.seconds} | ${m.partial ? 'stopped early' : m.changedDuringRun ? 'list changed during the run' : ''} |`
        : `| ${key} | FAILED | | | | | | | ${m.error} |`,
    );
  }
  console.log(`\n${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Price lists\n\n${lines.join('\n')}\n`, { flag: 'a' });

  if (!outcomes.some(Boolean)) {
    console.error('Every list failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
