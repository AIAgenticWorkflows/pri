// Reads one official list from pfu.govmu.org into a "store" and keeps that store up to
// date across runs. Every run has a deadline; whatever is not finished carries on next
// time, so the work can be split into short slices (a Vercel function may run for five
// minutes at most).
//
// A store is: { list, headers, rows: [[cell, ...]], seen: [pass, ...], pass, resumePage,
//   topAt, fullPassAt, reportedTotal, lastPage, complete, tokens, fetchedAt }
//
// Three kinds of reading, in this order of priority:
//   top      the newest rows sit at the top of the list (sorted by date, newest first);
//            read down from page 0 until a page brings nothing new.
//   slices   (full medicines list only) a search by name answers in about a second,
//            while an unfiltered page takes over a minute, so the list is pulled through
//            name searches first: search every word seen in a name, learn new words from
//            the results, repeat.
//   pass     one complete read-through, page by page, resumed across runs. After it,
//            rows not seen for KEEP_PASSES read-throughs are dropped: they have left the
//            official list. Rows that share a date come back in a changing order, so a
//            single read-through can miss a few; the memory of earlier passes covers that.

import { BASE_URL, LISTS, isoDate, parsePage } from './pfu.mjs';
import { fold } from './model.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; PriBot/1.0; +https://www.aplica.biz)';
const HOUR = 3600 * 1000;

export const POLICY = {
  p: { topEvery: 3 * HOUR, fullEvery: 3 * 24 * HOUR, keepPasses: 2, concurrency: 1, slices: false, prune: true },
  s: { topEvery: 3 * HOUR, fullEvery: 3 * 24 * HOUR, keepPasses: 2, concurrency: 1, slices: false, prune: true },
  phs: { topEvery: 3 * HOUR, fullEvery: 7 * 24 * HOUR, keepPasses: 2, concurrency: 1, slices: false, prune: true },
  // The full medicines list: 57,000 batches, a minute per page. Pulled by name searches,
  // completed once by a slow read-through, then kept current from the top only.
  ph: { topEvery: 20 * HOUR, fullEvery: Infinity, keepPasses: 2, concurrency: 2, slices: true, prune: false },
};

// Words that appear in thousands of medicine names: searching them would be slow and
// would bring nothing a rarer word does not.
const STOP_WORDS = new Set(
  (
    'TABS TAB TABLET TABLETS CAPS CAPSULE CAPSULES COMP COMPS COMPRIME COMPRIMES CPR INJ INJECTION INJECTIONS AMP AMPS AMPOULE AMPOULES ' +
    'VIAL VIALS SYRUP SYRP SUSP SUSPENSION SOLN SOLUTION DROPS CREAM OINT OINTMENT GEL SACHET SACHETS SUPP SUPPS SUPPOS SUPPOSITORY ' +
    'BOITE BOITES BTE PACK PACKS STRIP STRIPS BLISTER BLISTERS BOX BOXES PCS PIECE PIECES EACH UNIT UNITS FILM COATED PELLICULE ' +
    'CARDIOVASCULAR CARDIO ANTIHYPERTENSIVE ANTI HYPERTENSIVE ANTIDIABETIC DIABETIC DIABETES CLASSIFIED UNCLASSIFIED CANCER ANTICANCER ' +
    'WITH WITHOUT SANS AVEC POUR PAR DANS FORT FORTE PLUS EXTRA RETARD DEPOT PROLONGED RELEASE SLOW RAPID ORAL NASAL EYE EAR ' +
    'SODIUM CHLORIDE HYDROCHLORIDE HCL SULPHATE SULFATE ACETATE CITRATE POTASSIUM CALCIUM MAGNESIUM ' +
    'ADULT ADULTS CHILD CHILDREN PAEDIATRIC PEDIATRIC INFANT BABY JUNIOR SENIOR ' +
    'DENK SANDOZ TEVA CIPLA MYLAN ACCORD ZENTIVA VIATRIS PFIZER NOVARTIS SANOFI BAYER ROCHE MERCK ABBOTT ASTRAZENECA GSK ' +
    'INDIA FRANCE GERMANY ITALY SPAIN UNITED KINGDOM ARAB EMIRATES LAB LABO LABORATOIRE LABORATOIRES LABORATORIES LTD LIMITED PVT'
  ).split(/\s+/),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowId = (row) => JSON.stringify(row);

export function emptyStore(key) {
  return { list: key, headers: null, rows: [], seen: [], pass: 0, resumePage: 0, topAt: null, fullPassAt: null, reportedTotal: null, lastPage: 0, complete: false, tokens: {}, fetchedAt: null };
}

export class Collector {
  constructor({ key, store, deadlineAt, base = BASE_URL, pauseMs = 300, timeoutMs = 180000, log = () => {}, maxSliceRows = 2500 }) {
    this.key = key;
    this.policy = POLICY[key] || POLICY.p;
    this.path = LISTS[key].path;
    this.base = base;
    this.deadlineAt = deadlineAt;
    this.pauseMs = pauseMs;
    this.timeoutMs = timeoutMs;
    this.log = (msg) => log(`${key}: ${msg}`);
    this.maxSliceRows = maxSliceRows;
    this.store = store && Array.isArray(store.rows) ? { ...emptyStore(key), ...store } : emptyStore(key);
    this.index = new Map(); // row id -> position in store.rows
    this.store.rows.forEach((row, i) => this.index.set(rowId(row), i));
    if (!Array.isArray(this.store.seen) || this.store.seen.length !== this.store.rows.length) this.store.seen = this.store.rows.map(() => this.store.pass);
    this.stats = { pages: 0, searches: 0, newRows: 0, dropped: 0, newAtTop: 0, slicedRows: 0, passPages: 0, steps: [] };
  }

  timeLeft() {
    return this.deadlineAt - Date.now();
  }

  outOfTime() {
    return this.timeLeft() < 15000;
  }

  // Adds a row; returns true when it was never seen before.
  add(row, pass = this.store.pass) {
    const { headers } = this.store;
    if (headers && row.length !== headers.length) return false;
    const id = rowId(row);
    const at = this.index.get(id);
    if (at !== undefined) {
      if (this.store.seen[at] < pass) this.store.seen[at] = pass;
      return false;
    }
    this.index.set(id, this.store.rows.length);
    this.store.rows.push(row);
    this.store.seen.push(pass);
    this.stats.newRows++;
    return true;
  }

  async fetchPage(query, page, retries = 2) {
    const qs = [query, page ? `page=${page}` : ''].filter(Boolean).join('&');
    const url = this.base + this.path + (qs ? `?${qs}` : '');
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (this.timeLeft() < 5000) throw new Error('out of time');
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, Math.max(5000, this.timeLeft() - 2000))),
        });
        const html = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} after ${Date.now() - t0} ms`);
        const parsed = parsePage(html);
        this.stats.pages++;
        if (!parsed.hasTable) {
          if (query) return { ...parsed, rows: [], ms: Date.now() - t0, empty: true }; // a search with no match
          throw new Error(`no results table in the response (${html.length} bytes)`);
        }
        if (!this.store.headers) this.store.headers = parsed.headers;
        else if (parsed.headers.length !== this.store.headers.length) throw new Error(`the table changed shape: ${parsed.headers.join(' | ')}`);
        return { ...parsed, ms: Date.now() - t0 };
      } catch (err) {
        lastError = err;
        this.log(`page ${page}${query ? ` (${query})` : ''}: attempt ${attempt} failed: ${err.message}`);
        if (attempt < retries && this.timeLeft() > 30000) await sleep(3000 * attempt);
        else break;
      }
    }
    throw lastError;
  }

  // ---- top of the list ------------------------------------------------------------
  topDue(now = Date.now()) {
    // An empty store is filled by a read-through, except for the sliced list, which starts
    // from the newest pages to learn names to search.
    if (!this.store.rows.length) return Boolean(this.policy.slices);
    return !this.store.topAt || now - Date.parse(this.store.topAt) > this.policy.topEvery;
  }

  async readTop(maxPages = 15) {
    let fresh = 0;
    let n = 0;
    for (; n < maxPages; n++) {
      if (this.outOfTime()) return { done: false, fresh };
      if (n) await sleep(this.pauseMs);
      const page = await this.fetchPage('', n);
      this.noteTotals(page);
      const added = page.rows.filter((row) => this.add(row)).length;
      fresh += added;
      // Always look at the first two pages: a row that moved across the page boundary
      // while we were reading would otherwise be missed.
      if (!added && n >= 1) break;
      if (n >= page.lastPage) break;
    }
    this.store.topAt = new Date().toISOString();
    this.stats.newAtTop += fresh;
    this.stats.steps.push(`top: ${n + 1} pages, ${fresh} new rows`);
    return { done: true, fresh };
  }

  noteTotals(page) {
    if (Number.isInteger(page.total)) this.store.reportedTotal = page.total;
    if (page.lastPage > (this.store.lastPage || 0)) this.store.lastPage = page.lastPage;
  }

  // ---- name searches (full medicines list) --------------------------------------
  tokensFrom(name) {
    const out = new Set();
    for (const word of fold(name).split(/[^A-Z]+/)) {
      if (word.length >= 4 && word.length <= 24 && !STOP_WORDS.has(word)) out.add(word);
    }
    return out;
  }

  // Words from the names in the store (and from any extra names, e.g. the subsidised
  // medicines) that have not been searched yet and still cover a name no search returned.
  nextTokens(extraNames = []) {
    const nameCol = this.store.headers ? this.store.headers.findIndex((h) => /commodity name/i.test(h)) : -1;
    const names = [...extraNames];
    if (nameCol >= 0) for (const row of this.store.rows) names.push(row[nameCol]);
    const tokens = this.store.tokens;
    const counts = new Map();
    const covered = (name) => [...this.tokensFrom(name)].some((t) => tokens[t] && tokens[t].done);
    let uncoveredNames = 0;
    for (const name of names) {
      if (covered(name)) continue;
      uncoveredNames++;
      for (const t of this.tokensFrom(name)) if (!tokens[t]) counts.set(t, (counts.get(t) || 0) + 1);
    }
    // Words shared by many uncovered names first: they settle the most names per search.
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
    return { ordered, uncoveredNames, totalNames: names.length };
  }

  async runSlices(extraNames = []) {
    let searched = 0;
    let rowsFound = 0;
    while (!this.outOfTime()) {
      const { ordered, uncoveredNames } = this.nextTokens(extraNames);
      if (!ordered.length) {
        this.store.slicesDone = true;
        this.stats.steps.push(`searches: nothing left to search (${uncoveredNames} names without a word to search)`);
        return { done: true, searched, rowsFound };
      }
      const token = ordered[0];
      const tokens = this.store.tokens;
      try {
        const first = await this.fetchPage(`field_commodity_name_value=${encodeURIComponent(token)}`, 0);
        this.stats.searches++;
        searched++;
        const total = first.empty ? 0 : first.total || first.rows.length;
        if (total > this.maxSliceRows) {
          tokens[token] = { broad: true, total, at: new Date().toISOString() };
          continue;
        }
        let fresh = first.rows.filter((row) => this.add(row)).length;
        const pages = first.empty ? 0 : Math.max(first.lastPage, Math.ceil(total / 100) - 1);
        let complete = true;
        for (let n = 1; n <= pages; n++) {
          if (this.outOfTime()) {
            complete = false;
            break;
          }
          await sleep(this.pauseMs);
          const page = await this.fetchPage(`field_commodity_name_value=${encodeURIComponent(token)}`, n);
          fresh += page.rows.filter((row) => this.add(row)).length;
        }
        rowsFound += fresh;
        if (complete) tokens[token] = { done: true, total, fresh, at: new Date().toISOString() };
        else {
          this.stats.steps.push(`searches: ${searched} done, ${rowsFound} rows found, stopped during "${token}"`);
          return { done: false, searched, rowsFound };
        }
      } catch (err) {
        if (/out of time/.test(err.message)) break;
        tokens[token] = { failed: true, error: String(err.message).slice(0, 120), at: new Date().toISOString() };
        this.log(`search "${token}" failed: ${err.message}`);
      }
    }
    this.stats.steps.push(`searches: ${searched} done, ${rowsFound} rows found, out of time`);
    this.stats.slicedRows += rowsFound;
    return { done: false, searched, rowsFound };
  }

  // ---- complete read-through, resumed across runs --------------------------------
  passDue(now = Date.now()) {
    if (this.store.resumePage > 0) return true;
    if (this.policy.slices && this.store.complete) return false;
    if (!this.store.fullPassAt) return true;
    return now - Date.parse(this.store.fullPassAt) > this.policy.fullEvery;
  }

  async runPass() {
    const { store, policy } = this;
    if (store.resumePage === 0) store.pass = (store.pass || 0) + 1;
    const pass = store.pass;
    let n = store.resumePage;
    let last = store.lastPage || Infinity;
    const rowsBefore = store.rows.length;
    const pagesBefore = this.stats.pages;
    while (n <= last) {
      if (this.outOfTime()) {
        store.resumePage = n;
        this.stats.steps.push(`pass ${pass}: stopped at page ${n} of ${last}`);
        return { done: false };
      }
      const batch = [];
      while (batch.length < policy.concurrency && n <= last) batch.push(n++);
      const results = await Promise.all(batch.map((p) => this.fetchPage('', p).then((page) => ({ p, page }), (err) => ({ p, err }))));
      results.sort((a, b) => a.p - b.p);
      for (const { p, page, err } of results) {
        if (err) {
          store.resumePage = p;
          this.stats.steps.push(`pass ${pass}: page ${p} failed (${err.message}); will retry next run`);
          return { done: false };
        }
        this.noteTotals(page);
        last = Math.max(page.lastPage, p);
        for (const row of page.rows) this.add(row, pass);
      }
      if (this.pauseMs) await sleep(this.pauseMs);
    }
    store.resumePage = 0;
    store.fullPassAt = new Date().toISOString();
    store.complete = true;
    let dropped = 0;
    if (policy.prune && pass > policy.keepPasses) {
      const keep = [];
      const seen = [];
      store.rows.forEach((row, i) => {
        if (store.seen[i] > pass - policy.keepPasses) {
          keep.push(row);
          seen.push(store.seen[i]);
        } else dropped++;
      });
      store.rows = keep;
      store.seen = seen;
      this.index = new Map(store.rows.map((row, i) => [rowId(row), i]));
    }
    this.stats.dropped += dropped;
    this.stats.passPages += this.stats.pages - pagesBefore;
    this.stats.steps.push(`pass ${pass}: complete, ${store.rows.length - rowsBefore + dropped} new rows, ${dropped} dropped`);
    return { done: true, dropped };
  }

  finish() {
    const { store } = this;
    const dateCol = store.headers ? store.headers.findIndex((h) => /effective/i.test(h)) : -1;
    const order = store.rows.map((row, i) => i).sort((a, b) => {
      const da = dateCol >= 0 ? isoDate(store.rows[a][dateCol]) : '';
      const db = dateCol >= 0 ? isoDate(store.rows[b][dateCol]) : '';
      if (da !== db) return da < db ? 1 : -1;
      const sa = rowId(store.rows[a]);
      const sb = rowId(store.rows[b]);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    store.rows = order.map((i) => store.rows[i]);
    store.seen = order.map((i) => store.seen[i]);
    this.index = new Map(store.rows.map((row, i) => [rowId(row), i]));
    store.fetchedAt = new Date().toISOString();
    store.rowCount = store.rows.length;
    return store;
  }
}

// One row per line keeps the files readable and diff-friendly.
export function serialiseStore(store) {
  const { rows, seen, ...head } = store;
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, '')},\n  "seen": ${JSON.stringify(seen)},\n  "rows": [\n${rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}
