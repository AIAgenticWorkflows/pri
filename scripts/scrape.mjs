#!/usr/bin/env node
// Pulls the official maximum retail price lists from the Price Fixing Unit
// website and saves them, unmodified, under data/raw/.
//
//   node scripts/scrape.mjs
//
// Options (environment variables):
//   PRI_LISTS      comma-separated list keys to fetch (default: p,s,phs)
//   PRI_MAX_PAGES  stop after this many pages per list, for a quick test (default: all)
//   PRI_PAUSE_MS   pause between two requests to the same list (default: 400)
//   PRI_TIMEOUT_MS time allowed for one page (default: 180000; the site is slow)
//
// The site is a paged table sorted newest first. Pages are read one after the
// other, in order, so a row added at the top while we are reading can only
// show up twice, never go missing. A short second look at the first pages then
// picks up anything that was added in the meantime.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, LISTS, isoDate, parsePage } from './lib/pfu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const USER_AGENT = 'Mozilla/5.0 (compatible; PriBot/1.0; +https://www.aplica.biz)';

const BASE = process.env.PRI_BASE_URL || BASE_URL;
const TIMEOUT_MS = Number(process.env.PRI_TIMEOUT_MS || 180000);
const PAUSE_MS = Number(process.env.PRI_PAUSE_MS || 400);
const MAX_PAGES = Number(process.env.PRI_MAX_PAGES || 0);
// The full pharmaceutical list (ph, about 57,000 batches) needs over a minute per page on the
// official site, so it is not copied by default; the site searches it live instead.
const DEFAULT_LISTS = 'p,s,phs';
const WANTED = (process.env.PRI_LISTS || DEFAULT_LISTS)
  .split(',')
  .map((s) => s.trim())
  .filter((key) => key in LISTS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function fetchPage(listPath, page, retries = 3) {
  const url = BASE + listPath + (page ? `?page=${page}` : '');
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const html = await res.text();
      const ms = Date.now() - started;
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

async function scrapeList(key) {
  const { path: listPath } = LISTS[key];
  const started = Date.now();
  log(`${key}: starting ${BASE}${listPath}`);

  const first = await fetchPage(listPath, 0);
  const headers = first.headers;
  let lastPage = first.lastPage;
  const totals = new Set([first.total]);
  const pages = [first];

  for (let n = 1; n <= lastPage && (!MAX_PAGES || n < MAX_PAGES); n++) {
    await sleep(PAUSE_MS);
    const page = await fetchPage(listPath, n);
    pages.push(page);
    totals.add(page.total);
    if (page.lastPage > lastPage) lastPage = page.lastPage; // the list grew while we were reading it
    if (n % 10 === 0) log(`${key}: page ${n}/${lastPage} (${page.ms} ms)`);
  }

  const seen = new Set();
  const rows = [];
  let rowsFetched = 0;
  let malformed = 0;
  const add = (row) => {
    if (row.length !== headers.length) {
      malformed++;
      return false;
    }
    const id = JSON.stringify(row);
    if (seen.has(id)) return false;
    seen.add(id);
    rows.push(row);
    return true;
  };
  for (const page of pages) {
    for (const row of page.rows) {
      rowsFetched++;
      add(row);
    }
  }

  // Second look at the top of the list for rows added while we were paging.
  let addedDuringRun = 0;
  if (!MAX_PAGES) {
    for (let n = 0; n <= lastPage; n++) {
      await sleep(PAUSE_MS);
      const page = await fetchPage(listPath, n);
      totals.add(page.total);
      const fresh = page.rows.filter(add).length;
      addedDuringRun += fresh;
      if (!fresh) break;
    }
  }

  // Stable order (newest first, then alphabetical) keeps day-to-day diffs small.
  const dateCol = headers.findIndex((h) => /effective/i.test(h));
  const sortKey = (row) => `${dateCol >= 0 ? isoDate(row[dateCol]) : ''}`;
  rows.sort((a, b) => {
    const da = sortKey(a);
    const db = sortKey(b);
    if (da !== db) return da < db ? 1 : -1;
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const result = {
    list: key,
    source: BASE + listPath,
    fetchedAt: new Date().toISOString(),
    headers,
    reportedTotal: first.total,
    pages: pages.length,
    rowsFetched,
    rowCount: rows.length,
    duplicateRowsDropped: rowsFetched + addedDuringRun - rows.length - malformed,
    malformedRowsDropped: malformed,
    changedDuringRun: totals.size > 1 || addedDuringRun > 0,
    partial: Boolean(MAX_PAGES && pages.length <= lastPage),
    seconds: Math.round((Date.now() - started) / 1000),
    rows,
  };
  log(`${key}: done, ${rows.length} distinct rows from ${pages.length} pages in ${result.seconds} s`);
  return result;
}

// One row per line, so a price change shows up as a one-line diff.
function serialise(result) {
  const { rows, ...head } = result;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${headJson},\n  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const metaFile = path.join(RAW_DIR, 'meta.json');
  const meta = await readJson(metaFile, { lists: {} });
  meta.lists ||= {};

  const run = async (key) => {
    const previous = meta.lists[key] || {};
    try {
      const result = await scrapeList(key);
      if (!result.partial) await writeFile(path.join(RAW_DIR, `${key}.json`), serialise(result));
      else await writeFile(path.join(RAW_DIR, `${key}.partial.json`), serialise(result));
      const { rows, ...summary } = result;
      meta.lists[key] = { ok: true, ...summary, lastSuccess: result.partial ? previous.lastSuccess || null : result.fetchedAt };
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

  // The slow pharmaceutical list runs alongside the others; each list is read in page order.
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

  const lines = ['| List | Result | Rows | Pages | Seconds | Note |', '| --- | --- | --- | --- | --- | --- |'];
  for (const key of WANTED) {
    const m = meta.lists[key];
    lines.push(`| ${key} | ${m.ok ? 'ok' : 'FAILED'} | ${m.ok ? m.rowCount : ''} | ${m.ok ? m.pages : ''} | ${m.ok ? m.seconds : ''} | ${m.ok ? (m.partial ? 'partial test run' : m.changedDuringRun ? 'list changed during the run' : '') : m.error} |`);
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
