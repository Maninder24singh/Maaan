const $ = id => document.getElementById(id);
const status = (text, cls = '') => { $('status').textContent = text; $('status').className = 'status ' + cls; };

async function showMain() {
  $('pair').hidden = true;
  $('main').hidden = false;
  try {
    const { projects } = await call('/projects');
    const s = await settings();
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = p.rel; o.textContent = p.name;
      $('project').appendChild(o);
    }
    $('project').value = s.project || '';
    status('Connected to Memory Vault', 'ok');
  } catch (e) {
    status(e.message, 'bad');
  }
}

async function saveFrom(kind) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page;
  try { page = await grabTab(tab.id); } catch { page = { title: tab.title, url: tab.url, selection: '', text: '' }; }
  const picked = kind === 'sel' ? page.selection : page.selection || page.text;
  if (kind === 'sel' && !picked) return status('Select some text on the page first.', 'bad');
  const note = $('note').value.trim();
  const text = note ? `${note}\n\n---\n\n${picked}` : picked;
  await chrome.storage.local.set({ project: $('project').value });
  try {
    await call('/clip', { title: page.title, url: page.url, text, project: $('project').value });
    status('Saved ✓', 'ok');
    setTimeout(() => window.close(), 700);
  } catch (e) {
    status(e.message, 'bad');
  }
}

$('pair-btn').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: $('token').value.trim(), port: Number($('port').value) || 47321 });
  try { await call('/ping'); showMain(); } catch (e) { status(e.message, 'bad'); }
});
$('unpair').addEventListener('click', async () => { await chrome.storage.local.remove('token'); $('main').hidden = true; $('pair').hidden = false; status(''); });
$('save-page').addEventListener('click', () => saveFrom('page'));
$('save-sel').addEventListener('click', () => saveFrom('sel'));

settings().then(s => { if (s.token) showMain(); else { $('pair').hidden = false; $('port').value = s.port; } });
