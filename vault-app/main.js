'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const paths = require('./lib/paths');
const { Engine } = require('./lib/engine');
const { createFeatures } = require('./lib/features');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  const defaults = {
    consented: false,
    claudeDir: paths.defaultClaudeDir(),
    opencodeDb: paths.defaultOpencodeDb(),
    vaultDir: paths.defaultVaultDir(),
    writeNotes: true,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
}

// The page is served from app://local/ instead of file:// so the shape
// segmenter can fetch its model and WebAssembly files.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const SERVED = ['renderer', 'node_modules/d3/dist', 'node_modules/@mediapipe/selfie_segmentation'];

// The browser extension folder: next to main.js in dev, in resources/ when installed.
function extensionDir() {
  const packed = path.join(process.resourcesPath || '', 'browser-extension');
  return fs.existsSync(packed) ? packed : path.join(__dirname, 'browser-extension');
}

function serveApp(req) {
  const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(__dirname, rel));
  const allowed = SERVED.some(dir => file.startsWith(path.join(__dirname, dir) + path.sep));
  if (!allowed) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// The shape segmenter needs WebGL2. If the GPU is blocked, fall back to software
// rendering instead of failing. Safe here: the window only ever loads this app's own files.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// Lets tests and portable installs keep settings somewhere else.
if (process.env.MEMORY_VAULT_USER_DATA) app.setPath('userData', process.env.MEMORY_VAULT_USER_DATA);

let win = null;
let engine = null;
let settings = null;
let lastData = null;
let features = null;

function send(data) {
  lastData = data;
  if (win && !win.isDestroyed()) win.webContents.send('vault:data', data);
}

function toast(text) {
  if (win && !win.isDestroyed()) win.webContents.send('vault:toast', String(text));
}

function describe(s) {
  return {
    settings: s,
    found: {
      claudeDir: fs.existsSync(s.claudeDir),
      opencodeDb: fs.existsSync(s.opencodeDb),
      vaultDir: fs.existsSync(s.vaultDir),
    },
  };
}

function startEngine() {
  if (!engine) engine = new Engine(settings, send);
  else engine.configure(settings);
  const data = engine.start();
  features.startAll().catch(e => toast(e.message));
  return data;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#000000',
    title: 'Memory Vault',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://local/renderer/index.html');
  // Links inside notes open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', serveApp);
  if (process.platform === 'win32') app.setAppUserModelId('local.memoryvault.app');
  settings = loadSettings();
  features = createFeatures({
    getSettings: () => settings,
    saveSettings: s => { settings = s; saveSettings(s); },
    getEngine: () => (settings.consented ? engine : null),
    getData: () => lastData,
    refresh: () => { if (engine) engine.schedule(); },
    toast,
  });

  // Each handler returns { ok, value } or { ok: false, error } so the page can show a plain message.
  const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('vault:connections', () => features.status());
  handle('vault:set-feature', (name, patch) => features.setFeature(name, patch || {}));
  handle('vault:import', (list, targetId) => features.importPaths((list || []).filter(p => typeof p === 'string'), targetId || null));
  handle('vault:new-project', opts => features.newProject(opts || {}));
  handle('vault:launch', (tool, projectId) => features.launch(tool, projectId));
  handle('vault:ask', text => features.ask(text));
  handle('vault:approve', id => features.approve(id));
  handle('vault:reset-chat', () => features.resetChat());
  handle('vault:copy', async text => { await require('electron').clipboard.writeText(String(text)); return true; });
  handle('vault:save-clipboard', async () => {
    const saved = await features.saveClipboard();
    return saved ? { file: saved.file } : null;
  });
  handle('vault:show-extension', () => { shell.openPath(extensionDir()); return extensionDir(); });

  ipcMain.handle('vault:init', () => ({ ...describe(settings), data: settings.consented ? (lastData || startEngine()) : null }));

  // Called from the permission screen. Nothing is read or written before this.
  ipcMain.handle('vault:save-settings', (_e, next) => {
    settings = {
      ...settings,
      claudeDir: String(next.claudeDir || settings.claudeDir),
      opencodeDb: String(next.opencodeDb || settings.opencodeDb),
      vaultDir: String(next.vaultDir || settings.vaultDir),
      writeNotes: !!next.writeNotes,
      consented: true,
    };
    saveSettings(settings);
    return { ...describe(settings), data: startEngine() };
  });

  ipcMain.handle('vault:check-paths', (_e, s) => describe({ ...settings, ...s }).found);

  ipcMain.handle('vault:pick', async (_e, kind) => {
    const opts = kind === 'file'
      ? { properties: ['openFile'], filters: [{ name: 'OpenCode database', extensions: ['db'] }] }
      : { properties: ['openDirectory', 'createDirectory'] };
    const r = await dialog.showOpenDialog(win, opts);
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('vault:refresh', () => (settings.consented ? engine.refresh(true) : null));

  ipcMain.handle('vault:open', async (_e, p) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return 'That file is not on disk any more.';
    const err = await shell.openPath(p);
    return err || null;
  });

  ipcMain.handle('vault:reveal', (_e, p) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return 'That file is not on disk any more.';
    shell.showItemInFolder(p);
    return null;
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (engine) engine.stop();
  if (features) features.stopAll();
  if (process.platform !== 'darwin') app.quit();
});
