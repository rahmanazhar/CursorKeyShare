'use strict';
// Electron main process: wires configuration, the input backend, the network
// layer and the core orchestrator together; owns the tray and the config window.

const path = require('path');
const net = require('net');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  clipboard,
  globalShortcut,
  screen,
} = require('electron');

const configMod = require('./config');
const netinfo = require('./netinfo');
const netbind = require('./net/netbind');
const crypto = require('./net/crypto');
const { Layout } = require('./layout');
const { getBackend } = require('./input');
const { NetServer } = require('./net/server');
const { NetClient } = require('./net/client');
const { ServerCore, ClientCore } = require('./core');

// Guard against being launched as plain Node (e.g. ELECTRON_RUN_AS_NODE=1),
// which leaves the Electron app APIs undefined.
if (!app || typeof app.whenReady !== 'function') {
  console.error(
    'Cursorkeyshare must be started via Electron, not plain Node.\n' +
      'If you see this, ELECTRON_RUN_AS_NODE is likely set in your environment.\n' +
      'Unset it and run `npm start`.'
  );
  process.exit(1);
}

const isDev = process.argv.includes('--dev');

const state = {
  cfg: null,
  layout: new Layout(),
  backend: null,
  server: null,
  client: null,
  core: null,
  running: false,
  activeId: null,
  win: null,
  tray: null,
  lastError: null,
};

// ---- desktop bounds --------------------------------------------------------

/** Combined virtual-desktop bounds of this machine, in its own coord space. */
function localBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!isFinite(minX)) return { originX: 0, originY: 0, width: 1920, height: 1080 };
  return { originX: minX, originY: minY, width: maxX - minX, height: maxY - minY };
}

// ---- engine lifecycle ------------------------------------------------------

function deriveKey(cfg) {
  const pass = configMod.getPassphrase(cfg);
  if (!pass) return null;
  return crypto.deriveKey(pass, cfg.group);
}

function registerLocalNode() {
  const b = localBounds();
  state.layout.setLocal(state.cfg.localId);
  state.layout.upsert({
    id: state.cfg.localId,
    name: state.cfg.name,
    originX: b.originX,
    originY: b.originY,
    width: b.width,
    height: b.height,
    isLocal: true,
    online: true,
    layoutX: state.cfg.positions[state.cfg.localId]?.layoutX ?? 0,
    layoutY: state.cfg.positions[state.cfg.localId]?.layoutY ?? 0,
  });
  state.layout.applyPositions(state.cfg.positions);
}

function startEngine() {
  stopEngine();
  state.lastError = null;
  const key = deriveKey(state.cfg);
  if (!key) {
    state.lastError = 'Set a passphrase before starting.';
    pushStatus();
    return false;
  }

  state.backend = getBackend();
  log(
    `input backend: ${state.backend.constructor.name}` +
      (state.backend.suppressable ? ' (true suppression)' : ' (soft suppression — build the native addon for full)')
  );
  registerLocalNode();

  // Which NIC to pin sockets to so LAN traffic bypasses a full-tunnel VPN.
  const bindIf = netinfo.resolveBindInterface(state.cfg.bindInterface);
  if (bindIf) log(`network pinned to ${bindIf} (bypasses VPN for LAN peers)`);

  if (state.cfg.role === 'server') {
    const server = new NetServer({
      key,
      tcpPort: state.cfg.tcpPort,
      udpPort: state.cfg.udpPort,
      name: state.cfg.name,
      localId: state.cfg.localId,
      bindIf,
    });
    wireServerEvents(server);
    server.start();
    state.server = server;
    state.core = new ServerCore({
      layout: state.layout,
      backend: state.backend,
      server,
      config: state.cfg,
    });
    state.core.on('active-changed', (e) => {
      state.activeId = e.id;
      const node = state.layout.get(e.id);
      log('control → ' + (e.local ? 'this machine' : (node ? node.name : e.id)));
      if (!e.local && state.cfg.switchToClipboard) {
        const text = clipboard.readText();
        if (text) server.sendClipboard(e.id, 'text', text);
      }
      pushStatus();
    });
  } else {
    const client = new NetClient({
      key,
      host: state.cfg.serverHost,
      tcpPort: state.cfg.tcpPort,
      udpPort: state.cfg.udpPort,
      serverUdpPort: state.cfg.udpPort,
      name: state.cfg.name,
      localId: state.cfg.localId,
      bounds: localBounds(),
      bindIf,
    });
    wireClientEvents(client);
    state.client = client;
    state.core = new ClientCore({ backend: state.backend, client });
  }

  // Starting input capture can fail on macOS if Accessibility / Input Monitoring
  // haven't been granted (the native tap can't install) — surface it instead of
  // silently doing nothing.
  try {
    state.core.start();
  } catch (e) {
    state.lastError =
      'Could not start input capture: ' +
      (e && e.message ? e.message : e) +
      ' — on macOS grant Accessibility & Input Monitoring in System Settings > Privacy & Security, then Start again.';
    log(state.lastError);
    stopEngine();
    return false;
  }

  state.running = true;
  pushStatus();
  updateTray();
  return true;
}

function stopEngine() {
  if (state.core) try { state.core.stop(); } catch {}
  if (state.server) try { state.server.stop(); } catch {}
  if (state.client) try { state.client.stop(); } catch {}
  state.core = state.server = state.client = null;
  state.running = false;
  state.activeId = state.cfg ? state.cfg.localId : null;
  updateTray();
  pushStatus();
}

function wireServerEvents(server) {
  server.on('listening', (port) => log(`server listening on ${port}`));
  server.on('peer-connected', (p) => {
    state.layout.upsert({
      id: p.id,
      name: p.name,
      originX: p.originX,
      originY: p.originY,
      width: p.width,
      height: p.height,
      online: true,
      layoutX: state.cfg.positions[p.id]?.layoutX,
      layoutY: state.cfg.positions[p.id]?.layoutY,
    });
    log(`peer connected: ${p.name} (${p.ip})`);
    pushLayout();
    pushStatus();
  });
  server.on('peer-screens', (p) => {
    state.layout.upsert({ id: p.id, originX: p.originX, originY: p.originY, width: p.width, height: p.height });
    pushLayout();
  });
  server.on('peer-disconnected', (id) => {
    state.layout.setOnline(id, false);
    log(`peer disconnected: ${id}`);
    pushLayout();
    pushStatus();
  });
  server.on('clipboard', ({ from, format, data }) => {
    if (format === 'text') clipboard.writeText(data);
    server.broadcastClipboard(format, data, from);
  });
  server.on('warn', (m) => log('warn: ' + m));
  server.on('error', (e) => { state.lastError = String(e.message || e); log('error: ' + state.lastError); pushStatus(); });
}

function wireClientEvents(client) {
  client.on('connected', () => log('connected to server'));
  client.on('welcome', (w) => log(`welcomed by ${w.name}`));
  client.on('disconnected', () => log('disconnected; retrying...'));
  client.on('clipboard', ({ format, data }) => {
    if (format === 'text') clipboard.writeText(data);
  });
  client.on('warn', (m) => log('warn: ' + m));
  client.on('error', (e) => log('error: ' + String(e.message || e)));
}

// ---- persistence helpers ---------------------------------------------------

function persist() {
  state.cfg.positions = state.layout.serializePositions();
  configMod.save(state.cfg);
}

// ---- renderer messaging ----------------------------------------------------

function send(channel, payload) {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}
function log(msg) {
  console.log('[cks]', msg);
  send('log', { t: Date.now(), msg });
}
function pushLayout() {
  send('layout', {
    nodes: state.layout.list(),
    localId: state.cfg.localId,
    activeId: state.activeId,
  });
}
function pushStatus() {
  send('status', {
    running: state.running,
    role: state.cfg.role,
    active: state.activeId,
    error: state.lastError,
    backend: state.backend ? state.backend.constructor.name : null,
    suppressable: state.backend ? state.backend.suppressable : false,
    peers: state.server ? [...state.server.peers.values()].map((p) => ({ id: p.id, name: p.name, ip: p.ip })) : [],
  });
}

// ---- window & tray ---------------------------------------------------------

function createWindow() {
  state.win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: 'Cursorkeyshare',
    webPreferences: {
      preload: path.join(__dirname, '../renderer/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  state.win.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (isDev) state.win.webContents.openDevTools({ mode: 'detach' });
  state.win.on('close', (e) => {
    // Keep running in the tray instead of quitting.
    if (!app.isQuitting) {
      e.preventDefault();
      state.win.hide();
    }
  });
}

function trayIcon() {
  // macOS menu bar wants a black "template" image (inverts for dark/light);
  // other platforms get the colored icon.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(__dirname, '../../assets', file));
  if (img.isEmpty()) {
    // Fallback so the tray is never invisible if assets are missing.
    return nativeImage.createFromPath(path.join(__dirname, '../../buildResources/icon.png')).resize({ width: 18, height: 18 });
  }
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!state.tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Cursorkeyshare', enabled: false },
    { type: 'separator' },
    { label: state.running ? 'Stop sharing' : 'Start sharing', click: () => (state.running ? stopEngine() : startEngine()) },
    { label: 'Open configuration', click: () => { state.win.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  state.tray.setToolTip(`Cursorkeyshare — ${state.running ? 'running' : 'stopped'}`);
  state.tray.setContextMenu(menu);
}

function createTray() {
  state.tray = new Tray(trayIcon());
  state.tray.on('click', () => state.win.show());
  updateTray();
}

// ---- IPC -------------------------------------------------------------------

function publicConfig() {
  const { passphraseEnc, passphrasePlain, ...rest } = state.cfg;
  return {
    ...rest,
    hasPassphrase: !!(passphraseEnc || passphrasePlain),
    // Live, auto-detected values the UI surfaces (never persisted as config).
    detectedName: netinfo.detectName(),
    localIPs: netinfo.detectLocalIPv4s(),
    interfaces: netinfo.rankedInterfaces(), // [{name, address}] best-first
    bindAvailable: netbind.available(), // can we actually pin to a NIC?
  };
}

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig());

  // Diagnose LAN reachability to a peer, WITH and WITHOUT interface pinning, so
  // the user can see whether VPN-bypass is working — or whether their VPN is the
  // unbeatable includeAllNetworks kind (both fail).
  ipcMain.handle('net:testReach', async (_e, { host }) => {
    const target = (host || '').trim().replace(/:\d+$/, '');
    const port = state.cfg.tcpPort || 24800;
    const ifName = netinfo.resolveBindInterface(state.cfg.bindInterface);
    if (!target) return { ok: false, error: 'Enter the other machine’s address first.' };

    const plain = () =>
      new Promise((res) => {
        const s = net.connect({ host: target, port });
        const done = (v) => { try { s.destroy(); } catch {} res(v); };
        s.setTimeout(2500, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
      });
    const scoped = async () => {
      if (!ifName || !netbind.available()) return null; // pinning n/a
      try {
        const s = await netbind.connectBoundTcp(target, port, ifName, 2500);
        try { s.destroy(); } catch {}
        return true;
      } catch {
        return false;
      }
    };
    const unscoped = await plain();
    const bound = await scoped();
    return { ok: true, host: target, port, ifName, unscoped, scoped: bound };
  });

  ipcMain.handle('config:set', (_e, patch) => {
    const wasRunning = state.running;
    if (typeof patch.passphrase === 'string') {
      configMod.setPassphrase(state.cfg, patch.passphrase);
    }
    delete patch.passphrase;
    Object.assign(state.cfg, patch);
    persist();
    if (wasRunning) startEngine();
    pushStatus();
    return publicConfig();
  });

  ipcMain.handle('layout:get', () => ({
    nodes: state.layout.list(),
    localId: state.cfg.localId,
    activeId: state.activeId,
  }));

  ipcMain.handle('layout:setPosition', (_e, { id, x, y }) => {
    state.layout.setPosition(id, x, y);
    persist();
    pushLayout();
    return true;
  });

  ipcMain.handle('engine:start', () => startEngine());
  ipcMain.handle('engine:stop', () => { stopEngine(); return true; });
  ipcMain.handle('engine:status', () => ({ running: state.running, active: state.activeId }));

  ipcMain.handle('peer:remove', (_e, { id }) => {
    state.layout.remove(id);
    delete state.cfg.positions[id];
    persist();
    pushLayout();
    return true;
  });

  ipcMain.handle('release-to-local', () => {
    if (state.core && state.core.releaseToLocal) state.core.releaseToLocal();
    return true;
  });
}

// ---- app boot --------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (state.win) { state.win.show(); state.win.focus(); } });

  app.whenReady().then(() => {
    state.cfg = configMod.load();
    state.activeId = state.cfg.localId;
    registerLocalNode();
    registerIpc();
    createWindow();
    createTray();

    // Panic hotkey: yank control back to this machine.
    try {
      globalShortcut.register('CommandOrControl+Alt+Home', () => {
        if (state.core && state.core.releaseToLocal) state.core.releaseToLocal();
        log('control released to local (panic hotkey)');
      });
    } catch {}

    pushLayout();
    pushStatus();

    if (state.cfg.autoConnect) startEngine();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else state.win.show();
    });
  });

  app.on('will-quit', () => {
    persist();
    stopEngine();
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray (except on explicit quit).
  });
}
