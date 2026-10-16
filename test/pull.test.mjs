import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Collector, emptyStore } from '../scripts/lib/collector.mjs';
import { runPull } from '../scripts/lib/pull.mjs';
import { fileStorage } from '../scripts/lib/storage.mjs';
import { HEADERS, PHARMA_HEADERS, startMock } from './mock-pfu.mjs';

const P = '/max-retail-prices-p';
const PH = '/max-retail-prices-pharmaceutical';
const PHS = '/subsidised-mrp-pharmaceutical';
const quiet = () => {};
const soon = (ms) => Date.now() + ms;

const groceries = (n, prefix = 'ITEM', date = '01/10/2026') =>
  Array.from({ length: n }, (_, i) => [date, 'BRAND', `${prefix} ${String(i).padStart(4, '0')}`, 'Basmati rice', String(3250390000000 + i), '10.00', '11.00']);
const meds = (n, prefix, date = '01/10/2026') =>
  Array.from({ length: n }, (_, i) => [date, `B${prefix}${i}`, '', `${prefix} ${String(i).padStart(4, '0')} TABS X 30 (CARDIOVASCULAR)`, 'Pharmaceutical Products (Classified)', '', '100.00', '110.00']);

test('a complete read-through, then only the top of the list until the next one is due', async () => {
  const lists = { [P]: groceries(250) };
  const mock = await startMock(lists);
  try {
    const c = new Collector({ key: 'p', store: null, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    assert.equal(c.topDue(), false); // nothing stored yet: a read-through fills it
    assert.equal(c.passDue(), true);
    assert.deepEqual(await c.runPass(), { done: true, dropped: 0 });
    const store = c.finish();
    assert.equal(store.rows.length, 250);
    assert.equal(store.pass, 1);
    assert.equal(store.complete, true);
    assert.deepEqual(store.headers, HEADERS);

    // Next run: 3 new rows at the top, no read-through due.
    lists[P] = [...groceries(3, 'NEW', '09/10/2026'), ...lists[P]];
    const again = new Collector({ key: 'p', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    assert.equal(again.topDue(), true);
    assert.equal(again.passDue(), false);
    const requests = mock.requests();
    assert.deepEqual(await again.readTop(), { done: true, fresh: 3 });
    assert.ok(mock.requests() - requests <= 3);
    assert.equal(again.finish().rows.length, 253);
    assert.equal(again.topDue(), false);
  } finally {
    mock.server.close();
  }
});

test('a read-through that runs out of time carries on next run, and prunes rows that left the list', async () => {
  const full = groceries(250);
  const lists = { [P]: full };
  const mock = await startMock(lists);
  try {
    // First run: time for the first two pages only.
    let store = emptyStore('p');
    let c = new Collector({ key: 'p', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    c.outOfTime = () => c.stats.pages >= 2;
    assert.deepEqual(await c.runPass(), { done: false });
    store = c.finish();
    assert.equal(store.rows.length, 200);
    assert.equal(store.resumePage, 2);
    assert.equal(store.complete, false);

    // Second run finishes the read-through.
    c = new Collector({ key: 'p', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    assert.equal(c.passDue(), true);
    assert.deepEqual(await c.runPass(), { done: true, dropped: 0 });
    store = c.finish();
    assert.equal(store.rows.length, 250);
    assert.equal(store.pass, 1);

    // One row leaves the official list. It survives one more read-through, then goes.
    lists[P] = full.filter((r) => r[2] !== 'ITEM 0042');
    for (const expected of [250, 249]) {
      c = new Collector({ key: 'p', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
      await c.runPass();
      store = c.finish();
      assert.equal(store.rows.length, expected);
    }
    assert.equal(store.rows.some((r) => r[2] === 'ITEM 0042'), false);
  } finally {
    mock.server.close();
  }
});

test('the full medicines list is pulled through name searches, learning names as it goes', async () => {
  // Families of medicines; only CARDI... names share a word with the subsidised list.
  // The newest page shows a few families; TELTAS is known only from the subsidised list.
  const rows = [...meds(5, 'OSITAB'), ...meds(40, 'EXFORGE'), ...meds(130, 'PANADOL'), ...meds(20, 'TELTAS')];
  const mock = await startMock({ [PH]: { headers: PHARMA_HEADERS, rows }, [PHS]: { headers: PHARMA_HEADERS, rows: meds(10, 'TELTAS') } });
  try {
    const c = new Collector({ key: 'ph', store: null, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    // Known names to start from: the subsidised list's, plus the first page of the full list.
    const first = await c.fetchPage('', 0);
    for (const row of first.rows) c.add(row);
    const extra = ['TELTAS 40 H (CARDIOVASCULAR)'];
    const out = await c.runSlices(extra);
    assert.equal(out.done, true);
    const store = c.finish();
    assert.equal(store.slicesDone, true);
    assert.equal(store.rows.length, 195);
    const searched = Object.entries(store.tokens).filter(([, v]) => v.done).map(([t]) => t).sort();
    assert.deepEqual(searched, ['EXFORGE', 'OSITAB', 'PANADOL', 'TELTAS']);
    assert.equal(store.tokens.TABS, undefined); // stop words are never searched
  } finally {
    mock.server.close();
  }
});

test('a whole run: seeds, top of each list, searches, outputs, and the state file', async () => {
  const lists = {
    [P]: groceries(120),
    '/max-retail-prices-s': groceries(30, 'SUB'),
    [PHS]: { headers: PHARMA_HEADERS, rows: meds(15, 'TELTAS') },
    [PH]: { headers: PHARMA_HEADERS, rows: [...meds(50, 'PANADOL'), ...meds(8, 'TELTAS')] },
  };
  const mock = await startMock(lists);
  const dir = await mkdtemp(path.join(tmpdir(), 'pri-pull-'));
  const storage = fileStorage(dir);
  try {
    const seed = async (key) => (key === 'p' ? { ...emptyStore('p'), headers: HEADERS, rows: groceries(100), seen: Array(100).fill(1), pass: 1, fullPassAt: new Date().toISOString(), topAt: null, complete: true } : null);
    const summary = await runPull({ storage, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: process.env.DBG ? console.log : quiet, seed });
    assert.equal(summary.lists.p.rows, 120); // 100 seeded + 20 found at the top
    assert.equal(summary.lists.s.rows, 30);
    assert.equal(summary.lists.phs.rows, 15);
    assert.equal(summary.lists.ph.rows, 58);
    const meta = JSON.parse(await readFile(path.join(dir, 'data', 'meta.json'), 'utf8'));
    assert.equal(meta.counts.products, 150);
    assert.equal(meta.counts.medicines, 73); // every distinct name, subsidised ones apart
    assert.equal(meta.lists.ph.onSite, true);
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.runs, 1);
    assert.equal(state.lock, null);
    const groceriesOut = await readFile(path.join(dir, 'data', 'groceries.json'), 'utf8');
    assert.match(groceriesOut, /SUB 0001/);

    // A second run straight away only looks at the top of the medicines list (filled by
    // searches, never read from the top yet) and changes nothing.
    const requests = mock.requests();
    const second = await runPull({ storage, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet, seed });
    assert.equal(second.lists.ph.rows, 58);
    assert.ok(mock.requests() - requests <= 3, `made ${mock.requests() - requests} requests`);
  } finally {
    mock.server.close();
  }
});

test('text searches find every medicine, even names sharing no word with a known one', async () => {
  const names = ['ZYLORIC 300', 'EXFORGE 5/160 COMPS X 28', 'QUX', 'A', 'BETA-X', 'ÉCRAN 50 ML', 'NOVO-7', 'CO-AMOXI 625', 'KX', 'AB'];
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const name = i < names.length ? names[i] : `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}MED ${i} TABS`;
    rows.push(['01/10/2026', `B${i}`, '', name, 'Pharmaceutical Products (Classified)', '', '10.00', '11.00']);
  }
  const mock = await startMock({ [PH]: { headers: PHARMA_HEADERS, rows } });
  try {
    const store = { ...emptyStore('ph'), slicesDone: true, headers: PHARMA_HEADERS };
    const c = new Collector({ key: 'ph', store, deadlineAt: soon(120000), base: mock.url, pauseMs: 0, log: quiet, maxSliceRows: 40 });
    assert.equal(c.coverDue(), true);
    assert.equal(c.passDue(), false);
    assert.equal(c.topDue(), false);
    const out = await c.runCover([]);
    assert.equal(out.done, true);
    assert.equal(c.store.rows.length, 400);
    assert.equal(c.store.complete, true);
    assert.equal(c.coverDue(), false);

    // New batches later: the refresh finds them.
    rows.unshift(['09/10/2026', 'NEW1', '', 'ZYLORIC 100', 'Pharmaceutical Products (Classified)', '', '9.00', '9.50']);
    const again = new Collector({ key: 'ph', store: c.finish(), deadlineAt: soon(120000), base: mock.url, pauseMs: 0, log: quiet, maxSliceRows: 40 });
    await again.refreshCover();
    assert.equal(again.store.rows.length, 401);
  } finally {
    mock.server.close();
  }
});

test('rows missed by paging are found by text searches when the site reports more', async () => {
  const rows = groceries(300);
  const mock = await startMock({ [P]: rows });
  try {
    const held = rows.filter((_, i) => i % 7 !== 0); // 43 rows missed
    const store = { ...emptyStore('p'), headers: HEADERS, rows: held, seen: held.map(() => 1), pass: 1, fullPassAt: new Date().toISOString(), topAt: new Date().toISOString(), reportedTotal: 300 };
    const c = new Collector({ key: 'p', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet, maxSliceRows: 60 });
    assert.equal(c.coverDue(), true);
    await c.runCover();
    assert.equal(c.store.rows.length, 300);
    assert.equal(c.coverDue(), false);
  } finally {
    mock.server.close();
  }
});

test('text searches do not loop on rows the site lists twice', async () => {
  const row = (i) => ['01/10/2026', `B${i}`, '', `PANADOL ${i} TABS`, 'Pharmaceutical Products (Classified)', '', '10.00', '11.00'];
  const rows = [row(1), row(1), row(1), row(2), row(3)]; // the first row three times
  const mock = await startMock({ [PH]: { headers: PHARMA_HEADERS, rows } });
  try {
    const store = { ...emptyStore('ph'), slicesDone: true, headers: PHARMA_HEADERS };
    const c = new Collector({ key: 'ph', store, deadlineAt: soon(90000), base: mock.url, pauseMs: 0, log: quiet, maxSliceRows: 40 });
    const out = await c.runCover([]);
    assert.equal(out.done, true);
    assert.equal(c.store.rows.length, 3);
    assert.ok(c.store.cover.searches < 500, `${c.store.cover.searches} searches`);
  } finally {
    mock.server.close();
  }
});

test('the medicines list is read one commodity type at a time when the site serves it', async () => {
  const med = (i, type) => ['01/10/2026', `B${i}`, '', `MED ${i} TABS`, type, '', '10.00', '11.00'];
  const rows = [];
  for (let i = 0; i < 250; i++) rows.push(med(i, i % 5 ? 'Pharmaceutical Products (Classified)' : 'Medical Devices'));
  for (let i = 250; i < 300; i++) rows.push(med(i, 'Vaccines'));
  const lists = { [PH]: { headers: PHARMA_HEADERS, rows }, slowTypes: ['vaccines'] };
  const mock = await startMock(lists);
  try {
    const held = [rows[1], rows[5], rows[260]]; // one of each type
    const store = { ...emptyStore('ph'), slicesDone: true, headers: PHARMA_HEADERS, rows: held, seen: held.map(() => 0) };
    const c = new Collector({ key: 'ph', store, deadlineAt: soon(60000), base: mock.url, pauseMs: 0, log: quiet });
    assert.equal(c.typeWalkDue(), true);
    const out = await c.runTypeWalk();
    assert.equal(out.done, true);
    assert.equal(c.store.rows.length, 251); // 250 from the two types it serves, plus the vaccine we held
    assert.equal(c.store.typeWalk.types.Vaccines.state, 'failed');
    assert.equal(c.typeWalkDue(), false);
  } finally {
    mock.server.close();
  }
});
