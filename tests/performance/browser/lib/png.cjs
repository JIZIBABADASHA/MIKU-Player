'use strict';
// A dependency-free PNG encoder for test covers: a soft gradient, a few discs and a little noise, different for every
// seed, so decoding and scaling cost roughly what a real cover does.
const zlib = require('node:zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const cache = new Map();
/** A size×size PNG for `seed` (cached). */
function cover(seed, size) {
  const key = seed + ':' + size;
  let png = cache.get(key);
  if (png) return png;
  const r = rng(seed + 1);
  const c0 = [r() * 255, r() * 255, r() * 255], c1 = [r() * 255, r() * 255, r() * 255];
  const discs = Array.from({ length: 4 }, () => ({ x: r() * size, y: r() * size, rad: (0.08 + r() * 0.25) * size, c: [r() * 255, r() * 255, r() * 255] }));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let px = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
      for (const d of discs) { const dx = x - d.x, dy = y - d.y; if (dx * dx + dy * dy < d.rad * d.rad) px = d.c; }
      const n = (r() - .5) * 14;
      raw[o++] = Math.max(0, Math.min(255, px[0] + n)); raw[o++] = Math.max(0, Math.min(255, px[1] + n)); raw[o++] = Math.max(0, Math.min(255, px[2] + n));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
  cache.set(key, png);
  return png;
}
module.exports = { cover };
