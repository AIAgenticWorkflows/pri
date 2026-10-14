// One run of the data pull: bring each list's store up to date within a deadline, then
// rebuild the files the page loads. Called by api/pull.js on the hosted site, by
// scripts/pull.mjs locally, and by anything else that can run Node for a few minutes.

import { Collector, emptyStore, serialiseStore } from './collector.mjs';
import { buildOutputs } from './outputs.mjs';
import { LISTS } from './pfu.mjs';

const ORDER = ['p', 's', 'phs', 'ph'];

const LOCK_MS = 10 * 60 * 1000;
const SAVE_EVERY_MS = Number(process.env.PRI_SAVE_MINUTES || 3) * 60 * 1000;

export async function runPull({ storage, deadlineAt, lists = ORDER, base, pauseMs, timeoutMs, log = console.log, seed = async () => null, by = 'run', force = false }) {
  const started = Date.now();
  const say = (msg) => log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  const wanted = ORDER.filter((key) => lists.includes(key) && key in LISTS);

  // Only one pull at a time: a long run on a laptop and the site's own daily run must
  // not write over each other. The lock is refreshed while the work goes on.
  const lockId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const writeState = async (change) => {
    const state = (await storage.readJson('state.json')) || { runs: 0 };
    change(state);
    await storage.writeText('state.json', `${JSON.stringify(state, null, 2)}\n`);
    return state;
  };
  const existing = (await storage.readJson('state.json')) || {};
  if (!force && existing.lock && Date.now() - Date.parse(existing.lock.at) < LOCK_MS) {
    throw new Error(`another pull has been running since ${existing.lock.at} (${existing.lock.by}); try again in a few minutes, or, if you stopped it yourself, set PRI_FORCE=1`);
  }
  await writeState((state) => {
    state.lock = { id: lockId, at: new Date().toISOString(), by };
  });
  let lastHeartbeat = Date.now();
  const heartbeat = async () => {
    if (Date.now() - lastHeartbeat < 4 * 60000) return;
    lastHeartbeat = Date.now();
    await writeState((state) => {
      state.lock = { id: lockId, at: new Date().toISOString(), by };
    });
  };

  const collectors = {};
  const lastSaved = {};
  for (const key of wanted) {
    let store = await storage.readJson(`stores/${key}.json`);
    let from = 'storage';
    if (!store || !Array.isArray(store.rows)) {
      store = (await seed(key)) || emptyStore(key);
      from = store.rows && store.rows.length ? 'seed' : 'nothing';
    }
    collectors[key] = new Collector({
      key,
      store,
      deadlineAt,
      base,
      pauseMs,
      timeoutMs,
      log: say,
      // Progress is saved at most every few minutes: each save is a paid write on Blob.
      onProgress: async () => {
        if (Date.now() - (lastSaved[key] || started) < SAVE_EVERY_MS) return;
        await save(key);
        await heartbeat();
      },
    });
    say(`${key}: ${collectors[key].store.rows.length} rows from ${from}`);
  }
  const save = async (key) => {
    lastSaved[key] = Date.now();
    return storage.writeText(`stores/${key}.json`, serialiseStore(collectors[key].finish()));
  };
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

  // A store marked "searches done" while still empty came from an older version.
  if (collectors.ph && !collectors.ph.store.rows.length) collectors.ph.store.slicesDone = false;

  const runPassFor = async (key) => {
    try {
      await collectors[key].runPass();
    } catch (err) {
      say(`${key}: read-through failed: ${err.message}`);
    }
    await save(key);
  };

  // 2. Complete read-throughs of the smaller lists: resumed ones first, then whichever is due.
  const due = wanted.filter((key) => key !== 'ph' && collectors[key].passDue());
  due.sort((a, b) => (collectors[b].store.resumePage > 0) - (collectors[a].store.resumePage > 0));
  for (const key of due) {
    if (outOfTime()) break;
    await runPassFor(key);
  }

  // 2b. Rows the page-by-page reads missed: found by text searches.
  for (const key of wanted) {
    if (key === 'ph' || outOfTime()) continue;
    const c = collectors[key];
    if (!c.coverDue()) continue;
    try {
      say(`${key}: ${c.store.rows.length} rows held, the site reports ${c.store.reportedTotal}: searching for the missing ones`);
      await c.runCover();
    } catch (err) {
      say(`${key}: text searches failed: ${err.message}`);
    }
    await save(key);
  }

  // 3. The full medicines list, through name searches taken from both medicine lists.
  if (collectors.ph && !collectors.ph.store.slicesDone && !outOfTime()) {
    const phs = collectors.phs || { store: (await storage.readJson('stores/phs.json')) || emptyStore('phs') };
    const nameCol = phs.store.headers ? phs.store.headers.findIndex((h) => /commodity name/i.test(h)) : -1;
    const extra = nameCol >= 0 ? phs.store.rows.map((row) => row[nameCol]) : [];
    try {
      await collectors.ph.runSlices(extra);
    } catch (err) {
      say(`ph: searches failed: ${err.message}`);
    }
    await save('ph');
  }

  // 3b. Then text searches until every row of the medicines list is held; once that is
  // done, the same searches looked at again, oldest first, bring in new batches.
  if (collectors.ph && collectors.ph.store.slicesDone && !outOfTime()) {
    const c = collectors.ph;
    try {
      if (c.coverDue()) {
        const phsStore = collectors.phs ? collectors.phs.store : (await storage.readJson('stores/phs.json')) || emptyStore('phs');
        const col = phsStore.headers ? phsStore.headers.findIndex((h) => /commodity name/i.test(h)) : -1;
        await c.runCover(col >= 0 ? phsStore.rows.map((row) => row[col]) : []);
      } else {
        await c.refreshCover();
      }
    } catch (err) {
      say(`ph: text searches failed: ${err.message}`);
    }
    await save('ph');
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
  await writeState((state) => {
    state.runs = (state.runs || 0) + 1;
    state.lastRun = summary;
    if (!state.lock || state.lock.id === lockId) state.lock = null;
  });
  for (const key of wanted) say(`${key}: ${summary.lists[key].rows} rows; ${collectors[key].stats.steps.join('; ') || 'nothing to do'}`);
  say(`done in ${summary.seconds} s: ${out.meta.counts.products} products, ${out.meta.counts.medicines} medicines`);
  return summary;
}
