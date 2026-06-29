'use strict';
// Generates the app icon and tray icons with no external dependencies (pure
// Node zlib). Outputs:
//   buildResources/icon.png        1024x1024  app icon (electron-builder -> .icns/.ico)
//   assets/tray.png  / @2x         16/32      colored tray icon (Windows/Linux)
//   assets/trayTemplate.png / @2x  16/32      black template tray icon (macOS menu bar)
//
// The two-screens-with-a-cursor mark reflects the KVM concept.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- tiny PNG encoder ------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing helpers -------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

// Anti-aliased coverage (0..1) for a rounded rectangle.
function roundRectCoverage(px, py, x, y, w, h, r) {
  const dx = px - clamp(px, x + r, x + w - r);
  const dy = py - clamp(py, y + r, y + h - r);
  const dist = Math.sqrt(dx * dx + dy * dy) - r;
  return clamp(0.5 - dist, 0, 1);
}

function over(dst, i, r, g, b, a) {
  if (a <= 0) return;
  const da = dst[i + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  const src = [r, g, b];
  for (let k = 0; k < 3; k++) {
    const dc = dst[i + k] / 255;
    dst[i + k] = Math.round(((src[k] * a + dc * da * (1 - a)) / outA) * 255);
  }
  dst[i + 3] = Math.round(outA * 255);
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- compose ---------------------------------------------------------------
// mode: 'app' (full, with squircle bg + cursor), 'trayColor' (squircle + screens),
//       'trayMono' (black screens glyph on transparent, for macOS template).

function compose(size, mode) {
  const s = size;
  const buf = Buffer.alloc(s * s * 4, 0);
  const mono = mode === 'trayMono';

  // background squircle (skip for mono template)
  if (!mono) {
    const margin = s * 0.06;
    const bx = margin, by = margin, bw = s - margin * 2, bh = s - margin * 2;
    const radius = bw * 0.2237;
    const c1 = [0x4f, 0x8c, 0xff];
    const c2 = [0x7a, 0x4f, 0xff];
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const cov = roundRectCoverage(x + 0.5, y + 0.5, bx, by, bw, bh, radius);
        if (cov > 0) {
          const t = (x + y) / (s * 2);
          over(buf, (y * s + x) * 4, lerp(c1[0], c2[0], t) / 255, lerp(c1[1], c2[1], t) / 255, lerp(c1[2], c2[2], t) / 255, cov);
        }
      }
    }
  }

  // two overlapping "screens"
  const ink = mono ? [0, 0, 0] : [1, 1, 1];
  const inkA = mono ? 1 : 0.95;
  const screens = [
    { x: 0.24 * s, y: 0.30 * s, w: 0.36 * s, h: 0.28 * s, a: inkA },
    { x: 0.42 * s, y: 0.44 * s, w: 0.36 * s, h: 0.28 * s, a: inkA * 0.92 },
  ];
  const stroke = Math.max(1.2, s * 0.02);
  const rr = Math.max(1.5, s * 0.03);
  for (const sc of screens) {
    for (let y = Math.floor(sc.y - 2); y < sc.y + sc.h + 2; y++) {
      for (let x = Math.floor(sc.x - 2); x < sc.x + sc.w + 2; x++) {
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const outer = roundRectCoverage(x + 0.5, y + 0.5, sc.x, sc.y, sc.w, sc.h, rr);
        const inner = roundRectCoverage(x + 0.5, y + 0.5, sc.x + stroke, sc.y + stroke, sc.w - stroke * 2, sc.h - stroke * 2, Math.max(0.5, rr * 0.6));
        const ring = clamp(outer - inner, 0, 1);
        if (ring > 0) over(buf, (y * s + x) * 4, ink[0], ink[1], ink[2], ring * sc.a);
        if (!mono && inner > 0) over(buf, (y * s + x) * 4, 1, 1, 1, inner * 0.12 * sc.a);
      }
    }
  }

  // cursor (only on the full app icon — too small/busy on tray sizes)
  if (mode === 'app') {
    const ox = 0.52 * s, oy = 0.5 * s, scale = 0.12 * s;
    const pts = [[0, 0], [0, 1.0], [0.28, 0.74], [0.46, 1.12], [0.62, 1.04], [0.44, 0.66], [0.8, 0.62]]
      .map(([x, y]) => [ox + x * scale, oy + y * scale]);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        if (pointInPoly(x + 0.5, y + 0.5, pts)) over(buf, (y * s + x) * 4, 1, 1, 1, 0.98);
      }
    }
  }

  return encodePng(s, s, buf);
}

// ---- write -----------------------------------------------------------------

function write(rel, data) {
  const out = path.join(__dirname, '..', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log('wrote', rel);
}

// App icon — electron-builder resolves it from directories.buildResources
// ("buildResources/", deliberately NOT "build/" which node-gyp owns).
write('buildResources/icon.png', compose(1024, 'app'));

// Tray icons. Colored for Windows/Linux; black "...Template" for the macOS menu
// bar (auto-treated as a template image so it inverts in dark/light).
write('assets/tray.png', compose(16, 'trayColor'));
write('assets/tray@2x.png', compose(32, 'trayColor'));
write('assets/trayTemplate.png', compose(16, 'trayMono'));
write('assets/trayTemplate@2x.png', compose(32, 'trayMono'));
