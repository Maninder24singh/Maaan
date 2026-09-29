'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeSource } = require('../lib/claude');
const { filesFromPart } = require('../lib/opencode');
const { buildModel, mergeVaultProjects } = require('../lib/model');
const { Vault, GENERATED, safeName } = require('../lib/vault');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-'));
const line = o => JSON.stringify(o) + '\n';

test('claude transcript: prompt, files, title, and incremental append', () => {
  const dir = tmp();
  const pdir = path.join(dir, '-work-app');
  fs.mkdirSync(pdir);
  const f = path.join(pdir, 'abc123.jsonl');
  fs.writeFileSync(f,
    line({ type: 'user', cwd: '/work/app', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'build the login page' } }) +
    line({ type: 'user', cwd: '/work/app', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
    line({ type: 'assistant', cwd: '/work/app', timestamp: '2026-01-01T10:05:00Z', message: { content: [
      { type: 'tool_use', name: 'Write', input: { file_path: '/work/app/login.html' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/work/app/ignored.txt' } },
    ] } }));
  const src = new ClaudeSource(dir);
  let [s] = src.scan();
  assert.equal(s.directory, '/work/app');
  assert.equal(s.title, 'build the login page');
  assert.equal(s.prompts, 1);
  assert.deepEqual(s.files, ['/work/app/login.html']);

  // Half-written line is ignored until it is complete.
  fs.appendFileSync(f, '{"type":"summary","summary":"Login page');
  [s] = src.scan();
  assert.equal(s.title, 'build the login page');
  fs.appendFileSync(f, ' work"}\n');
  [s] = src.scan();
  assert.equal(s.title, 'Login page work');
});

test('opencode tool parts: edit, write, apply_patch; reads ignored', () => {
  assert.deepEqual(filesFromPart({ type: 'tool', tool: 'edit', state: { input: { filePath: '/a/b.ts' } } }), ['/a/b.ts']);
  assert.deepEqual(filesFromPart({ type: 'tool', tool: 'read', state: { input: { filePath: '/a/b.ts' } } }), []);
  assert.deepEqual(
    filesFromPart({ type: 'tool', tool: 'apply_patch', state: { input: { patchText: '*** Begin Patch\n*** Update File: src/x.py\n@@\n*** Add File: src/y.py\n' } } }),
    ['src/x.py', 'src/y.py']);
});

test('model nests sub-projects by folder and de-duplicates names', () => {
  const m = buildModel([
    { id: 'cc:1', source: 'claude', directory: 'C:\\Code\\agent', end: 5, files: [] },
    { id: 'oc:2', source: 'opencode', directory: 'c:/code/agent/stt', end: 9, files: [] },
    { id: 'cc:3', source: 'claude', directory: 'C:\\Other\\stt', end: 1, files: [] },
  ]);
  const agent = m.projects.find(p => p.path === 'C:/Code/agent');
  const stt = m.projects.find(p => p.path === 'C:/code/agent/stt');
  assert.equal(stt.parentId, agent.id);
  assert.equal(agent.lastActive, 9);
  assert.deepEqual(m.projects.map(p => p.name).sort(), ['agent', 'stt (Other)', 'stt (agent)']);
});

test('vault writes session and project notes, never touches user notes', () => {
  const dir = tmp();
  const v = new Vault(dir);
  const model = buildModel([{ id: 'cc:abcdef1234', source: 'claude', directory: '/w/app', title: 'first', firstPrompt: 'hi', prompts: 1, start: 1, end: 2, files: ['/w/app/a.js'] }]);
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'Ideas.md'), 'See [[a.js]] and [[Missing]]');
  assert.equal(v.write(model), 2);
  assert.equal(v.write(model), 0, 'second pass writes nothing');
  model.sessions[0].title = 'renamed';
  v.write(model);
  const sessions = fs.readdirSync(path.join(dir, 'app', 'sessions'));
  assert.equal(sessions.length, 1, 'title change renames instead of duplicating');
  assert.match(sessions[0], /renamed \(cc-abcdef12\)\.md$/);
  assert.match(fs.readFileSync(path.join(dir, 'app', 'sessions', sessions[0]), 'utf8'), new RegExp('generated: ' + GENERATED));
  assert.equal(fs.readFileSync(path.join(dir, 'app', 'Ideas.md'), 'utf8'), 'See [[a.js]] and [[Missing]]');
  const notes = v.userNotes(mergeVaultProjects(model, v.folders(), safeName));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].projectId, model.projects[0].id);
  assert.deepEqual(notes[0].links, ['a.js', 'Missing']);
});
