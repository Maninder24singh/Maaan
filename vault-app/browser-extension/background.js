importScripts('shared.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'sel', title: 'Save selection to Memory Vault', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'page', title: 'Save page to Memory Vault', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'link', title: 'Save link to Memory Vault', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'image', title: 'Save image link to Memory Vault', contexts: ['image'] });
});

async function flash(ok, tabId) {
  await chrome.action.setBadgeBackgroundColor({ color: ok ? '#2E9E5B' : '#C0392B', tabId });
  await chrome.action.setBadgeText({ text: ok ? '✓' : '!', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 2500);
}

async function save(clip, tabId) {
  const { project } = await settings();
  try {
    await call('/clip', { ...clip, project });
    await flash(true, tabId);
  } catch (e) {
    console.warn(e);
    await flash(false, tabId);
    await chrome.action.setTitle({ title: 'Memory Vault: ' + e.message, tabId });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sel') return save({ title: tab.title, url: tab.url, text: info.selectionText }, tab.id);
  if (info.menuItemId === 'link') return save({ title: info.linkUrl, url: info.linkUrl, text: `Link found on ${tab.title}` }, tab.id);
  if (info.menuItemId === 'image') return save({ title: 'Image from ' + tab.title, url: info.srcUrl, text: `Image on ${tab.url}` }, tab.id);
  const p = await grabTab(tab.id);
  return save({ title: p.title, url: p.url, text: p.selection || p.text }, tab.id);
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'save-page' || !tab) return;
  const p = await grabTab(tab.id);
  return save({ title: p.title, url: p.url, text: p.selection || p.text }, tab.id);
});
