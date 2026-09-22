// Zero-dependency HTTP server (Node's built-in `http` module — no Express).
// Serves the front-end from ./public and the JSON API under /api/*, backed by
// the real SQLite database in ./data and the server-side match engine.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { matchRoute, requireAuth, json, startEngine } = require('./routes');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback — the front-end is a single page.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, buf2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf2);
      });
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Permissive CORS so the front-end can be hosted separately from the API
  // during development (e.g. opened straight from disk) if you ever split them.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const query = Object.fromEntries(url.searchParams.entries());
  const found = matchRoute(req.method, pathname);
  if (!found) return json(res, 404, { error: 'Not found' });

  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') {
    try { body = await readBody(req); } catch { return json(res, 413, { error: 'Payload too large' }); }
  }

  if (found.route.auth) {
    const user = requireAuth(req);
    if (!user) return json(res, 401, { error: 'Sign in required.' });
    if (found.route.admin && !user.is_admin) return json(res, 403, { error: 'Admin access required.' });
    req.user = user;
  }

  try {
    found.route.handler(req, res, found.params, body, query);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Server error.' });
  }
});

startEngine();
server.listen(PORT, () => {
  console.log(`StakeBet backend running → http://localhost:${PORT}`);
  console.log(`SQLite database at ./data/stakebet.sqlite`);
});
