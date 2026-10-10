#!/usr/bin/env node
// Local preview: serves site/, the data files and the medicines search the way the published site does.
//
//   node scripts/dev-server.mjs            http://localhost:4173
//   PORT=8080 node scripts/dev-server.mjs

import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import medicines from '../api/medicines.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
// /data/* comes from the last local pull (data/store/data/), like Blob on the hosted site,
// or from the copy built from the seeds (site/seed-data/).
const DATA_DIRS = [path.join(ROOT, 'data', 'store', 'data'), path.join(SITE, 'seed-data')];
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/medicines') return medicines(req, res);
    let file;
    const data = /^\/data\/([a-z]+\.json)$/.exec(url.pathname);
    if (data) file = DATA_DIRS.map((dir) => path.join(dir, data[1])).find((f) => existsSync(f)) || path.join(SITE, 'missing');
    else {
      file = path.join(SITE, path.normalize(decodeURIComponent(url.pathname)));
      if (!file.startsWith(SITE)) return res.writeHead(403).end();
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createServer().listen(port, () => console.log(`Pri Max preview on http://localhost:${port}`));
}
