// Where the collected lists live between runs: a folder (local runs, tests, GitHub)
// or Vercel Blob (the hosted site). Both expose the same three calls.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
export function blobStorage(token = process.env.BLOB_READ_WRITE_TOKEN) {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set: connect a Blob store to the project');
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
  return {
    kind: 'blob',
    async readJson(name) {
      const url = await find(name);
      if (!url) return null;
      const res = await fetch(`${url}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`blob ${name}: HTTP ${res.status}`);
      return res.json();
    },
    async writeText(name, text) {
      const { put } = await load();
      const out = await put(name, text, {
        token,
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json; charset=utf-8',
        cacheControlMaxAge: 60,
      });
      urls.set(name, out.url);
      return out.url;
    },
    publicUrl: find,
  };
}

export function storageFromEnv(dir) {
  return process.env.BLOB_READ_WRITE_TOKEN ? blobStorage() : fileStorage(dir);
}
