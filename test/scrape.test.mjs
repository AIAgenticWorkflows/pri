import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeEntities, isoDate, parsePage } from '../scripts/lib/pfu.mjs';
import { HEADERS, renderPage, startMock } from './mock-pfu.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A row copied from the live site on 8 October 2026.
const REAL_ROW =
  '<tr role="row" class="odd views-row-first"> <td class="views-field views-field-php"> 09/10/2026 </td> <td class="views-field views-field-field-brand-name-ap"> PRIX MINI </td> <td class="views-field views-field-field-commodity-name"> Tomates entières pelées PRIX MINI boîte 44 476g </td> <td class="views-field views-field-field-commodity-type"> Canned Vegetables (Beans, Mushroom, Potatoes, Peas, Tomatoes, Vegetables) </td> <td class="views-field views-field-field-ean-code-ap"> 3660992012022 </td> <td class="views-field views-field-field-mrp-m"> 68.17 </td> <td class="views-field views-field-field-mrp-r"> 78.48 </td> </tr>';

const makeRows = (n, prefix = 'ITEM') =>
  Array.from({ length: n }, (_, i) => ['01/10/2026', 'BRAND', `${prefix} ${String(i).padStart(4, '0')}`, 'Basmati rice', String(3250390000000 + i), '10.00', '11.00']);

test('parsePage reads a row exactly as the site shows it', () => {
  const html = `<div class="view-header"> M is for Mauritius and R is for RodriguesDisplaying 1 - 100 of 4712 </div>
    <table class="table dataTable views-table cols-7"><thead><tr>${HEADERS.map((h) => `<th role="row"> ${h} </th>`).join('')}</tr></thead><tbody>${REAL_ROW}</tbody></table>
    <ul class="pagination"><li><a href="/max-retail-prices-p?field_ean_code_ap_value=&amp;page=1">2</a></li><li><a href="/max-retail-prices-p?field_ean_code_ap_value=&amp;page=47">last »</a></li></ul>`;
  const page = parsePage(html);
  assert.equal(page.hasTable, true);
  assert.deepEqual(page.headers, HEADERS);
  assert.deepEqual(page.rows, [
    ['09/10/2026', 'PRIX MINI', 'Tomates entières pelées PRIX MINI boîte 44 476g', 'Canned Vegetables (Beans, Mushroom, Potatoes, Peas, Tomatoes, Vegetables)', '3660992012022', '68.17', '78.48'],
  ]);
  assert.equal(page.total, 4712);
  assert.equal(page.lastPage, 47);
});

test('parsePage keeps empty cells, decodes entities and reports a missing table', () => {
  const rows = [['02/10/2026', 'Kwality & Co', "L'Huile <1L>", '', '', '0.00', '45.50']];
  const page = parsePage(renderPage('/max-retail-prices-p', rows, 0));
  assert.deepEqual(page.rows, rows);
  assert.equal(page.lastPage, 0);
  assert.equal(parsePage('<html><body>The website encountered an unexpected error.</body></html>').hasTable, false);
  assert.equal(decodeEntities('A &amp; B &#233; &#x41; &unknown;'), 'A & B é A &unknown;');
  assert.equal(isoDate('09/10/2026'), '2026-10-09');
  assert.equal(isoDate(''), '');
});

async function scrapeInto(mockUrl, env = {}) {
  // Run the scraper from a throwaway copy so the real data folder is not touched.
  const dir = await mkdtemp(path.join(tmpdir(), 'pri-test-'));
  await cp(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  const result = await run('node', [path.join(dir, 'scripts', 'scrape.mjs')], {
    env: { ...process.env, PRI_BASE_URL: mockUrl, PRI_PAUSE_MS: '0', PRI_TIMEOUT_MS: '5000', ...env },
  }).catch((err) => err);
  const read = async (name) => JSON.parse(await readFile(path.join(dir, 'data', 'raw', name), 'utf8'));
  return { result, read };
}

test('scraper reads every page, drops exact duplicates and survives a broken list', async () => {
  const rows = makeRows(250);
  rows.splice(120, 0, rows[119]); // the site does contain exact duplicate rows
  const mock = await startMock({ '/max-retail-prices-p': rows, '/max-retail-prices-s': makeRows(30, 'SUB'), '/max-retail-prices-pharmaceutical': 'error', '/subsidised-mrp-pharmaceutical': makeRows(101, 'MED') });
  try {
    const { result, read } = await scrapeInto(mock.url, { PRI_TIMEOUT_MS: '3000' });
    assert.equal(result.code, undefined, result.stderr);
    const p = await read('p.json');
    assert.equal(p.reportedTotal, 251);
    assert.equal(p.pages, 3);
    assert.equal(p.rowCount, 250);
    assert.equal(p.duplicateRowsDropped, 1);
    assert.equal(p.changedDuringRun, false);
    assert.deepEqual(p.headers, HEADERS);
    assert.equal(new Set(p.rows.map((r) => r[2])).size, 250);
    assert.equal((await read('s.json')).rowCount, 30);
    assert.equal((await read('phs.json')).rowCount, 101);
    const meta = await read('meta.json');
    assert.equal(meta.lists.p.ok, true);
    assert.equal(meta.lists.ph.ok, false);
    assert.match(meta.lists.ph.error, /HTTP 500/);
    await assert.rejects(read('ph.json'));
  } finally {
    mock.server.close();
  }
});

test('rows added at the top while the scraper is running are not lost', async () => {
  const lists = { '/max-retail-prices-p': makeRows(250) };
  // After the second page has been served, three new rows appear at the top.
  const mock = await startMock(lists, (pathname, page, count) => {
    if (count === 3) lists[pathname] = [...makeRows(3, 'NEW'), ...lists[pathname]];
  });
  try {
    const { result, read } = await scrapeInto(mock.url, { PRI_LISTS: 'p' });
    assert.equal(result.code, undefined, result.stderr);
    const p = await read('p.json');
    assert.equal(p.rowCount, 253);
    assert.equal(p.changedDuringRun, true);
    assert.equal(p.rows.filter((r) => r[2].startsWith('NEW')).length, 3);
  } finally {
    mock.server.close();
  }
});

test('a quick test run is saved apart from the real data', async () => {
  const mock = await startMock({ '/max-retail-prices-p': makeRows(250) });
  try {
    const { read } = await scrapeInto(mock.url, { PRI_LISTS: 'p', PRI_MAX_PAGES: '1' });
    const partial = await read('p.partial.json');
    assert.equal(partial.partial, true);
    assert.equal(partial.rowCount, 100);
    await assert.rejects(read('p.json'));
  } finally {
    mock.server.close();
  }
});
