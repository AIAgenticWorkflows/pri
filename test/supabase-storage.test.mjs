import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { supabaseStorage } from '../scripts/lib/storage.mjs';

// A small stand-in for the Supabase Storage API.
function startStorageMock() {
  const buckets = new Set();
  const files = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push(`${req.method} ${url.pathname} ${req.headers.apikey ? 'key' : 'nokey'}`);
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname === '/storage/v1/bucket') { buckets.add(JSON.parse(body).id); return send(200, { name: 'ok' }); }
      let m = /^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) return files.has(`${m[1]}/${decodeURIComponent(m[2])}`) ? send(200, files.get(`${m[1]}/${decodeURIComponent(m[2])}`)) : send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      m = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const { prefix } = JSON.parse(body);
        const names = [...files.keys()].filter((k) => k.startsWith(`${m[1]}/${prefix}`)).map((k) => k.slice(m[1].length + 1 + prefix.length));
        const top = [...new Set(names.map((n) => n.split('/')[0]))];
        return send(200, top.map((n) => (names.includes(n) ? { name: n, id: n, metadata: { size: files.get(`${m[1]}/${prefix}${n}`).length }, updated_at: new Date().toISOString() } : { name: n, id: null })));
      }
      m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        if (!buckets.has(m[1])) return send(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
        files.set(`${m[1]}/${decodeURIComponent(m[2])}`, body);
        return send(200, { Key: m[2] });
      }
      return send(404, { message: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, files, calls })));
}

test('Supabase storage: creates its bucket, writes, reads, lists', async () => {
  const mock = await startStorageMock();
  try {
    const s = supabaseStorage({ url: mock.url, key: 'sb_secret_test' });
    assert.equal(await s.readJson('state.json'), null);
    await s.writeText('state.json', '{"runs":1}');
    await s.writeText('stores/p.json', '{"rows":[]}');
    assert.deepEqual(await s.readJson('state.json'), { runs: 1 });
    const names = (await s.list()).map((f) => f.pathname).sort();
    assert.deepEqual(names, ['state.json', 'stores/p.json']);
    assert.ok(mock.calls.every((c) => c.endsWith(' key')));
  } finally {
    mock.server.close();
  }
});
