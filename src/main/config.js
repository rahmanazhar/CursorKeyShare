'use strict';
// Persistent configuration & "layout memory".
//
// Everything the user sets up — role, network port, group name, the screen
// layout positions — is written to a JSON file in Electron's userData dir so
// that reopening the app restores the exact same arrangement.
//
// The passphrase is never written in plaintext: it is encrypted with the OS
// keychain via Electron's safeStorage when available.

const fs = require('fs');
const path = require('path');
const os = require('os');

let _app = null;
let _safeStorage = null;
try {
  ({ app: _app, safeStorage: _safeStorage } = require('electron'));
} catch {
  // Allows unit use outside Electron.
}

const DEFAULTS = () => ({
  version: 1,
  role: 'server', // 'server' (has the keyboard/mouse) | 'client'
  name: os.hostname().replace(/\.local$/i, '') || 'machine', // drop mDNS ".local"
  group: 'cursorkeyshare', // KDF salt; all members must match
  tcpPort: 24800,
  udpPort: 24801,
  serverHost: '', // client-only: address of the server
  // Which network interface to pin sockets to (VPN bypass). 'auto' = best LAN
  // NIC, 'off' = normal OS routing, or a specific NIC name like 'en0'.
  bindInterface: 'auto',
  passphraseEnc: null, // base64 of safeStorage-encrypted passphrase
  passphrasePlain: null, // fallback when safeStorage unavailable (dev only)
  autoConnect: false,
  switchToClipboard: true,
  edgeGuardMs: 80, // dwell time at an edge before crossing (anti-accidental)
  positions: {}, // { [machineId]: { name, layoutX, layoutY } }
  localId: null, // stable id for this machine
});

function configPath() {
  const dir = _app ? _app.getPath('userData') : path.join(os.homedir(), '.cursorkeyshare');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.json');
}

function load() {
  const p = configPath();
  let cfg = DEFAULTS();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      cfg = { ...cfg, ...raw };
    }
  } catch (e) {
    console.error('[config] failed to read, using defaults:', e.message);
  }
  if (!cfg.localId) {
    cfg.localId = require('crypto').randomBytes(6).toString('hex');
  }
  return cfg;
}

function save(cfg) {
  const p = configPath();
  // Never persist a decrypted passphrase field.
  const { passphrase, ...rest } = cfg;
  try {
    fs.writeFileSync(p, JSON.stringify(rest, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] failed to write:', e.message);
  }
}

/** Store a passphrase, encrypted if possible. */
function setPassphrase(cfg, passphrase) {
  if (!passphrase) {
    cfg.passphraseEnc = null;
    cfg.passphrasePlain = null;
    return cfg;
  }
  if (_safeStorage && _safeStorage.isEncryptionAvailable()) {
    cfg.passphraseEnc = _safeStorage.encryptString(passphrase).toString('base64');
    cfg.passphrasePlain = null;
  } else {
    // Dev fallback only; documented as insecure.
    cfg.passphraseEnc = null;
    cfg.passphrasePlain = passphrase;
  }
  return cfg;
}

/** Retrieve the decrypted passphrase (or null). */
function getPassphrase(cfg) {
  if (cfg.passphraseEnc && _safeStorage && _safeStorage.isEncryptionAvailable()) {
    try {
      return _safeStorage.decryptString(Buffer.from(cfg.passphraseEnc, 'base64'));
    } catch (e) {
      console.error('[config] failed to decrypt passphrase:', e.message);
      return null;
    }
  }
  return cfg.passphrasePlain || null;
}

module.exports = { load, save, setPassphrase, getPassphrase, configPath, DEFAULTS };
