'use strict';
// Message encryption for CursorKeyShare.
//
// All TCP and UDP payloads are sealed with AES-256-GCM. The key is derived from
// a user-chosen passphrase with scrypt, salted by a per-session "group id" so
// that two independent groups with the same passphrase never collide.
//
// Wire format of a sealed blob:  [ iv(12) | ciphertext(n) | tag(16) ]
//
// GCM gives us both confidentiality and authentication: a packet sealed with the
// wrong key fails to open, which doubles as authentication / anti-spoofing — an
// attacker cannot inject input without the shared passphrase.

const crypto = require('crypto');

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

/**
 * Derive a 32-byte key from a passphrase. `salt` should be a stable per-group
 * value (we use the group name) so all members derive the same key.
 * @param {string} passphrase
 * @param {string} salt
 * @returns {Buffer}
 */
function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error('passphrase required');
  return crypto.scryptSync(
    Buffer.from(String(passphrase), 'utf8'),
    crypto.createHash('sha256').update(String(salt || 'cursorkeyshare')).digest(),
    KEY_LEN,
    { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
  );
}

// Single-entry memo for deriveKey. scrypt at N=2^14 costs ~49ms and blocks the
// Electron main thread — the same thread native input events marshal onto — so
// re-deriving on every engine restart is a visible input stall. Credentials
// rarely change, so one entry is enough.
let _cache = null; // { passphrase, salt, key }

function deriveKeyCached(passphrase, salt) {
  const s = String(salt || 'cursorkeyshare');
  if (_cache && _cache.passphrase === passphrase && _cache.salt === s) return _cache.key;
  const key = deriveKey(passphrase, s);
  _cache = { passphrase, salt: s, key };
  return key;
}

/**
 * Seal a plaintext buffer. Returns iv|ciphertext|tag.
 * @param {Buffer} key
 * @param {Buffer} plaintext
 * @returns {Buffer}
 */
function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/**
 * Open a sealed blob. Throws if authentication fails (wrong key / tampering).
 * @param {Buffer} key
 * @param {Buffer} blob
 * @returns {Buffer}
 */
function open(key, blob) {
  if (!Buffer.isBuffer(blob) || blob.length < IV_LEN + TAG_LEN) {
    throw new Error('sealed blob too short');
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Random hex token, e.g. for a session/group id. */
function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { deriveKey, deriveKeyCached, seal, open, randomId, IV_LEN, TAG_LEN, KEY_LEN };
