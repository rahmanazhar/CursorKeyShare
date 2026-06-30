'use strict';
// Renderer: settings form + draggable screen-layout editor.
// Talks to the main process exclusively through the `window.cks` bridge.

// NOTE: don't name this `cks`. The preload exposes the bridge as the global
// `window.cks` via contextBridge, which is a *non-configurable* global property;
// a top-level `const cks` collides with it ("Identifier 'cks' has already been
// declared") and aborts this entire script, leaving the form unpopulated.
const api = window.cks;

const el = (id) => document.getElementById(id);
const stage = el('stage');

let cfg = null;
let layout = { nodes: [], localId: null, activeId: null };
let status = { running: false };

// ---- settings form ---------------------------------------------------------

const FIELDS = ['name', 'role', 'serverHost', 'group', 'tcpPort', 'udpPort', 'edgeGuardMs'];
const CHECKS = ['switchToClipboard', 'autoConnect'];

async function loadConfig() {
  cfg = await api.getConfig();
  // Machine name: fall back to the auto-detected hostname, and always show it
  // as the placeholder so it's clear what "empty" will become.
  el('name').value = cfg.name || cfg.detectedName || '';
  el('name').placeholder = cfg.detectedName || 'machine';
  el('role').value = cfg.role || 'server';
  el('serverHost').value = cfg.serverHost || '';
  // Hint a client toward the right LAN: this machine's subnet with a blanked host.
  const lan = (cfg.localIPs && cfg.localIPs[0]) || '';
  el('serverHost').placeholder = lan ? lan.replace(/\.\d+$/, '.10') : '192.168.1.10';
  el('group').value = cfg.group || 'cursorkeyshare';
  el('tcpPort').value = cfg.tcpPort || 24800;
  el('udpPort').value = cfg.udpPort || 24801;
  el('edgeGuardMs').value = cfg.edgeGuardMs ?? 80;
  el('switchToClipboard').checked = !!cfg.switchToClipboard;
  el('autoConnect').checked = !!cfg.autoConnect;
  el('passphrase').placeholder = cfg.hasPassphrase ? '•••••••• (unchanged)' : 'set a passphrase';
  renderLocalAddr();
  applyRoleVisibility();
}

// Show this machine's auto-detected address (and TCP port) for the server role.
function renderLocalAddr() {
  const box = el('localAddrValue');
  const ips = cfg.localIPs || [];
  const port = parseInt(el('tcpPort').value, 10) || cfg.tcpPort || 24800;
  if (!ips.length) {
    box.textContent = 'no network detected';
    box.classList.add('none');
    return;
  }
  box.classList.remove('none');
  // Primary address first; list any extras so multi-NIC machines are obvious.
  box.textContent = ips.map((ip) => `${ip}:${port}`).join('   ');
}

function applyRoleVisibility() {
  const isClient = el('role').value === 'client';
  el('serverHostField').style.display = isClient ? 'flex' : 'none';
  el('localAddrInfo').style.display = isClient ? 'none' : 'flex';
}

async function saveConfig() {
  const patch = {
    name: el('name').value.trim() || 'machine',
    role: el('role').value,
    serverHost: el('serverHost').value.trim(),
    group: el('group').value.trim() || 'cursorkeyshare',
    tcpPort: parseInt(el('tcpPort').value, 10) || 24800,
    udpPort: parseInt(el('udpPort').value, 10) || 24801,
    edgeGuardMs: parseInt(el('edgeGuardMs').value, 10) || 0,
    switchToClipboard: el('switchToClipboard').checked,
    autoConnect: el('autoConnect').checked,
  };
  const pass = el('passphrase').value;
  if (pass) patch.passphrase = pass;
  cfg = await api.setConfig(patch);
  el('passphrase').value = '';
  el('passphrase').placeholder = cfg.hasPassphrase ? '•••••••• (unchanged)' : 'set a passphrase';
  flashSaved();
}

function flashSaved() {
  const b = el('saveBtn');
  const t = b.textContent;
  b.textContent = 'Saved ✓';
  setTimeout(() => (b.textContent = t), 1200);
}

el('saveBtn').addEventListener('click', saveConfig);
el('role').addEventListener('change', applyRoleVisibility);
el('tcpPort').addEventListener('input', renderLocalAddr); // keep shown port in sync

// Copy this machine's primary address so it can be pasted on a client.
el('copyAddrBtn').addEventListener('click', async () => {
  const ip = (cfg.localIPs && cfg.localIPs[0]) || '';
  if (!ip) return;
  const port = parseInt(el('tcpPort').value, 10) || 24800;
  await copyText(`${ip}:${port}`);
  flashBtn(el('copyAddrBtn'), 'Copied ✓');
});

// Generate a strong, copy-pasteable passphrase, reveal it, and put it on the
// clipboard so it can be pasted on the other machines (the secret must match
// on every member).
el('genPassBtn').addEventListener('click', async () => {
  const pass = generatePassphrase();
  const input = el('passphrase');
  input.type = 'text';
  input.value = pass;
  await copyText(pass);
  flashBtn(el('genPassBtn'), 'Copied ✓');
});

// Clipboard write that also works in an Electron file:// renderer, where the
// async Clipboard API may be unavailable; falls back to execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* best effort */ }
  document.body.removeChild(ta);
}

function generatePassphrase() {
  // Readable token: 5 groups of 4 chars from an unambiguous alphabet (no
  // 0/O/1/l/I), e.g. "k7mz-9xqp-h3rt-...". ~20 chars × log2(31) ≈ 99 bits —
  // strong, yet still re-typeable on another machine.
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const rnd = new Uint8Array(20);
  crypto.getRandomValues(rnd);
  const chars = [...rnd].map((b) => ALPHA[b % ALPHA.length]);
  const groups = [];
  for (let i = 0; i < chars.length; i += 4) groups.push(chars.slice(i, i + 4).join(''));
  return groups.join('-');
}

function flashBtn(b, msg) {
  const t = b.textContent;
  b.textContent = msg;
  setTimeout(() => (b.textContent = t), 1400);
}

el('toggleBtn').addEventListener('click', async () => {
  if (status.running) await api.stop();
  else await api.start();
});

// ---- status ----------------------------------------------------------------

function renderStatus(s) {
  status = s;
  const dot = el('statusDot');
  const text = el('statusText');
  if (s.error) {
    dot.className = 'dot warn';
    text.textContent = s.error;
  } else if (s.running) {
    dot.className = 'dot running';
    const where = s.active === s.role ? '' : '';
    text.textContent = s.role === 'server' ? `Sharing · ${s.peers ? s.peers.length : 0} client(s)` : 'Connected';
  } else {
    dot.className = 'dot stopped';
    text.textContent = 'Stopped';
  }
  el('toggleBtn').textContent = s.running ? 'Stop sharing' : 'Start sharing';
  if (s.backend) {
    el('backendInfo').textContent =
      `Input backend: ${s.backend}` + (s.suppressable ? ' · true suppression' : ' · soft suppression (build native addon for full)');
  }
}

// ---- layout editor ---------------------------------------------------------

let drag = null;

function worldBounds() {
  if (!layout.nodes.length) return { minX: 0, minY: 0, maxX: 1920, maxY: 1080 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.layoutX);
    minY = Math.min(minY, n.layoutY);
    maxX = Math.max(maxX, n.layoutX + n.width);
    maxY = Math.max(maxY, n.layoutY + n.height);
  }
  return { minX, minY, maxX, maxY };
}

function computeTransform() {
  const pad = 40;
  const w = stage.clientWidth || 600;
  const h = stage.clientHeight || 360;
  const b = worldBounds();
  const wW = Math.max(1, b.maxX - b.minX);
  const wH = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((w - pad * 2) / wW, (h - pad * 2) / wH);
  const offX = (w - wW * scale) / 2 - b.minX * scale;
  const offY = (h - wH * scale) / 2 - b.minY * scale;
  return { scale, offX, offY };
}

function renderLayout() {
  stage.innerHTML = '';
  const t = computeTransform();
  for (const n of layout.nodes) {
    const d = document.createElement('div');
    d.className = 'screen';
    if (n.id === layout.localId) d.classList.add('local');
    if (n.id === layout.activeId) d.classList.add('active');
    if (!n.online) d.classList.add('offline');
    d.style.left = n.layoutX * t.scale + t.offX + 'px';
    d.style.top = n.layoutY * t.scale + t.offY + 'px';
    d.style.width = n.width * t.scale + 'px';
    d.style.height = n.height * t.scale + 'px';
    d.dataset.id = n.id;

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = n.name + (n.id === layout.localId ? ' (this)' : '');
    const res = document.createElement('div');
    res.className = 'res';
    res.textContent = `${n.width}×${n.height}` + (n.online ? '' : ' · offline');
    d.appendChild(nm);
    d.appendChild(res);

    if (n.id !== layout.localId) {
      const rm = document.createElement('div');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = 'Remove this machine from the layout';
      rm.addEventListener('pointerdown', (e) => e.stopPropagation());
      rm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.removePeer(n.id);
      });
      d.appendChild(rm);
    }

    d.addEventListener('pointerdown', (e) => startDrag(e, n, t));
    stage.appendChild(d);
  }
}

function startDrag(e, node, t) {
  e.preventDefault();
  const elem = e.currentTarget;
  elem.setPointerCapture(e.pointerId);
  drag = {
    id: node.id,
    elem,
    t,
    startMouseX: e.clientX,
    startMouseY: e.clientY,
    startLayoutX: node.layoutX,
    startLayoutY: node.layoutY,
    node,
  };
}

stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dxWorld = (e.clientX - drag.startMouseX) / drag.t.scale;
  const dyWorld = (e.clientY - drag.startMouseY) / drag.t.scale;
  let nx = Math.round(drag.startLayoutX + dxWorld);
  let ny = Math.round(drag.startLayoutY + dyWorld);

  const snapped = snap(drag.node, nx, ny);
  nx = snapped.x;
  ny = snapped.y;

  drag.curX = nx;
  drag.curY = ny;
  drag.elem.style.left = nx * drag.t.scale + drag.t.offX + 'px';
  drag.elem.style.top = ny * drag.t.scale + drag.t.offY + 'px';
});

async function endDrag(e) {
  if (!drag) return;
  const { id, curX, curY, startLayoutX, startLayoutY } = drag;
  const x = curX ?? startLayoutX;
  const y = curY ?? startLayoutY;
  drag = null;
  await api.setPosition(id, x, y);
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// Snap the dragged node's edges to other nodes' edges (in world px).
function snap(node, x, y) {
  const TH = 18 / (drag ? drag.t.scale : 1); // ~18 screen px threshold
  const w = node.width;
  const h = node.height;
  let bestX = x, bestY = y;
  let dxBest = TH, dyBest = TH;
  for (const o of layout.nodes) {
    if (o.id === node.id) continue;
    // candidate x alignments: left-left, right-right, left-right(adjacent), right-left(adjacent)
    const xCands = [
      [x, o.layoutX], // left edges align
      [x + w, o.layoutX + o.width], // right edges align
      [x, o.layoutX + o.width], // place to the right of o
      [x + w, o.layoutX], // place to the left of o
    ];
    for (const [val, target] of xCands) {
      const d = Math.abs(val - target);
      if (d < dxBest) { dxBest = d; bestX = x + (target - val); }
    }
    const yCands = [
      [y, o.layoutY],
      [y + h, o.layoutY + o.height],
      [y, o.layoutY + o.height],
      [y + h, o.layoutY],
    ];
    for (const [val, target] of yCands) {
      const d = Math.abs(val - target);
      if (d < dyBest) { dyBest = d; bestY = y + (target - val); }
    }
  }
  return { x: Math.round(bestX), y: Math.round(bestY) };
}

// ---- log -------------------------------------------------------------------

function addLog(entry) {
  const log = el('log');
  const ln = document.createElement('div');
  ln.className = 'ln';
  const ts = new Date(entry.t).toLocaleTimeString();
  ln.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(entry.msg)}`;
  log.appendChild(ln);
  log.scrollTop = log.scrollHeight;
  while (log.childElementCount > 300) log.removeChild(log.firstChild);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---- wire events -----------------------------------------------------------

api.onLayout((d) => { layout = d; renderLayout(); });
api.onStatus((s) => { renderStatus(s); });
api.onLog((e) => addLog(e));

window.addEventListener('resize', renderLayout);

(async function init() {
  await loadConfig();
  layout = await api.getLayout();
  renderLayout();
  const s = await api.status().catch(() => ({ running: false }));
  renderStatus({ running: !!s.running, role: cfg.role, active: s.active, peers: [] });
})();
