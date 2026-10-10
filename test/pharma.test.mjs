import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PHARMA_HEADERS, startMock } from './mock-pfu.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATH = '/max-retail-prices-pharmaceutical';

const meds = (n, prefix, date = '01/10/2026') =>
  Array.from({ length: n }, (_, i) => [date, `B${prefix}${i}`, '', `${prefix} ${String(i).padStart(4, '0')} TABS X 30 (CARDIOVASCULAR)`, 'Pharmaceutical Products (Classified)', '', '100.00', '110.00']);

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pri-ph-'));
  await cp(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  return dir;
}
async function runPharma(dir, url, env = {}) {
  const r = await run('node', [path.join(dir, 'scripts', 'pharma.mjs')], { env: { ...process.env, PRI_BASE_URL: url, PRI_PREVIOUS_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '', ...env } });
  return { log: r.stdout + r.stderr, data: JSON.parse(await readFile(path.join(dir, 'data', 'raw', 'ph.json'), 'utf8')) };
}

test('the full list is collected over several builds, then only new rows are read', async () => {
  const list = { headers: PHARMA_HEADERS, rows: meds(450, 'OLD') };
  const mock = await startMock({ [PATH]: list });
  const dir = await workspace();
  try {
    // First build: time for 2 page reads only.
    let { data } = await runPharma(dir, mock.url, { PRI_PH_MAX_PAGES: '2' });
    assert.equal(data.complete, false);
    assert.equal(data.rowCount, 200);
    assert.equal(data.nextPage, 2);

    // New rows arrive at the top before the next build; older rows move down.
    list.rows = [...meds(130, 'NEW', '09/10/2026'), ...list.rows];
    ({ data } = await runPharma(dir, mock.url));
    assert.equal(data.complete, true);
    assert.equal(data.rowCount, 580);
    assert.equal(new Set(data.rows.map((r) => r[1])).size, 580);
    assert.equal(data.rows[0][0], '09/10/2026');

    // Daily build after that: a few more new rows, no older pages read.
    list.rows = [...meds(5, 'TODAY', '10/10/2026'), ...list.rows];
    const requestsBefore = mock.requests();
    ({ data } = await runPharma(dir, mock.url));
    assert.equal(data.rowCount, 585);
    assert.equal(data.newAtTop, 5);
    assert.equal(data.olderPagesRead, 0);
    assert.ok(mock.requests() - requestsBefore <= 2);
  } finally {
    mock.server.close();
  }
});

test('an unreachable official list keeps the previous copy and does not fail', async () => {
  const good = await startMock({ [PATH]: { headers: PHARMA_HEADERS, rows: meds(150, 'A') } });
  const dir = await workspace();
  try {
    await runPharma(dir, good.url);
  } finally {
    good.server.close();
  }
  const bad = await startMock({ [PATH]: 'error' });
  try {
    const { data } = await runPharma(dir, bad.url);
    assert.equal(data.rowCount, 150);
    assert.equal(data.complete, true);
  } finally {
    bad.server.close();
  }
});
