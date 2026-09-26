'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, safeName } = require('../lib/vault');
const { buildModel, mergeVaultProjects } = require('../lib/model');
const { analyzeMarkdown, analyzeFolder } = require('../lib/analyze');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mv-imp-'));

test('markdown analysis: title, headings, tags, mentions of known names', () => {
  const a = analyzeMarkdown('# Voice plan\n\nUse whisper and #latency tricks with voice-agent.\n\n## Steps\n- [ ] add VAD\n', 'x.md', ['voice-agent', 'website', 'Voice plan']);
  assert.equal(a.title, 'Voice plan');
  assert.deepEqual(a.headings, ['Steps']);
  assert.deepEqual(a.tags, ['latency']);
  assert.deepEqual(a.mentions, ['voice-agent']);
  assert.equal(a.tasks, 1);
});

test('folder analysis reads manifest, README and languages, skips node_modules', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'bot', description: 'A chat bot', dependencies: { express: '1' } }));
  fs.writeFileSync(path.join(d, 'README.md'), '# Bot\n\nIgnored because package.json has a description.');
  fs.writeFileSync(path.join(d, 'index.js'), '');
  fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'a.js'), '');
  const a = analyzeFolder(d);
  assert.equal(a.about, 'A chat bot');
  assert.equal(a.files, 3);
  assert.deepEqual(a.manifest.uses, ['express']);
  assert.ok(a.languages.find(l => l.name === 'JavaScript'));
});

test('drop: md becomes a new project, second md goes into it, folders nest as sub-projects', () => {
  const vdir = tmp(), src = tmp();
  const v = new Vault(vdir);
  fs.writeFileSync(path.join(src, 'plan.md'), '# Garden Robot\n\nIt waters plants. See website for docs.\n');
  const r1 = v.importMarkdown(path.join(src, 'plan.md'), null, ['website']);
  assert.deepEqual(r1.rel, ['Garden Robot']);
  const text = fs.readFileSync(r1.file, 'utf8');
  assert.match(text, /^---\nimported_from: /);
  assert.match(text, /## Related\n- \[\[website\]\]/);

  fs.writeFileSync(path.join(src, 'parts.md'), 'motors and pumps');
  const r2 = v.importMarkdown(path.join(src, 'parts.md'), r1.rel);
  assert.equal(path.dirname(r2.file), path.join(vdir, 'Garden Robot'));

  const proj = tmp();
  fs.writeFileSync(path.join(proj, 'main.py'), '');
  const r3 = v.importFolder(proj, ['Garden Robot']);
  assert.equal(r3.rel.length, 2);
  v.saveClip({ title: 'Pump specs', url: 'https://example.com/p', text: 'max 2 bar', rel: r1.rel });

  const model = buildModel([{ id: 'cc:1', source: 'claude', directory: '/w/website', end: 1, files: [] }]);
  const idByRel = mergeVaultProjects(model, v.folders(), safeName);
  const garden = model.projects.find(p => p.name === 'Garden Robot');
  const sub = model.projects.find(p => p.parentId === garden.id);
  assert.ok(garden && sub, 'manual project and its sub-project exist');
  assert.ok(!model.projects.find(p => p.name === 'clips'), 'clips/ is not a project');
  const notes = v.userNotes(idByRel);
  const clip = notes.find(n => n.kind === 'clip');
  assert.equal(clip.projectId, garden.id);
  assert.equal(clip.url, 'https://example.com/p');
  assert.equal(notes.find(n => n.title === 'parts').projectId, garden.id);
});

test('generated notes never overwrite a note you wrote', () => {
  const vdir = tmp();
  const v = new Vault(vdir);
  fs.mkdirSync(path.join(vdir, 'app'));
  fs.writeFileSync(path.join(vdir, 'app', 'app.md'), 'my own notes');
  v.write(buildModel([{ id: 'cc:1', source: 'claude', directory: '/w/app', title: 't', prompts: 1, start: 1, end: 2, files: [] }]));
  assert.equal(fs.readFileSync(path.join(vdir, 'app', 'app.md'), 'utf8'), 'my own notes');
});
