'use strict';

// Client for a local Ollama server (https://github.com/ollama/ollama). No cloud calls.
class LocalAI {
  constructor({ url = 'http://127.0.0.1:11434', model = 'qwen2.5:3b' } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.model = model;
    this.noThink = true; // turned off if this Ollama build rejects the flag
  }

  async request(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(this.url + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Ollama answered ${r.status}`);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The local model took too long to answer.');
      if (e.cause && e.cause.code === 'ECONNREFUSED') throw new Error('Ollama is not running. Start it with: ollama serve');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  async status() {
    try {
      const data = await this.request('/api/tags', null, 1500);
      const models = (data.models || []).map(m => m.name);
      const want = this.model.includes(':') ? this.model : this.model + ':latest';
      return { running: true, models, hasModel: models.includes(want) || models.includes(this.model) };
    } catch (e) {
      return { running: false, models: [], hasModel: false, error: e.message };
    }
  }

  async chat(messages, tools) {
    const body = {
      model: this.model,
      messages,
      stream: false,
      keep_alive: '5m', // frees VRAM 5 minutes after the last question
      options: { temperature: 0.2, num_ctx: 8192 },
    };
    if (tools && tools.length) body.tools = tools;
    if (this.noThink) body.think = false;
    try {
      return await this.request('/api/chat', body, 120000);
    } catch (e) {
      if (this.noThink && /think/i.test(e.message)) {
        this.noThink = false;
        delete body.think;
        return this.request('/api/chat', body, 120000);
      }
      throw e;
    }
  }

  async summarize(text) {
    const r = await this.chat([
      { role: 'system', content: 'You summarize notes. Use short, simple sentences.' },
      { role: 'user', content: 'Summarize this in 2 or 3 short sentences. Then one line starting with "Tags:" and up to 5 one-word tags.\n\n' + String(text).slice(0, 12000) },
    ]);
    return stripThink(r.message && r.message.content);
  }
}

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

module.exports = { LocalAI, stripThink };
