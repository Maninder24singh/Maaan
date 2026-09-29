'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// features.js needs Electron. Give it a fake whose clipboard works like Electron 44:
// readText() and writeText() return Promises.
let clip = '';
let shortcut = null;
const fakeElectron = {
  shell: {},
  clipboard: { readText: async () => clip, writeText: async t => { clip = t; } },
  globalShortcut: { register: (_a, fn) => { shortcut = fn; return true; }, unregister() {}, unregisterAll() {} },
  Notification: class { static isSupported() { return false; } },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : load.call(this, request, ...rest); };
const { createFeatures } = require('../lib/features');
Module._load = load;

const { Vault } = require('../lib/vault');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-feat-'));
  const toasts = [];
  const settings = { hotkey: { enabled: true, accel: 'CommandOrControl+Shift+M' } };
  const f = createFeatures({
    getSettings: () => settings,
    saveSettings: () => {},
    getEngine: () => ({ vault: new Vault(dir) }),
    getData: () => ({ projects: [], notes: [], sessions: [] }),
    refresh: () => {},
    toast: t => toasts.push(t),
  });
  return { dir, f, toasts };
}

test('clipboard key: text and links are saved to Inbox/clips (Promise clipboard)', async () => {
  const { dir, f, toasts } = setup();
  clip = '  Capacitive sensors last longer.\nSecond line  ';
  const r = await f.saveClipboard();
  assert.ok(r && fs.existsSync(r.file));
  assert.match(r.file, /Inbox[\\/]clips[\\/]/);
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /type: clip/);
  assert.match(text, /> Capacitive sensors last longer\./);

  clip = 'https://example.com/page';
  const r2 = await f.saveClipboard();
  assert.match(fs.readFileSync(r2.file, 'utf8'), /source_url: https:\/\/example\.com\/page/);
  assert.equal(fs.readdirSync(path.join(dir, 'Inbox', 'clips')).length, 2);
  assert.ok(toasts.length >= 2);
});

test('clipboard key: empty clipboard shows a message and saves nothing', async () => {
  const { dir, f, toasts } = setup();
  clip = '   ';
  assert.equal(await f.saveClipboard(), null);
  assert.match(toasts[0], /empty/i);
  assert.equal(fs.existsSync(path.join(dir, 'Inbox')), false);
});

test('clipboard key: pressing the registered shortcut saves the clip', async () => {
  const { dir, f } = setup();
  await f.setFeature('hotkey', { enabled: true });
  assert.equal(typeof shortcut, 'function');
  clip = 'pressed from the shortcut';
  shortcut();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readdirSync(path.join(dir, 'Inbox', 'clips')).length, 1);
});
