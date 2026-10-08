import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGroceries, buildMedicines, categoryOf, cleanEan, packSize, price, sameProductName, splitMedicineName, validEan } from '../scripts/lib/model.mjs';

const P = ['Effective Date', 'Brand Name', 'Commodity Name', 'Commodity Type', 'EAN Code', 'MRP (M)', 'MRP (R)'];
const S = ['Effective Date', 'Brand Name', 'Commodity Name', 'Commodity Type', 'EAN Code', 'Subsidised Max Retail Price (M)', 'Subsidised Max Retail Price (R)'];
const PHS = ['Effective Date', 'Batch Number', 'Brand Name', 'Commodity Name', 'Commodity Type', 'EAN Code', 'Subsidised MRP (M)', 'Subsidised MRP (R)'];

test('barcodes: cleaning and check digit', () => {
  assert.equal(cleanEan('3250390000426'), '3250390000426');
  assert.equal(cleanEan(' 3250 3900-00426 '), '3250390000426');
  assert.equal(cleanEan('1.11E+13'), '');
  assert.equal(cleanEan('123'), '');
  assert.equal(validEan('3250390000426'), true);
  assert.equal(validEan('3250390000427'), false);
  assert.equal(validEan('0793573740083'), true);
  assert.equal(validEan('325622894013196'), false);
  assert.equal(validEan('0000000000000'), false);
});

test('prices: zero, blank and junk mean "no price"', () => {
  assert.equal(price('79.27'), 79.27);
  assert.equal(price('6,672.31'), 6672.31);
  assert.equal(price('0.00'), 0);
  assert.equal(price(''), 0);
  assert.equal(price('n/a'), 0);
});

test('official commodity types map to shopper categories', () => {
  assert.equal(categoryOf('Basmati rice'), 'rice');
  assert.equal(categoryOf('Infant Milk Powder'), 'infant-milk');
  assert.equal(categoryOf('Milk Powder (New Mark-Up)'), 'milk-powder');
  assert.equal(categoryOf('Infant Food/Infant Food Preparation ( VAT)'), 'infant-food');
  assert.equal(categoryOf('Locally Manufactured - Canned Tuna (natural/in oil/in water/unflavored)'), 'canned-fish');
  assert.equal(categoryOf('Canned Tomatoes'), 'canned-veg');
  assert.equal(categoryOf('Frozen Packed Vegetables (Beans, Mixed Vegetables, Peas, Potatoes, Spinach, Sweet Corn)'), 'frozen-veg');
  assert.equal(categoryOf('Tea - Rodrigues only'), 'tea');
  assert.equal(categoryOf('Soaps and Detergents (VAT) - Rodrigues Only'), 'soap');
  assert.equal(categoryOf('Canned Poultry ( Luncheon Meat)'), 'canned-meat');
  assert.equal(categoryOf('Sanitary Pads / Tampons / Towels'), 'sanitary');
  assert.equal(categoryOf(''), 'other');
});

test('same barcode: retyped names are one product, another pack or flavour is not', () => {
  assert.equal(sameProductName('ABENA SLIP L4 PREMIUM', 'Abena Slip L4 Premium 18 pieces /packet'), true);
  assert.equal(sameProductName('LABELL ACTEA NORM. DISCREET X12', 'LABELL ACTEA NORM. DISCREETX12'), true);
  assert.equal(sameProductName('FIORINI SPAGHETTI CELLO 500G', 'FIORINI SPAGHETTI CELLO 500 G'), true);
  assert.equal(sameProductName('1KG MACARONI CARREFOUR', 'CARREFOUR MACARONI 1000G'), true);
  assert.equal(sameProductName('IMPERIAL GOLD 1121 STEAMED BASMATI RICE 5KGS', 'IMPERIAL GOLD 1121 STEAMED BASMATI RICE 20KG'), false);
  assert.equal(sameProductName('Whole Milk Powder Regular Nedgold 25 kgs bags', 'Fransafe Milk Powder 1kg - Regular non-instant'), false);
  assert.equal(sameProductName('BLEDINE 400G BLE ET CACAO 677951', 'BDEJ 4X250ML CHOCO VANILLE 582043'), false);
  assert.equal(sameProductName('BLEDINE 200G EXTRA BAN ET FRA', 'BLEDINE 200G EXTRA FRUITS EXO'), false);
  assert.equal(sameProductName('DELTA FORM SLIP M1', 'DELTA FORM M3 ADULT'), false);
  assert.equal(sameProductName('POMMETTE AGILITY 4/9KG X32', 'POMMETTE AGILITY 4/9KG X60'), false);
});

test('pack sizes are read in their many spellings', () => {
  assert.deepEqual([...packSize('SNOWY 1KG-1').amounts], ['1000g']);
  assert.deepEqual([...packSize('Thon listao 2x140 280g').amounts], ['280g']);
  assert.deepEqual([...packSize('75CL HUILE TOURNES VGE CRF BIO').amounts], ['750ml']);
  assert.deepEqual([...packSize('PERFECT TASTE SOYA BEAN OIL X 1LT').amounts], ['1000ml']);
  assert.deepEqual([...packSize('BRASSE VEGETAL 4X100G').packs], ['4']);
  assert.deepEqual([...packSize('PAMPERS PANTS S5 (X46)').packs], ['46']);
  assert.deepEqual([...packSize('LAMB WESTON STEALTH FRIES 11 X 11 SKIN ON 2,5KG').amounts], ['2500g']);
});

test('groceries: one product per item, newest price first, subsidy flagged', () => {
  const { items, stats } = buildGroceries([
    {
      list: 'p',
      headers: P,
      rows: [
        ['09/10/2026', 'FIORINI', 'FIORINI SPAGHETTI CELLO 500G', 'Pasta (Macaroni and Spaghetti) (Imported)(With VAT)', '3250390000372', '44.94', '47.46'],
        ['02/03/2026', 'FIORINI', 'FIORINI SPAGHETTI CELLO 500 G', 'Pasta (Macaroni and Spaghetti) (Imported)(With VAT)', '3250390000372', '43.10', '45.52'],
        ['02/03/2026', 'FIORINI', 'FIORINI SPAGHETTI CELLO 500 G', 'Pasta (Macaroni and Spaghetti) (Imported)(With VAT)', '3250390000372', '43.10', '45.52'],
        ['06/10/2026', 'ARIEL', 'ARIEL REGULAR 1KG', 'Soaps and Detergents (VAT) - Rodrigues Only', '5413149940925', '0.00', '215.32'],
        ['21/11/2024', 'BELLE FRANCE', 'CELLO 500G FARFALLES BELLE FRANCE', 'Pasta (Macaroni, Spaghetti,Lasagna,Farfalle) (Imported)(With VAT)', '', '63.38', '0.00'],
        ['01/10/2026', '', '', '', '', '', ''],
        ['17/09/2026', '', '', '', '', '146.69', '167.32'],
        ['17/09/2026', 'X', 'NO PRICE PRODUCT', 'Basmati rice', '', '0.00', ''],
        ['03/10/2026', 'LABELL', 'LABELL ACTEA NORM. DISCREET X12', 'Sanitary Pads / Tampons / Towels', '3250393196041', '77.03', '80.63'],
        ['29/09/2026', 'IMPERIAL GOLD', 'IMPERIAL GOLD 1121 STEAMED BASMATI RICE 20KG', 'Basmati rice', '8901161109453', '1429.52', '1568.37'],
        ['29/09/2026', 'IMPERIAL GOLD BASMATI RICE', 'IMPERIAL GOLD 1121 STEAMED BASMATI RICE 5KGS', 'Basmati rice', '8901161109453', '372.92', '409.14'],
      ],
    },
    {
      list: 's',
      headers: S,
      rows: [
        ['09/10/2026', 'KRAFT', 'Kraft 100g cheddar can', 'Processed cheese', '7622210852373', '52.12', '52.12'],
        ['24/09/2025', 'LABELL', 'LABELL ACTEA NORM. DISCREETX12', 'Adult Diapers', '3250393196041', '25.84', '25.84'],
        ['08/10/2026', 'Snowy', '"SNOWY 1KG-1 "', 'Milk Powder (New Mark-Up)', '6001234088905', '266.35', '266.35'],
        ['01/07/2026', 'HIPP', 'BRASSE VEGETAL BANANE POMME FRAMBOISE 4X100G', 'Infant Food/Infant Food Preparation (without VAT)', '4062300458000', '147.17', '147.17'],
        ['01/07/2026', 'HIPP', 'Brasse Pomme Banane Framboise - 4 X 100G', 'Infant Food/Infant Food Preparation (without VAT)', '4062300458000', '221.27', '221.27'],
      ],
    },
  ]);
  assert.equal(stats.noName, 2);
  assert.equal(stats.noPrice, 1);
  const byName = Object.fromEntries(items.map((p) => [p.name, p]));

  const pasta = byName['FIORINI SPAGHETTI CELLO 500G'];
  assert.equal(pasta.cat, 'pasta');
  assert.deepEqual(pasta.history.map((h) => h.slice(0, 4)), [
    [20261009, 0, 44.94, 47.46],
    [20260302, 0, 43.1, 45.52],
  ]);

  assert.deepEqual(byName['ARIEL REGULAR 1KG'].history[0].slice(0, 4), [20261006, 0, 0, 215.32]);
  assert.deepEqual(byName['CELLO 500G FARFALLES BELLE FRANCE'].history[0].slice(0, 4), [20241121, 0, 63.38, 0]);
  assert.equal(byName['Kraft 100g cheddar can'].history[0][1], 1);
  assert.equal(byName['SNOWY 1KG-1'].brand, 'Snowy');

  // Once subsidised, now on the regular list: one product, the regular price is current.
  const labell = byName['LABELL ACTEA NORM. DISCREET X12'];
  assert.deepEqual(labell.history.map((h) => [h[0], h[1], h[2]]), [
    [20261003, 0, 77.03],
    [20250924, 1, 25.84],
  ]);
  assert.equal(byName['IMPERIAL GOLD 1121 STEAMED BASMATI RICE 20KG'].history.length, 1);
  assert.equal(byName['IMPERIAL GOLD 1121 STEAMED BASMATI RICE 5KGS'].history[0][2], 372.92);
  assert.equal(byName['BRASSE VEGETAL BANANE POMME FRAMBOISE 4X100G'].history[0][2], 147.17);
  assert.equal(byName['Brasse Pomme Banane Framboise - 4 X 100G'].history[0][2], 221.27);
  assert.equal(items.length, 10);
});

test('medicines: class tail is split off in its many spellings', () => {
  const cases = [
    ['TELTAS 40 H (CARDIOVASCULAR)', 'cardio', 'TELTAS 40 H'],
    ['TRIATEC COMP 10mg x 30 (UNICORN) - Antihypertensive', 'hypertension', 'TRIATEC COMP 10mg x 30 (UNICORN)'],
    ['TAREG/DIOVAN COMP 160MG X 28- ANTI-HYPERTENSIVE', 'hypertension', 'TAREG/DIOVAN COMP 160MG X 28'],
    ['JARDY- MET 12.5/1000 TABLET X 28 (ANTIDIABETIC)', 'diabetes', 'JARDY- MET 12.5/1000 TABLET X 28'],
    ['ARBITEL-AM (Telmisartan 40mg amlodipine 5mg tab) (CARDOVASCULAR)', 'cardio', 'ARBITEL-AM (Telmisartan 40mg amlodipine 5mg tab)'],
    ["BESICOR 10MG CPR B/30-'ANTI-HYPERTENSIVE'", 'hypertension', 'BESICOR 10MG CPR B/30'],
    ['TEMSAN H 40/12.5 MG TABLET 2 X 15 CARDIOVASCULAR', 'cardio', 'TEMSAN H 40/12.5 MG TABLET 2 X 15'],
    ['Dapzin 5 (Dapagliflozin Tablets 5mg) (ANTI-DIABETIC)', 'diabetes', 'Dapzin 5 (Dapagliflozin Tablets 5mg)'],
    ['OSIMERTINIB 80 MG TABS X 30 - OSITAB 80 ( ANTI CANCER)', 'cancer', 'OSIMERTINIB 80 MG TABS X 30 - OSITAB 80'],
    ['PANADOL CHLD5-12YR ELIXR 100ML', 'other', 'PANADOL CHLD5-12YR ELIXR 100ML'],
    ['CARDICOR 2.5MG TABS X 30 (A) - Cardiovascular', 'cardio', 'CARDICOR 2.5MG TABS X 30 (A)'],
  ];
  for (const [full, cls, name] of cases) assert.deepEqual(splitMedicineName(full), { cls, name }, full);
});

test('medicines: batches are grouped under one name, newest first', () => {
  const { items, stats } = buildMedicines([
    {
      list: 'phs',
      headers: PHS,
      rows: [
        ['03/10/2026', 'RX185', 'JARDY- MET 12.5/1000 TABLET X 28 (ANTIDIABETIC)', 'JARDY- MET 12.5/1000 TABLET X 28 (ANTIDIABETIC)', 'Pharmaceutical Products (Classified)', '', '1250.00', '1250.00'],
        ['03/10/2026', 'RX185', 'JARDY- MET 12.5/1000 TABLET X 28 (ANTIDIABETIC)', 'JARDY- MET 12.5/1000 TABLET X 28 (ANTIDIABETIC)', 'Pharmaceutical Products (Classified)', '', '1250.00', '1250.00'],
        ['12/01/2026', 'RW001', 'NA', 'JARDY-MET 12.5/1000 TABLET X 28 - ANTIDIABETIC', 'Pharmaceutical Products (Classified)', '1.11E+13', '1198.40', '1198.40'],
        ['08/10/2026', 'T1208', 'SANOFI AVENTIS', 'TRIATEC COMP 10mg x 30 (UNICORN) - Antihypertensive', 'Pharmaceutical Products (Classified)', '', '980.06', '980.06'],
        ['08/10/2026', 'T0000', '', '', 'Pharmaceutical Products (Classified)', '', '10.00', '10.00'],
      ],
    },
  ]);
  assert.equal(stats.noName, 1);
  assert.equal(items.length, 2);
  const jardy = items.find((m) => m.name.startsWith('JARDY'));
  assert.equal(jardy.cls, 'diabetes');
  assert.equal(jardy.sub, 1);
  assert.deepEqual(jardy.batches, [
    [20261003, 'RX185', 1250, 1250],
    [20260112, 'RW001', 1198.4, 1198.4],
  ]);
  const triatec = items.find((m) => m.name.startsWith('TRIATEC'));
  assert.equal(triatec.brand, 'SANOFI AVENTIS');
  assert.equal(triatec.cls, 'hypertension');
});
