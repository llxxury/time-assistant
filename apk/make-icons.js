// 生成「排程」的图标：靛蓝底 + 三条白色横条。不依赖任何图像库，直接写 PNG。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let T = null;
function crc32(buf) {
  if (!T) {
    T = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      T[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形覆盖率，带一点抗锯齿 */
function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) return 0;
  if (x >= x0 + r && x <= x1 - r) return y >= y0 && y <= y1 ? 1 : 0;
  if (y >= y0 + r && y <= y1 - r) return x >= x0 && x <= x1 ? 1 : 0;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}

const ACCENT = [0x4f, 0x6e, 0xf7];
const SIZE = 432;

function draw(background, glyph) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const bars = [
    [140, 170, 292, 190],
    [140, 214, 260, 234],
    [140, 258, 228, 278],
  ];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (background) {
        const cov = roundRect(x, y, 0, 0, SIZE - 1, SIZE - 1, 96);
        if (cov > 0) {
          r = ACCENT[0];
          g = ACCENT[1];
          b = ACCENT[2];
          a = Math.round(255 * cov);
        }
      }

      if (glyph) {
        for (const [x0, y0, x1, y1] of bars) {
          const cov = roundRect(x, y, x0, y0, x1, y1, (y1 - y0) / 2);
          if (cov > 0) {
            r = 255;
            g = 255;
            b = 255;
            a = Math.max(a, Math.round(255 * cov));
          }
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

const dir = path.join(__dirname, 'res/mipmap');
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'ic_launcher_background.png'), png(SIZE, SIZE, draw(true, false)));
fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png(SIZE, SIZE, draw(false, true)));
fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png(SIZE, SIZE, draw(true, true)));

console.log('icons ->', dir);
