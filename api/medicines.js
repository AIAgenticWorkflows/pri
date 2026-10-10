// Live search of the full official medicines list.
//
// That list holds about 57,000 batches and the government site needs over a minute to
// serve one unfiltered page of it, so it is not copied onto this site. A search by name
// answers in about a second, so each query is passed on to the official site and the
// answer is kept by the CDN for a few hours.
//
//   GET /api/medicines?q=panadol

import { BASE_URL, LISTS, parsePage } from '../scripts/lib/pfu.mjs';
import { MEDICINE_CLASSES, buildMedicines } from '../scripts/lib/model.mjs';

const MAX_PAGES = 6;
const USER_AGENT = 'Mozilla/5.0 (compatible; PriBot/1.0; +https://www.aplica.biz)';

/** Letters, digits and the few signs medicine names use; at least 3 letters or digits. */
export function cleanQuery(raw) {
  const q = String(raw || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .\-+/%]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return q.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? q : '';
}

export async function searchMedicines(q, { base = process.env.PRI_BASE_URL || BASE_URL, timeoutMs = 12000 } = {}) {
  const url = `${base}${LISTS.ph.path}?field_commodity_name_value=${encodeURIComponent(q)}`;
  const get = async (n) => {
    const res = await fetch(n ? `${url}&page=${n}` : url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`official list answered HTTP ${res.status}`);
    return parsePage(await res.text());
  };
  const page = await get(0);
  const rows = page.hasTable ? page.rows.slice() : []; // no table means no match
  // A name search returns 100 rows a page; read up to MAX_PAGES so every strength shows.
  const more = page.hasTable ? Math.min(page.lastPage, MAX_PAGES - 1) : 0;
  if (more > 0) {
    const pages = await Promise.all(Array.from({ length: more }, (_, i) => get(i + 1).catch(() => null)));
    for (const extra of pages) if (extra && extra.hasTable) rows.push(...extra.rows);
  }
  const { items } = buildMedicines([{ list: 'ph', headers: page.headers, rows }]);
  const classIndex = new Map(MEDICINE_CLASSES.map((id, i) => [id, i]));
  return {
    q,
    total: page.total ?? rows.length,
    rows: rows.length,
    classes: MEDICINE_CLASSES,
    items: items.map((m) => [m.name, classIndex.get(m.cls), m.sub, m.brand, m.batches]),
  };
}

export default async function handler(req, res) {
  const q = cleanQuery(new URL(req.url, 'http://localhost').searchParams.get('q'));
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!q) {
    res.statusCode = 400;
    res.setHeader('cache-control', 'public, s-maxage=86400');
    res.end(JSON.stringify({ error: 'short', message: 'Type at least 3 letters or digits.' }));
    return;
  }
  try {
    const data = await searchMedicines(q);
    res.statusCode = 200;
    res.setHeader('cache-control', 'public, s-maxage=21600, stale-while-revalidate=604800');
    res.end(JSON.stringify(data));
  } catch (err) {
    const slow = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    res.statusCode = slow ? 504 : 502;
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: slow ? 'slow' : 'unavailable', message: slow ? 'The official list took too long. A longer name answers faster.' : 'The official list did not answer.' }));
  }
}
