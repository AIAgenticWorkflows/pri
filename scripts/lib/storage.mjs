// Where the collected lists live between runs: a folder (local runs, tests, GitHub)
// or Vercel Blob (the hosted site). Both expose the same three calls.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanToken } from './env.mjs';

export function fileStorage(dir) {
  const file = (name) => path.join(dir, name);
  return {
    kind: 'file',
    async readJson(name) {
      try {
        return JSON.parse(await readFile(file(name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async writeText(name, text) {
      await mkdir(path.dirname(file(name)), { recursive: true });
      await writeFile(file(name), text);
      return file(name);
    },
    async publicUrl() {
      return null;
    },
  };
}

// Vercel Blob, through its SDK. Files keep a fixed name (no random suffix) so the site
// can always find them, and are public because the data itself is public.
export function blobStorage(rawToken = process.env.BLOB_READ_WRITE_TOKEN) {
  const token = cleanToken(rawToken);
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set: connect a Blob store to the project');
  if (!token.startsWith('vercel_blob_rw_')) {
    throw new Error(`BLOB_READ_WRITE_TOKEN does not look like a Blob read-write token (it should start with vercel_blob_rw_, yours starts with ${JSON.stringify(token.slice(0, 8))}); run "npm run check"`);
  }
  let sdk;
  const load = async () => sdk || (sdk = await import('@vercel/blob'));
  const urls = new Map();
  const find = async (name) => {
    if (urls.has(name)) return urls.get(name);
    const { list } = await load();
    const { blobs } = await list({ prefix: name, limit: 5, token });
    const hit = blobs.find((b) => b.pathname === name);
    if (hit) urls.set(name, hit.url);
    return hit ? hit.url : null;
  };
  // Stores are created either public or private. Private ones need the token to
  // read; their URLs contain ".private.". Writes try the store's kind, learnt from
  // the first write (or PRI_BLOB_ACCESS), and switch if Vercel says otherwise.
  let access = process.env.PRI_BLOB_ACCESS === 'private' ? 'private' : process.env.PRI_BLOB_ACCESS === 'public' ? 'public' : null;
  const fetchBlob = async (url) => {
    const isPrivate = /\.private\.blob\.vercel-storage\.com/.test(url);
    const target = new URL(url);
    if (isPrivate) target.searchParams.set('cache', '0');
    else target.searchParams.set('t', String(Date.now()));
    return fetch(target, {
      headers: isPrivate ? { authorization: `Bearer ${token}` } : { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(60000),
    });
  };
  const readText = async (name) => {
    const url = await find(name);
    if (!url) return null;
    const res = await fetchBlob(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob ${name}: HTTP ${res.status}`);
    return res.text();
  };
  return {
    kind: 'blob',
    readText,
    async readJson(name) {
      const text = await readText(name);
      return text === null ? null : JSON.parse(text);
    },
    async writeText(name, text) {
      const { put } = await load();
      const attempt = (mode) =>
        put(name, text, {
          token,
          access: mode,
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json; charset=utf-8',
          cacheControlMaxAge: 60,
        });
      let out;
      try {
        out = await attempt(access || 'public');
      } catch (err) {
        const msg = String(err && err.message);
        // e.g. "Cannot use public access on a private store. The store is configured with private access."
        const tried = access || 'public';
        const other = tried === 'public' && /private (store|access)/i.test(msg) ? 'private' : tried === 'private' && /public (store|access)/i.test(msg) ? 'public' : null;
        if (!other) throw err;
        out = await attempt(other);
        access = other;
      }
      if (!access) access = 'public';
      urls.set(name, out.url);
      return out.url;
    },
    publicUrl: find,
  };
}

export function storageFromEnv(dir) {
  return cleanToken(process.env.BLOB_READ_WRITE_TOKEN) ? blobStorage() : fileStorage(dir);
}
