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
  ph: { topEvery: 20 * HOUR, fullEvery: Infinity, keepPasses: 2, concurrency: 1, slices: true, prune: false },
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
  constructor({ key, store, deadlineAt, base = BASE_URL, pauseMs = 300, timeoutMs = 180000, log = () => {}, maxSliceRows = 2500, onProgress = null }) {
    this.onProgress = onProgress; // called now and then during long work, so progress can be saved
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
    if (this._folded && this._folded.length === this.store.rows.length - 1) {
      const col = this.nameColumn();
      this._folded.push(col < 0 ? '' : fold(row[col]).replace(/\s+/g, ' '));
    }
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
          // A search with no match still shows the list's frame ("view ..."), just without
          // results. A page without that frame is something else (an error or a block page):
          // treating it as "no match" would silently lose rows.
          if (query && /class="[^"]*\bview\b[^"]*view-id-|class="view /.test(html) && !/view-content/.test(html)) return { ...parsed, rows: [], ms: Date.now() - t0, empty: true };
          if (query) throw new Error(`unexpected page for a search (${html.length} bytes): ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}`);
          throw new Error(`no results table in the response (${html.length} bytes)`);
        }
        if (!this.store.headers) this.store.headers = parsed.headers;
        else if (parsed.headers.length !== this.store.headers.length) throw new Error(`the table changed shape: ${parsed.headers.join(' | ')}`);
        return { ...parsed, ms: Date.now() - t0 };
      } catch (err) {
        lastError = err;
        this.log(`page ${page}${query ? ` (${query})` : ''}: attempt ${attempt} failed: ${err.message}`);
        // A page that took the site over 50 seconds to fail will fail again: do not retry.
        if (attempt < retries && this.timeLeft() > 30000 && Date.now() - t0 < 50000) await sleep(3000 * attempt);
        else break;
      }
    }
    throw lastError;
  }

  // ---- top of the list ------------------------------------------------------------
  topDue(now = Date.now()) {
    // An empty store is filled by a read-through (or, for the medicines list, by name
    // searches): reading its slow unfiltered first page would gain nothing.
    if (!this.store.rows.length) return false;
    // The full medicines list's first page is too slow for the site to answer; it is kept
    // current by refreshCover instead.
    if (this.policy.slices) return false;
    return !this.store.topAt || now - Date.parse(this.store.topAt) > this.policy.topEvery;
  }

  async readTop(maxPages = 15) {
    this.log('reading the newest rows');
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
      const { ordered, uncoveredNames, totalNames } = this.nextTokens(extraNames);
      if (!totalNames) {
        // No names yet to take words from (the subsidised medicines list is still empty):
        // try again on a later run rather than calling the searches finished.
        this.stats.steps.push('searches: waiting for medicine names to search');
        return { done: false, searched, rowsFound };
      }
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
        if (!complete) {
          this.stats.steps.push(`searches: ${searched} done, ${rowsFound} rows found, stopped during "${token}"`);
          return { done: false, searched, rowsFound };
        }
        tokens[token] = { done: true, total, fresh, at: new Date().toISOString() };
        if (this.onProgress && searched % 10 === 0) await this.onProgress();
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

  // ---- complete coverage by text searches (full medicines list) -------------------
  //
  // Word searches only find names that share a word with a name already known. To be
  // sure of getting every row, search pieces of text instead: every name contains at
  // least one character, so searching each character covers everything. A search that
  // matches too many rows is split into longer pieces (q + each character), and a piece
  // whose rows are all already known (the site's "of N" equals the rows we hold that
  // contain it) needs no further reading. Names where the piece only appears at the
  // very end are not reached by q + character, so a split piece that is still short of
  // rows afterwards is also searched as character + q.
  //
  // The work list is kept in the store (store.cover) and carries on across runs.

  coverDue() {
    if (!this.policy.slices) {
      // The smaller lists are read page by page, and that paging misses rows now and then.
      // When we hold fewer rows than the site reports, text searches find the missing ones
      // (at most once a day; a search started earlier is always finished).
      const { cover, reportedTotal } = this.store;
      if (cover && cover.version === 3 && !cover.doneAt) return true;
      if (!reportedTotal || this.store.rows.length >= reportedTotal) return false;
      return !(cover && cover.version === 3 && cover.doneAt && Date.now() - Date.parse(cover.doneAt) < 20 * HOUR);
    }
    return !(this.store.cover && this.store.cover.version === 3 && this.store.cover.doneAt);
  }

  nameColumn() {
    return this.store.headers ? this.store.headers.findIndex((h) => /commodity name/i.test(h)) : -1;
  }

  foldedNames() {
    const col = this.nameColumn();
    if (!this._folded || this._folded.length !== this.store.rows.length) {
      this._folded = col < 0 ? [] : this.store.rows.map((row) => fold(row[col]).replace(/\s+/g, ' '));
    }
    return this._folded;
  }

  // How many rows we hold whose name contains q (the site matches ignoring case and accents).
  // How the site's name search matches is learnt from what it returns: names that
  // start with the text, names with a word starting with it, or names containing it.
  // Until a result rules a narrower rule out, the narrowest is assumed, so we never
  // believe we hold rows that we do not.
  matches(name, q) {
    const mode = this.matchMode();
    if (mode === 'start') return name.startsWith(q);
    if (mode === 'word') return name.startsWith(q) || name.includes(` ${q}`) || new RegExp(`[^A-Z0-9]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name);
    return name.includes(q);
  }
  matchMode() {
    const ruled = (this.store.matchRuledOut || []);
    return ['start', 'word', 'contains'].find((m) => !ruled.includes(m)) || 'contains';
  }
  learnMatch(q, rows) {
    const col = this.nameColumn();
    if (col < 0 || !rows.length) return;
    const ruled = new Set(this.store.matchRuledOut || []);
    const before = this.matchMode();
    for (const row of rows) {
      const name = fold(row[col]).replace(/\s+/g, ' ');
      if (!name.startsWith(q)) ruled.add('start');
      const wordStart = name.startsWith(q) || new RegExp(`[^A-Z0-9]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name);
      if (!wordStart && name.includes(q)) ruled.add('word');
    }
    this.store.matchRuledOut = [...ruled];
    if (this.matchMode() !== before) this.log(`the site's name search matches by "${this.matchMode()}"`);
  }
  localCount(q) {
    let n = 0;
    for (const name of this.foldedNames()) if (this.matches(name, q)) n++;
    return n;
  }

  coverAlphabet(extraNames) {
    const counts = new Map();
    const names = [...this.foldedNames(), ...extraNames.map((s) => fold(s))];
    for (const name of names) for (const ch of new Set(name)) counts.set(ch, (counts.get(ch) || 0) + 1);
    // Letters and digits always; other characters when they are common enough. Space, %
    // and _ are left out (% and _ are wildcards in the site's search, and a leading or
    // trailing space may be trimmed).
    const out = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    for (const [ch, n] of counts) if (n >= 20 && !/[\s%_\\]/.test(ch)) out.add(ch);
    return [...out].sort().join('');
  }

  async runCover(extraNames = []) {
    const store = this.store;
    // Searches made before empty pages were told apart from error pages may have been
    // counted as "no match": start the text searches again (the rows found are kept).
    if (store.cover && store.cover.doneAt && !this.policy.slices) store.cover = null;
    if (store.cover && store.cover.version !== 3) {
      this.log('text searches: starting again with the stricter check');
      store.cover = null;
      store.complete = false;
    }
    if (!store.cover) {
      const alphabet = this.coverAlphabet(extraNames);
      store.cover = { version: 3, alphabet, stack: [...alphabet].reverse().map((q) => ({ q, step: 'search' })), nodes: {}, searches: 0, startedAt: new Date().toISOString(), doneAt: null };
    }
    const cover = store.cover;
    const alphabet = [...cover.alphabet];
    const tolerance = (t) => Math.max(1, Math.floor(t * 0.002)); // exact duplicate rows on the site
    const short = (node) => node.t === null || this.localCount(node.q) < node.t - tolerance(node.t);
    let searched = 0;
    const rowsBefore = store.rows.length;
    const query = (q) => `field_commodity_name_value=${encodeURIComponent(q)}`;

    while (cover.stack.length) {
      if (this.outOfTime()) break;
      const item = cover.stack.pop();
      const node = cover.nodes[item.q] || (cover.nodes[item.q] = { q: item.q, t: null, state: 'new', reads: 0 });

      if (item.step === 'check') {
        // After the longer pieces q + character: anything still missing ends with q.
        if (node.t === null && node.left) node.state = 'ok'; // too broad to count; both sides searched
        else if (short(node) && !node.left && node.q.length < 30) {
          node.left = true;
          cover.stack.push({ q: node.q, step: 'check' });
          for (const ch of [...alphabet].reverse()) cover.stack.push({ q: ch + node.q, step: 'search' });
        } else if (node.state !== 'ok') node.state = short(node) ? 'gap' : 'ok';
        continue;
      }

      // The same piece can be reached twice (AB from A, and from B searched on its left).
      if (!item.again && node.state !== 'new') continue;
      let first;
      try {
        if (this.timeLeft() < 30000) {
          cover.stack.push(item);
          break;
        }
        first = await this.fetchPage(query(node.q), 0);
        searched++;
        cover.searches++;
      } catch (err) {
        if (/out of time/.test(err.message) || this.timeLeft() < 20000) {
          // Cut short by our own deadline, not by the site: try again next run.
          cover.stack.push(item);
          break;
        }
        // Too many matches for the site to answer in time: split without knowing the count.
        node.state = 'split';
        node.t = null;
        node.error = String(err.message).slice(0, 80);
        cover.stack.push({ q: node.q, step: 'check' });
        for (const ch of [...alphabet].reverse()) cover.stack.push({ q: node.q + ch, step: 'search' });
        continue;
      }
      node.t = first.empty ? 0 : first.total || first.rows.length;
      node.at = new Date().toISOString();
      this.learnMatch(node.q, first.rows);
      for (const row of first.rows) this.add(row);
      if (process.env.PRI_DEBUG) this.log(`search "${node.q}": ${node.t} matches, ${first.ms} ms, ${this.localCount(node.q)} held (${this.matchMode()})`);
      if (!short(node)) {
        node.state = 'ok';
      } else if (node.t > this.maxSliceRows || (node.reads >= 2 && node.t > 100)) {
        // Too many to read page by page, or paging keeps missing rows: split.
        node.state = 'split';
        cover.stack.push({ q: node.q, step: 'check' });
        for (const ch of [...alphabet].reverse()) cover.stack.push({ q: node.q + ch, step: 'search' });
      } else {
        const pages = Math.max(first.lastPage, Math.ceil(node.t / 100) - 1);
        let finished = true;
        for (let n = 1; n <= pages; n++) {
          if (this.outOfTime()) {
            finished = false;
            break;
          }
          await sleep(this.pauseMs);
          try {
            const page = await this.fetchPage(query(node.q), n);
            for (const row of page.rows) this.add(row);
          } catch (err) {
            finished = false;
            break;
          }
        }
        node.reads++;
        if (!finished) cover.stack.push({ q: node.q, step: 'search', again: true });
        else if (short(node)) cover.stack.push({ q: node.q, step: 'search', again: true });
        else node.state = 'ok';
      }
      if (this.onProgress && searched % 20 === 0) {
        this.log(`text searches: ${cover.searches} so far, ${store.rows.length} rows, ${cover.stack.length} to go`);
        await this.onProgress();
      }
      if (this.pauseMs) await sleep(this.pauseMs);
    }

    const found = store.rows.length - rowsBefore;
    this.stats.searches += searched;
    if (!cover.stack.length) {
      cover.doneAt = new Date().toISOString();
      if (this.policy.slices) {
        store.complete = true;
        store.fullPassAt = cover.doneAt;
      }
      const gaps = Object.values(cover.nodes).filter((n) => n.state === 'gap').length;
      this.stats.steps.push(`text searches: complete after ${cover.searches}, ${found} new rows this run${gaps ? `, ${gaps} pieces still short` : ''}`);
      return { done: true };
    }
    this.stats.steps.push(`text searches: ${searched} this run, ${found} new rows, ${cover.stack.length} still to search`);
    return { done: false };
  }

  // Once complete: look again at the smaller pieces, oldest first, and read any whose
  // count grew (new batches). Keeps the medicines list current without the slow first page.
  async refreshCover(maxSearches = Infinity) {
    const cover = this.store.cover;
    if (!cover || !cover.doneAt) return { done: false };
    const leaves = Object.values(cover.nodes)
      .filter((n) => n.state === 'ok' && n.t !== null && n.t <= this.maxSliceRows && n.t > 0)
      .sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    let checked = 0;
    let grown = 0;
    const rowsBefore = this.store.rows.length;
    for (const node of leaves) {
      if (this.outOfTime() || checked >= maxSearches || this.timeLeft() < 60000) break;
      const q = `field_commodity_name_value=${encodeURIComponent(node.q)}`;
      let first;
      try {
        first = await this.fetchPage(q, 0, 1);
      } catch {
        break;
      }
      checked++;
      const t = first.empty ? 0 : first.total || first.rows.length;
      for (const row of first.rows) this.add(row);
      node.at = new Date().toISOString();
      if (t !== node.t || this.localCount(node.q) < t - Math.max(1, Math.floor(t * 0.002))) {
        grown++;
        node.t = t;
        const pages = Math.max(first.lastPage, Math.ceil(t / 100) - 1);
        for (let n = 1; n <= pages && !this.outOfTime(); n++) {
          await sleep(this.pauseMs);
          try {
            const page = await this.fetchPage(q, n);
            for (const row of page.rows) this.add(row);
          } catch {
            break;
          }
        }
      }
      if (this.pauseMs) await sleep(this.pauseMs);
    }
    this.store.topAt = new Date().toISOString();
    this.stats.steps.push(`refresh: ${checked} of ${leaves.length} searches looked at again, ${grown} had changed, ${this.store.rows.length - rowsBefore} new rows`);
    return { done: true };
  }

  // ---- complete read-through, resumed across runs --------------------------------
  passDue(now = Date.now()) {
    // The full medicines list is covered by searches: its unfiltered pages are too slow
    // for the site to answer.
    if (this.policy.slices) return false;
    if (this.store.resumePage > 0) return true;
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
      if (n % 10 < policy.concurrency) this.log(`read-through: page ${n} of ${last + 1}, ${store.rows.length} rows`);
      if (this.onProgress && n % 10 < policy.concurrency) {
        store.resumePage = n; // so a saved copy can carry on from here
        await this.onProgress();
      }
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
