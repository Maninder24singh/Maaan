'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { LocalAI } = require('../lib/ai');
const { Assistant } = require('../lib/assistant');

// Fake Ollama that plays a fixed script of tool calls.
function fakeOllama(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b' }] }));
      const b = JSON.parse(body);
      seen.push(b);
      res.end(JSON.stringify({ message: script(b, seen.length) }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('assistant: finds an app, proposes opening it, never opens by itself', async () => {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-apps-'));
  fs.writeFileSync(path.join(apps, 'Notepad.lnk'), '');
  fs.writeFileSync(path.join(apps, 'Spotify.lnk'), '');
  const mock = await fakeOllama((b, n) => {
    if (n === 1) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'find_app', arguments: { name: 'notepad' } } }] };
    if (n === 2) {
      const found = JSON.parse(b.messages[b.messages.length - 1].content);
      return { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'open_app', arguments: { path: found[0].path } } },
        { function: { name: 'open_path', arguments: { path: 'C:\\made\\up.exe' } } },
      ] };
    }
    return { role: 'assistant', content: '<think>x</think>Notepad is ready to open.' };
  });
  try {
    const ai = new LocalAI({ url: mock.url, model: 'qwen2.5:3b' });
    assert.equal((await ai.status()).hasModel, true);
    const a = new Assistant({ ai, getData: () => ({ projects: [], sessions: [], notes: [] }), vault: () => null, appDirs: [apps] });
    const r = await a.ask([], 'open notepad');
    assert.equal(r.reply, 'Notepad is ready to open.');
    assert.equal(r.actions.length, 1, 'made-up path is refused');
    assert.equal(r.actions[0].tool, 'open_app');
    assert.equal(r.actions[0].target, path.join(apps, 'Notepad.lnk'));
    assert.ok(mock.seen[0].tools.find(t => t.function.name === 'search_vault'));
    const lastTool = mock.seen[2].messages.filter(m => m.role === 'tool').pop();
    assert.match(lastTool.content, /did not come from a search/);
    assert.equal(r.history.length, 2);
  } finally {
    mock.server.close();
  }
});

test('assistant: vault search finds notes and sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-s-'));
  const note = path.join(dir, 'Latency plan.md');
  fs.writeFileSync(note, '# Latency\n\nStream whisper output into the LLM early.');
  const data = {
    projects: [{ id: 'p1', name: 'voice-agent', path: '/w/voice-agent', about: '', sessionCount: 1 }],
    sessions: [{ id: 's1', projectId: 'p1', source: 'claude', title: 'faster-whisper int8', firstPrompt: 'switch to faster-whisper', files: ['/w/x.py'] }],
    notes: [{ id: 'n1', title: 'Latency plan', file: note, kind: 'note', projectId: 'p1' }],
  };
  const a = new Assistant({ ai: null, getData: () => data, vault: () => null });
  const hits = a.run('search_vault', { query: 'whisper' });
  assert.deepEqual(hits.map(h => h.type).sort(), ['Claude Code session', 'note']);
  assert.equal(a.describeAction('open_path', { path: note }).target, note, 'search results can be opened');
  assert.ok(a.describeAction('open_url', { url: 'file:///etc/passwd' }).error);
});
