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
  // Reading never goes through the Blob API: a file's address follows from the store ID
  // in the token, and fetching it is a plain download, not one of the "advanced
  // operations" the free plan counts. Only writing uses the API.
  // Stores are either public or private (private ones are read with the token); the
  // kind is learnt from the first read or write, or set with PRI_BLOB_ACCESS.
  const storeId = token.split('_')[3] || '';
  let access = process.env.PRI_BLOB_ACCESS === 'private' ? 'private' : process.env.PRI_BLOB_ACCESS === 'public' ? 'public' : null;
  const urlFor = (kind, name) => `https://${storeId}.${kind}.blob.vercel-storage.com/${name.split('/').map(encodeURIComponent).join('/')}`;
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
    const kinds = access ? [access] : ['private', 'public'];
    for (const kind of kinds) {
      const res = await fetchBlob(urls.get(name) || urlFor(kind, name));
      if (res.ok) {
        if (!access) access = kind;
        return res.text();
      }
      if ([400, 401, 403, 404].includes(res.status)) continue;
      throw new Error(`blob ${name}: HTTP ${res.status}`);
    }
    return null;
  };
  const find = async (name) => urls.get(name) || urlFor(access || 'private', name);
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
