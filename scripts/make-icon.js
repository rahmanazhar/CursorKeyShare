'use strict';
// Generates the CursorKeyShare app icon and tray icons with no external
// dependencies (pure Node zlib). Outputs:
//   buildResources/icon.png        1024x1024  app icon (electron-builder -> .icns/.ico)
//   assets/tray.png  / @2x         16/32      colored tray icon (Windows/Linux)
//   assets/trayTemplate.png / @2x  16/32      black template tray icon (macOS menu bar)
//
// The mark is a cursor pointer resting on a keyboard keycap — "Cursor" + "Key".

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

// Source-over alpha blend of rgb (0..1) at coverage a onto pixel i.
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

function fillRoundRect(buf, s, x, y, w, h, r, rgb, alpha) {
  for (let py = Math.floor(y - 2); py < y + h + 2; py++) {
    for (let px = Math.floor(x - 2); px < x + w + 2; px++) {
      if (px < 0 || py < 0 || px >= s || py >= s) continue;
      const cov = roundRectCoverage(px + 0.5, py + 0.5, x, y, w, h, r);
      if (cov > 0) over(buf, (py * s + px) * 4, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, cov * alpha);
    }
  }
}

// The classic arrow-cursor polygon, tip at (ox,oy), sized by `scale`.
function cursorPts(ox, oy, scale) {
  return [
    [0, 0], [0, 1.0], [0.28, 0.73], [0.45, 1.12], [0.60, 1.05], [0.43, 0.66], [0.75, 0.60],
  ].map(([x, y]) => [ox + x * scale, oy + y * scale]);
}

// Draw a filled, anti-aliased polygon (2x2 supersample).
function fillPoly(buf, s, pts, rgb, alpha) {
  let minX = s, minY = s, maxX = 0, maxY = 0;
  for (const p of pts) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  for (let py = Math.floor(minY - 1); py <= maxY + 1; py++) {
    for (let px = Math.floor(minX - 1); px <= maxX + 1; px++) {
      if (px < 0 || py < 0 || px >= s || py >= s) continue;
      let cov = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        if (pointInPoly(px + 0.25 + sx * 0.5, py + 0.25 + sy * 0.5, pts)) cov += 0.25;
      }
      if (cov > 0) over(buf, (py * s + px) * 4, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, cov * alpha);
    }
  }
}

// Cursor with a contrasting outline: draw the fill offset in the outline colour,
// then the fill on top.
function drawCursor(buf, s, ox, oy, scale, fill, outline, outlineW) {
  if (outline && outlineW > 0) {
    for (let a = 0; a < 8; a++) {
      const dx = Math.round(Math.cos((a / 8) * Math.PI * 2) * outlineW);
      const dy = Math.round(Math.sin((a / 8) * Math.PI * 2) * outlineW);
      fillPoly(buf, s, cursorPts(ox + dx, oy + dy, scale), outline, 1);
    }
  }
  fillPoly(buf, s, cursorPts(ox, oy, scale), fill, 1);
}

// ---- compose ---------------------------------------------------------------
// mode: 'app' (squircle bg + keycap + cursor), 'trayColor' (squircle + cursor),
//       'trayMono' (black cursor glyph on transparent, for the macOS menu bar).

function compose(size, mode) {
  const s = size;
  const buf = Buffer.alloc(s * s * 4, 0);
  const mono = mode === 'trayMono';

  // background squircle (skip for mono template)
  if (!mono) {
    const margin = s * 0.06;
    const bx = margin, by = margin, bw = s - margin * 2, bh = s - margin * 2;
    const radius = bw * 0.2237;
    const c1 = [0x54, 0x8b, 0xff]; // blue
    const c2 = [0x8b, 0x5c, 0xff]; // purple
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

  if (mono) {
    // Solid black cursor, centred — reads well at 16px in the menu bar.
    drawCursor(buf, s, s * 0.30, s * 0.14, s * 0.62, [0, 0, 0], null, 0);
    return encodePng(s, s, buf);
  }

  if (mode === 'app') {
    // Keycap: soft drop shadow, white cap, subtle bottom lip for depth.
    const kx = s * 0.29, ky = s * 0.30, kw = s * 0.42, kh = s * 0.42, kr = s * 0.11;
    fillRoundRect(buf, s, kx + s * 0.012, ky + s * 0.03, kw, kh, kr, [0, 0, 0], 0.20); // shadow
    fillRoundRect(buf, s, kx, ky, kw, kh, kr, [255, 255, 255], 1);                     // cap
    fillRoundRect(buf, s, kx + s * 0.05, ky + s * 0.05, kw - s * 0.10, kh - s * 0.10, kr * 0.7, [0x4a, 0x55, 0x77], 0.10); // inset face
    // Cursor sitting on the keycap: purple fill with a white outline so it reads
    // on both the white cap and the gradient where it overhangs.
    drawCursor(buf, s, s * 0.40, s * 0.235, s * 0.42, [0x53, 0x3a, 0xe6], [255, 255, 255], Math.max(2, s * 0.02));
    return encodePng(s, s, buf);
  }

  // trayColor: white cursor on the squircle.
  drawCursor(buf, s, s * 0.32, s * 0.16, s * 0.56, [255, 255, 255], null, 0);
  return encodePng(s, s, buf);
}

// ---- write -----------------------------------------------------------------

function write(rel, data) {
  const out = path.join(__dirname, '..', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log('wrote', rel);
}

// App icon — electron-builder resolves it from directories.buildResources.
write('buildResources/icon.png', compose(1024, 'app'));

// Tray icons. Colored for Windows/Linux; black "...Template" for the macOS menu
// bar (auto-treated as a template image so it inverts in dark/light).
write('assets/tray.png', compose(16, 'trayColor'));
write('assets/tray@2x.png', compose(32, 'trayColor'));
write('assets/trayTemplate.png', compose(16, 'trayMono'));
write('assets/trayTemplate@2x.png', compose(32, 'trayMono'));
