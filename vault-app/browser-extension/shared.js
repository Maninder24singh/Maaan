// Talks to the Memory Vault app on this PC (127.0.0.1 only).
const DEFAULTS = { port: 47321, token: '', project: '' };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(['port', 'token', 'project'])) };
}

async function call(path, body) {
  const s = await settings();
  if (!s.token) throw new Error('Not paired yet. Open the extension and paste the key from the app.');
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-vault-token': s.token },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Memory Vault is not running, or the browser connection is turned off in the app.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

// Runs inside the page: title, URL, selection and the main readable text.
function grabPage() {
  const main = document.querySelector('article, main, [role="main"]') || document.body;
  return {
    title: document.title,
    url: location.href,
    selection: String(getSelection() || '').trim(),
    text: (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 100000),
  };
}

async function grabTab(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
  return res.result;
}
