// Where the collected lists live between runs: a folder (local runs, tests, GitHub)
// or Vercel Blob (the hosted site). Both expose the same three calls.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanToken, findEnv } from './env.mjs';

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

// Supabase Storage: one public bucket holding the same files. Reads are plain downloads
// from the public address; writes use the service key, which stays on the server or on
// the computer running the pull. No per-operation allowance to run out of.
export function supabaseConfig(env = process.env) {
  const url = findEnv(env, ['SUPABASE_URL']);
  const key = findEnv(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);
  return url && key ? { url: url.value.replace(/\/+$/, ''), key: key.value } : null;
}

export function supabaseStorage({ url, key } = supabaseConfig() || {}, bucket = process.env.PRI_BUCKET || 'pri-data') {
  if (!url || !key) throw new Error('Supabase is not set up: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed');
  const path = (name) => name.split('/').map(encodeURIComponent).join('/');
  // Newer Supabase secret keys (sb_secret_...) go in the apikey header only; the older
  // service_role key is a token and also goes in Authorization.
  const headers = key.startsWith('sb_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
  let bucketReady = false;
  const ensureBucket = async () => {
    if (bucketReady) return;
    const res = await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: true, file_size_limit: 50 * 1024 * 1024 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok && res.status !== 409 && !/already exists|Duplicate/i.test(await res.text())) throw new Error(`could not create the storage bucket "${bucket}" (HTTP ${res.status})`);
    bucketReady = true;
  };
  const publicUrl = async (name) => `${url}/storage/v1/object/public/${bucket}/${path(name)}`;
  const readText = async (name) => {
    // Read through the API with the key: always the latest copy, never a cached one.
    const res = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path(name)}?t=${Date.now()}`, { headers, signal: AbortSignal.timeout(60000) });
    if (res.ok) return res.text();
    if ([400, 404].includes(res.status)) return null;
    const body = await res.text();
    if (/not.?found/i.test(body)) return null;
    throw new Error(`storage ${name}: HTTP ${res.status} ${body.slice(0, 120)}`);
  };
  return {
    kind: 'supabase',
    readText,
    async readJson(name) {
      const text = await readText(name);
      return text === null ? null : JSON.parse(text);
    },
    async writeText(name, text) {
      const put = () => fetch(`${url}/storage/v1/object/${bucket}/${path(name)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'x-upsert': 'true', 'cache-control': 'max-age=60' },
        body: text,
        signal: AbortSignal.timeout(120000),
      });
      let res = await put();
      if (!res.ok) {
        const body = await res.text();
        if (/bucket not found/i.test(body) || res.status === 404) {
          await ensureBucket();
          res = await put();
          if (!res.ok) throw new Error(`storage ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        } else throw new Error(`storage ${name}: HTTP ${res.status} ${body.slice(0, 160)}`);
      }
      return publicUrl(name);
    },
    publicUrl,
    async list() {
      const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 100, sortBy: { column: 'name', order: 'asc' } }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`storage list: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const top = await res.json();
      const out = [];
      for (const entry of top) {
        if (entry.id) { out.push({ pathname: entry.name, size: entry.metadata ? entry.metadata.size : 0, uploadedAt: entry.updated_at }); continue; }
        const sub = await fetch(`${url}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `${entry.name}/`, limit: 100 }) });
        if (sub.ok) for (const e of await sub.json()) if (e.id) out.push({ pathname: `${entry.name}/${e.name}`, size: e.metadata ? e.metadata.size : 0, uploadedAt: e.updated_at });
      }
      return out;
    },
  };
}

// Where the data lives: Supabase when it is set up, else Vercel Blob, else a folder.
export function storageFromEnv(dir) {
  if (process.env.PRI_STORAGE === 'file') return fileStorage(dir);
  if (process.env.PRI_STORAGE !== 'blob' && supabaseConfig()) return supabaseStorage();
  return cleanToken(process.env.BLOB_READ_WRITE_TOKEN) ? blobStorage() : fileStorage(dir);
}

export function hostedStorage() {
  if (process.env.PRI_STORAGE !== 'blob' && supabaseConfig()) return supabaseStorage();
  return blobStorage();
}
