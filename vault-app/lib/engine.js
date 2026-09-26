'use strict';
const fs = require('fs');
const path = require('path');
const { ClaudeSource } = require('./claude');
const { OpencodeSource } = require('./opencode');
const { buildModel, mergeVaultProjects } = require('./model');
const { Vault, safeName } = require('./vault');

// Reads both tools, builds the project model, keeps the vault in sync,
// and calls onData whenever something changed on disk.
class Engine {
  constructor(settings, onData) {
    this.onData = onData;
    this.lastSignature = null;
    this.watchers = [];
    this.timer = null;
    this.poll = null;
    this.configure(settings);
  }

  configure(settings) {
    this.settings = settings;
    this.claude = new ClaudeSource(settings.claudeDir);
    this.opencode = new OpencodeSource(settings.opencodeDb);
    this.vault = new Vault(settings.vaultDir);
  }

  // force: send even if nothing changed (first load, settings change).
  refresh(force = false) {
    const t0 = Date.now();
    const claudeSessions = this.claude.scan();
    const opencodeSessions = this.opencode.scan();
    const model = buildModel([...claudeSessions, ...opencodeSessions]);

    let written = 0;
    let vaultError = null;
    if (this.settings.writeNotes) {
      try { written = this.vault.write(model); } catch (e) { vaultError = e.message; }
    }
    let notes = [];
    try {
      const idByRel = mergeVaultProjects(model, this.vault.folders(), safeName);
      notes = this.vault.userNotes(idByRel);
    } catch (e) { vaultError = vaultError || e.message; }

    const data = {
      projects: model.projects,
      sessions: model.sessions,
      notes,
      status: {
        updated: Date.now(),
        took: Date.now() - t0,
        claude: { path: this.settings.claudeDir, found: fs.existsSync(this.settings.claudeDir), sessions: claudeSessions.length },
        opencode: { path: this.settings.opencodeDb, found: fs.existsSync(this.settings.opencodeDb), sessions: opencodeSessions.length, error: this.opencode.lastError },
        vault: { path: this.settings.vaultDir, writing: !!this.settings.writeNotes, written, error: vaultError },
      },
    };
    // Polls and our own vault writes land here too; only wake the UI when something changed.
    const signature = JSON.stringify([data.projects, data.sessions, data.notes, data.status.claude, data.status.opencode, data.status.vault.error]);
    if (force || signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.onData(data);
    }
    return data;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { this.refresh(); } catch (e) { console.error('refresh failed', e); }
    }, 600);
  }

  watch(target, opts, filter) {
    try {
      const w = fs.watch(target, opts, (_ev, name) => {
        if (!filter || filter(String(name || ''))) this.schedule();
      });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch { /* folder missing: the poll below still picks it up */ }
  }

  start() {
    this.stop();
    const s = this.settings;
    this.watch(s.claudeDir, { recursive: true }, n => n.endsWith('.jsonl'));
    // OpenCode writes to opencode.db-wal on every message. The -shm file is skipped:
    // our own read touches it, which would otherwise loop.
    const db = path.basename(s.opencodeDb);
    this.watch(path.dirname(s.opencodeDb), {}, n => n === db || n === db + '-wal');
    this.watch(s.vaultDir, { recursive: true }, n => n.toLowerCase().endsWith('.md'));
    // Backstop for folders that do not send change events (network drives, \\wsl$ paths).
    this.poll = setInterval(() => this.schedule(), 15000);
    return this.refresh(true);
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch { /* already closed */ } }
    this.watchers = [];
    clearInterval(this.poll);
    clearTimeout(this.timer);
  }
}

module.exports = { Engine };
