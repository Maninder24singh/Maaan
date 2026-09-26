'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Clipper, newToken } = require('../lib/clipper');

test('clipper: key required, web pages refused, extension allowed', async () => {
  const saved = [];
  const token = newToken();
  const c = new Clipper({ port: 0, token, onClip: clip => { saved.push(clip); return { file: '/v/x.md' }; }, listProjects: () => [{ name: 'A', rel: 'A' }] });
  const port = await c.start();
  const base = `http://127.0.0.1:${port}`;
  const ext = 'chrome-extension://abcdefgh';
  try {
    let r = await fetch(base + '/ping');
    assert.equal(r.status, 401);

    r = await fetch(base + '/clip', { method: 'POST', headers: { origin: 'https://evil.example', 'x-vault-token': token, 'content-type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(r.status, 403, 'a web page is refused even with the key');

    r = await fetch(base + '/clip', { method: 'OPTIONS', headers: { origin: ext } });
    assert.equal(r.headers.get('access-control-allow-origin'), ext);

    r = await fetch(base + '/projects', { headers: { origin: ext, 'x-vault-token': token } });
    assert.deepEqual((await r.json()).projects, [{ name: 'A', rel: 'A' }]);

    r = await fetch(base + '/clip', { method: 'POST', headers: { origin: ext, 'x-vault-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', url: 'javascript:alert(1)', text: 'hello', project: 'A' }) });
    assert.equal(r.status, 200);
    assert.equal(saved[0].url, null, 'non-http URLs are dropped');
    assert.equal(saved[0].project, 'A');
  } finally {
    await c.stop();
  }
});
