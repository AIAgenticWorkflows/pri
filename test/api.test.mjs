import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanQuery, searchMedicines } from '../api/medicines.js';
import { PHARMA_HEADERS, startMock } from './mock-pfu.mjs';

const TYPE = 'Pharmaceutical Products (Classified)';
const rows = [
  ['12/08/2026', 'EF904', 'PANADOL', 'PANADOL CHLD5-12YR ELIXR 100ML', TYPE, '', '199.97', '225.97'],
  ['04/03/2026', 'EF511', 'PANADOL', 'PANADOL CHLD5-12YR ELIXR 100ML', TYPE, '', '189.40', '214.02'],
  ['09/10/2026', 'B14410', '', 'UTOVLAN 5MG TABS X 90', TYPE, '', '454.57', '0.00'],
  ['09/10/2026', 'CZ26066A', 'OSITAB 80', 'OSIMERTINIB 80 MG TABS X 30 - OSITAB 80 ( ANTI CANCER)', TYPE, '', '4479.90', '5062.29'],
];

test('search text is cleaned before it is sent to the official site', () => {
  assert.equal(cleanQuery('  Panadol   500mg '), 'Panadol 500mg');
  assert.equal(cleanQuery('<script>alert(1)</script>'), 'script alert 1 /script');
  assert.equal(cleanQuery('ab'), '');
  assert.equal(cleanQuery('a.b'), '');
  assert.equal(cleanQuery('é'.repeat(80)).length, 60);
});

test('live search groups the official rows by medicine', async () => {
  const mock = await startMock({ '/max-retail-prices-pharmaceutical': { headers: PHARMA_HEADERS, rows } });
  try {
    const found = await searchMedicines('panadol', { base: mock.url });
    assert.equal(found.total, 2);
    assert.equal(found.items.length, 1);
    const [name, cls, sub, brand, batches] = found.items[0];
    assert.equal(name, 'PANADOL CHLD5-12YR ELIXR 100ML');
    assert.equal(found.classes[cls], 'other');
    assert.equal(sub, 0);
    assert.equal(brand, 'PANADOL');
    assert.deepEqual(batches, [
      [20260812, 'EF904', 199.97, 225.97],
      [20260304, 'EF511', 189.4, 214.02],
    ]);

    const cancer = await searchMedicines('ositab', { base: mock.url });
    assert.equal(cancer.classes[cancer.items[0][1]], 'cancer');
    assert.equal(cancer.items[0][0], 'OSIMERTINIB 80 MG TABS X 30 - OSITAB 80');

    const none = await searchMedicines('zzzzqqq', { base: mock.url });
    assert.deepEqual([none.total, none.items.length], [0, 0]);
  } finally {
    mock.server.close();
  }
});

test('a failing official site is reported, not hidden', async () => {
  const mock = await startMock({ '/max-retail-prices-pharmaceutical': 'error' });
  try {
    await assert.rejects(searchMedicines('panadol', { base: mock.url }), /HTTP 500/);
  } finally {
    mock.server.close();
  }
});
