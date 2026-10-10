// One run of the data pull: bring each list's store up to date within a deadline, then
// rebuild the files the page loads. Called by api/pull.js on the hosted site, by
// scripts/pull.mjs locally, and by anything else that can run Node for a few minutes.

import { Collector, emptyStore, serialiseStore } from './collector.mjs';
import { buildOutputs } from './outputs.mjs';
import { LISTS } from './pfu.mjs';

const ORDER = ['p', 's', 'phs', 'ph'];

export async function runPull({ storage, deadlineAt, lists = ORDER, base, pauseMs, timeoutMs, log = console.log, seed = async () => null }) {
  const started = Date.now();
  const say = (msg) => log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  const wanted = ORDER.filter((key) => lists.includes(key) && key in LISTS);

  const collectors = {};
  for (const key of wanted) {
    let store = await storage.readJson(`stores/${key}.json`);
    let from = 'storage';
    if (!store || !Array.isArray(store.rows)) {
      store = (await seed(key)) || emptyStore(key);
      from = store.rows && store.rows.length ? 'seed' : 'nothing';
    }
    collectors[key] = new Collector({ key, store, deadlineAt, base, pauseMs, timeoutMs, log: say });
    say(`${key}: ${collectors[key].store.rows.length} rows from ${from}`);
  }
  const save = async (key) => storage.writeText(`stores/${key}.json`, serialiseStore(collectors[key].finish()));
  const outOfTime = () => deadlineAt - Date.now() < 15000;

  // 1. New rows at the top of each list.
  for (const key of wanted) {
    if (outOfTime()) break;
    const c = collectors[key];
    if (!c.topDue()) continue;
    try {
      await c.readTop();
      await save(key);
    } catch (err) {
      say(`${key}: top of the list failed: ${err.message}`);
    }
  }

  // 2. The full medicines list, through name searches.
  if (collectors.ph && !collectors.ph.store.slicesDone && !outOfTime()) {
    const phs = collectors.phs;
    const nameCol = phs && phs.store.headers ? phs.store.headers.findIndex((h) => /commodity name/i.test(h)) : -1;
    const extra = nameCol >= 0 ? phs.store.rows.map((row) => row[nameCol]) : [];
    try {
      await collectors.ph.runSlices(extra);
    } catch (err) {
      say(`ph: searches failed: ${err.message}`);
    }
    await save('ph');
  }

  // 3. Complete read-throughs: resumed ones first, then whichever is due.
  const due = wanted.filter((key) => collectors[key].passDue());
  due.sort((a, b) => (collectors[b].store.resumePage > 0) - (collectors[a].store.resumePage > 0));
  for (const key of due) {
    if (outOfTime()) break;
    try {
      await collectors[key].runPass();
    } catch (err) {
      say(`${key}: read-through failed: ${err.message}`);
    }
    await save(key);
  }

  // 4. The files the page loads.
  const stores = {};
  for (const key of ORDER) stores[key] = collectors[key] ? collectors[key].store : await storage.readJson(`stores/${key}.json`);
  const out = buildOutputs(stores);
  await storage.writeText('data/groceries.json', out.groceries);
  await storage.writeText('data/medicines.json', out.medicines);
  await storage.writeText('data/meta.json', `${JSON.stringify(out.meta, null, 2)}\n`);

  const summary = {
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    lists: Object.fromEntries(wanted.map((key) => [key, { rows: collectors[key].store.rows.length, ...collectors[key].stats, steps: collectors[key].stats.steps }])),
    counts: out.meta.counts,
  };
  const state = (await storage.readJson('state.json')) || { runs: 0 };
  state.runs = (state.runs || 0) + 1;
  state.lastRun = summary;
  state.lock = null;
  await storage.writeText('state.json', `${JSON.stringify(state, null, 2)}\n`);
  for (const key of wanted) say(`${key}: ${summary.lists[key].rows} rows; ${collectors[key].stats.steps.join('; ') || 'nothing to do'}`);
  say(`done in ${summary.seconds} s: ${out.meta.counts.products} products, ${out.meta.counts.medicines} medicines`);
  return summary;
}
