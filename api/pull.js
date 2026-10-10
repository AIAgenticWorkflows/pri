// Starts one slice of the data pull (at most about four minutes of reading from
// pfu.govmu.org), answers at once, and finishes the work in the background.
//
//   GET /api/pull                  rate-limited: at most once every 20 minutes
//   GET /api/pull?token=...        with CRON_SECRET: no rate limit
//   Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" by itself.
//
// Needs a Blob store connected to the project (BLOB_READ_WRITE_TOKEN).

import { runPull } from '../scripts/lib/pull.mjs';
import { blobStorage } from '../scripts/lib/storage.mjs';

const WORK_MS = Number(process.env.PRI_PULL_SECONDS || 235) * 1000;
const MIN_GAP_MS = 20 * 60 * 1000;
const LOCK_MS = 6 * 60 * 1000;

async function seed(key) {
  // The copies committed in the repository, served by the site itself.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) return null;
  try {
    const res = await fetch(`https://${host}/seed/${key}.json`, { signal: AbortSignal.timeout(30000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const send = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  let storage;
  try {
    storage = blobStorage();
  } catch (err) {
    return send(500, { error: 'no-storage', message: err.message });
  }

  const url = new URL(req.url, 'http://localhost');
  const secret = process.env.CRON_SECRET;
  const trusted = Boolean(secret) && (req.headers.authorization === `Bearer ${secret}` || url.searchParams.get('token') === secret);

  const state = (await storage.readJson('state.json')) || {};
  const now = Date.now();
  if (state.lock && now - Date.parse(state.lock.at) < LOCK_MS) return send(409, { error: 'running', since: state.lock.at });
  if (!trusted && state.lastRun && now - Date.parse(state.lastRun.at) < MIN_GAP_MS) {
    return send(429, { error: 'too-soon', lastRun: state.lastRun.at, message: 'The lists were pulled less than 20 minutes ago.' });
  }
  state.lock = { at: new Date(now).toISOString(), by: trusted ? 'scheduled' : 'request' };
  await storage.writeText('state.json', `${JSON.stringify(state, null, 2)}\n`);

  const lists = (url.searchParams.get('lists') || 'p,s,phs,ph').split(',').map((s) => s.trim());
  const work = runPull({ storage, deadlineAt: now + WORK_MS, lists, seed, log: (msg) => console.log(msg) }).catch(async (err) => {
    console.error('pull failed:', err);
    const s = (await storage.readJson('state.json')) || {};
    s.lock = null;
    s.lastError = { at: new Date().toISOString(), message: String(err.message || err).slice(0, 300) };
    await storage.writeText('state.json', `${JSON.stringify(s, null, 2)}\n`);
  });

  // Answer at once and finish in the background. Without waitUntil (package missing),
  // the request simply stays open until the work is done.
  const { waitUntil } = await import('@vercel/functions').catch(() => ({ waitUntil: null }));
  if (waitUntil) {
    waitUntil(work);
    return send(202, { started: true, at: state.lock.at, lists, seconds: Math.round(WORK_MS / 1000), lastRun: state.lastRun ? state.lastRun.at : null });
  }
  await work;
  return send(200, { done: true, at: state.lock.at, lists });
}

export const config = { maxDuration: 300 };
