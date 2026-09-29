'use strict';
const http = require('http');
const crypto = require('crypto');

// Tiny HTTP server on 127.0.0.1 so the browser extension can save pages into the vault.
// - Listens on the loopback address only: nothing outside this PC can reach it.
// - Every request needs the pairing key shown in the app.
// - Web pages cannot call it: only browser-extension origins get CORS headers.
const EXT_ORIGIN = /^(chrome|moz|edge|safari-web)-extension:\/\//;
const MAX_BODY = 2 * 1024 * 1024;

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

class Clipper {
  constructor({ port, token, onClip, listProjects }) {
    this.port = port;
    this.token = token;
    this.onClip = onClip;
    this.listProjects = listProjects;
    this.server = null;
    this.lastClip = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  stop() {
    return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  handle(req, res) {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (origin && EXT_ORIGIN.test(origin)) {
        headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-headers'] = 'content-type, x-vault-token';
        headers['access-control-allow-methods'] = 'GET, POST';
        headers.vary = 'origin';
      }
      res.writeHead(status, headers);
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (origin && !EXT_ORIGIN.test(origin)) return send(403, { error: 'Only the Memory Vault browser extension can save here.' });
    if (req.method === 'OPTIONS') return send(204);
    if (!sameToken(req.headers['x-vault-token'], this.token)) return send(401, { error: 'Wrong or missing key. Copy the key from the Memory Vault app.' });

    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/ping') return send(200, { ok: true, app: 'memory-vault' });
    if (req.method === 'GET' && url.pathname === '/projects') return send(200, { projects: this.listProjects() });
    if (req.method === 'POST' && url.pathname === '/clip') {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { send(413, { error: 'Too big. Save a smaller selection.' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size > MAX_BODY) return;
        let clip;
        try { clip = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Bad request.' }); }
        if (!clip || (!clip.text && !clip.url)) return send(400, { error: 'Nothing to save.' });
        if (clip.url && !/^https?:\/\//i.test(clip.url)) clip.url = null;
        try {
          const saved = this.onClip({
            title: String(clip.title || '').slice(0, 300),
            url: clip.url ? String(clip.url).slice(0, 2000) : null,
            text: String(clip.text || '').slice(0, 200000),
            project: typeof clip.project === 'string' ? clip.project : '',
          });
          this.lastClip = Date.now();
          send(200, { ok: true, file: saved.file });
        } catch (e) {
          send(500, { error: e.message });
        }
      });
      return undefined;
    }
    return send(404, { error: 'Not found.' });
  }
}

module.exports = { Clipper, newToken, sameToken };
