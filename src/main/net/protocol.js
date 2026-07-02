'use strict';
// CursorKeyShare wire protocol.
//
// Every message is a single "packet" whose plaintext is:
//     [ type(1) | payload(n) ]
// The plaintext is then sealed (see crypto.js) before it hits the wire.
//
// Control messages (HELLO/WELCOME/SCREENS/PING/PONG/CLIPBOARD) carry UTF-8 JSON.
// Input messages (MOUSE_*/KEY) carry a tightly packed binary payload so that the
// hot path — mouse motion at hundreds of events/sec — stays as small and fast as
// possible. Motion travels over UDP with a sequence number so stale datagrams can
// be dropped; everything that must be reliable/ordered travels over TCP.

const T = Object.freeze({
  HELLO: 0x01,
  WELCOME: 0x02,
  SCREENS: 0x03,
  PING: 0x04,
  PONG: 0x05,
  CLIPBOARD: 0x06,
  BYE: 0x07,

  MOUSE_MOVE: 0x10, // UDP: uint32 seq, int32 x, int32 y   (target-local px)
  MOUSE_BUTTON: 0x11, // TCP: uint8 button, uint8 down
  MOUSE_WHEEL: 0x12, // TCP: int16 dx, int16 dy
  KEY: 0x13, // TCP: uint8 down, uint32 keycode, uint32 rawcode, uint32 modifiers
  ENTER: 0x14, // TCP: int32 x, int32 y
  LEAVE: 0x15, // TCP: (none)
});

const BUTTON = Object.freeze({ LEFT: 1, RIGHT: 2, MIDDLE: 3 });

// ---- JSON control messages -------------------------------------------------

function encodeJson(type, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from([type]), body]);
}

// ---- Binary input messages -------------------------------------------------

function encodeMouseMove(seq, x, y) {
  const b = Buffer.allocUnsafe(1 + 12);
  b[0] = T.MOUSE_MOVE;
  b.writeUInt32LE(seq >>> 0, 1);
  b.writeInt32LE(x | 0, 5);
  b.writeInt32LE(y | 0, 9);
  return b;
}

function encodeMouseButton(button, down) {
  return Buffer.from([T.MOUSE_BUTTON, button & 0xff, down ? 1 : 0]);
}

function encodeMouseWheel(dx, dy) {
  const b = Buffer.allocUnsafe(1 + 4);
  b[0] = T.MOUSE_WHEEL;
  b.writeInt16LE(clampI16(dx), 1);
  b.writeInt16LE(clampI16(dy), 3);
  return b;
}

function encodeKey(down, keycode, rawcode, modifiers) {
  const b = Buffer.allocUnsafe(1 + 1 + 12);
  b[0] = T.KEY;
  b[1] = down ? 1 : 0;
  b.writeUInt32LE(keycode >>> 0, 2);
  b.writeUInt32LE(rawcode >>> 0, 6);
  b.writeUInt32LE(modifiers >>> 0, 10);
  return b;
}

function encodeEnter(x, y) {
  const b = Buffer.allocUnsafe(1 + 8);
  b[0] = T.ENTER;
  b.writeInt32LE(x | 0, 1);
  b.writeInt32LE(y | 0, 5);
  return b;
}

function encodeLeave() {
  return Buffer.from([T.LEAVE]);
}

// ---- Decode ----------------------------------------------------------------

/**
 * Decode a plaintext packet into a structured object: { type, ... }.
 * Throws on malformed input.
 */
function decode(buf) {
  if (!buf || buf.length < 1) throw new Error('empty packet');
  const type = buf[0];
  switch (type) {
    case T.MOUSE_MOVE:
      return {
        type,
        seq: buf.readUInt32LE(1),
        x: buf.readInt32LE(5),
        y: buf.readInt32LE(9),
      };
    case T.MOUSE_BUTTON:
      return { type, button: buf[1], down: !!buf[2] };
    case T.MOUSE_WHEEL:
      return { type, dx: buf.readInt16LE(1), dy: buf.readInt16LE(3) };
    case T.KEY:
      return {
        type,
        down: !!buf[1],
        keycode: buf.readUInt32LE(2),
        rawcode: buf.readUInt32LE(6),
        modifiers: buf.readUInt32LE(10),
      };
    case T.ENTER:
      return { type, x: buf.readInt32LE(1), y: buf.readInt32LE(5) };
    case T.LEAVE:
      return { type };
    case T.HELLO:
    case T.WELCOME:
    case T.SCREENS:
    case T.PING:
    case T.PONG:
    case T.CLIPBOARD:
    case T.BYE:
      return { type, ...JSON.parse(buf.subarray(1).toString('utf8')) };
    default:
      throw new Error('unknown packet type 0x' + type.toString(16));
  }
}

function clampI16(v) {
  v = Math.round(v) | 0;
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

module.exports = {
  T,
  BUTTON,
  encodeJson,
  encodeMouseMove,
  encodeMouseButton,
  encodeMouseWheel,
  encodeKey,
  encodeEnter,
  encodeLeave,
  decode,
};
