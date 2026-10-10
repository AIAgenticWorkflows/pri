// Serves the files the page loads (/data/groceries.json, /data/medicines.json,
// /data/meta.json) from Blob storage, where the data pull writes them. Until a Blob
// store exists, or for a file the pull has not written yet, the copy built into the
// site at deploy time (/seed-data/) is used instead.

import { blobStorage } from '../scripts/lib/storage.mjs';

const FILES = new Set(['groceries.json', 'medicines.json', 'meta.json']);

export default async function handler(req, res) {
  const file = new URL(req.url, 'http://localhost').searchParams.get('file') || '';
  if (!FILES.has(file)) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not-found' }));
    return;
  }
  const fallback = () => {
    res.statusCode = 302;
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
    res.setHeader('location', `/seed-data/${file}`);
    res.end();
  };
  if (!process.env.BLOB_READ_WRITE_TOKEN) return fallback();
  try {
    const url = await blobStorage().publicUrl(`data/${file}`);
    if (!url) return fallback();
    const upstream = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!upstream.ok) return fallback();
    const body = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=120, s-maxage=900, stale-while-revalidate=86400');
    res.setHeader('x-pri-source', 'blob');
    res.end(body);
  } catch (err) {
    console.error('data route:', err);
    return fallback();
  }
}
