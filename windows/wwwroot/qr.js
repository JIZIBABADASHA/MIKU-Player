'use strict';
/* Minimal QR code generator (byte mode, error correction level M, versions 1–40).
   Follows ISO/IEC 18004; structure after Project Nayuki's reference implementation. */
const QR = (() => {
  const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

  const rawModules = v => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  };
  const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_M[v] * BLOCKS_M[v];

  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z & 0xFF;
  }
  function rsDivisor(deg) {
    const r = new Array(deg).fill(0);
    r[deg - 1] = 1;
    let root = 1;
    for (let i = 0; i < deg; i++) {
      for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
      root = mul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      div.forEach((c, i) => r[i] ^= mul(c, f));
    }
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    for (; ver <= 40; ver++) {
      const cap = dataCodewords(ver) * 8;
      if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    if (ver > 40) throw new Error('text too long for a QR code');

    // ── data bits ──
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(b => put(b, 8));
    const capBits = dataCodewords(ver) * 8;
    put(0, Math.min(4, capBits - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // ── error correction + interleave ──
    const nBlocks = BLOCKS_M[ver], eccLen = ECC_M[ver], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const code = [];
    for (let i = 0; i < blocks[0].length; i++)
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) code.push(b[i]); });

    // ── matrix ──
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      const pos = [6];
      for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
      pos.forEach((a, i) => pos.forEach((b, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }));
    }
    const format = mask => {
      const d = (0 << 3) | mask; // level M = 00
      let r = d;
      for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const b = ((d << 10) | r) ^ 0x5412;
      const bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    format(0);
    if (ver >= 7) {
      let r = ver;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = (ver << 12) | r;
      for (let i = 0; i < 18; i++) {
        const dark = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3);
        set(a, c, dark); set(c, a, dark);
      }
    }
    // codewords in the zig-zag order
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fn[y][x] && i < code.length * 8) { mod[y][x] = ((code[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }

    const masks = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
    ];
    const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x]; };
    const penalty = () => {
      let p = 0, dark = 0;
      for (let y = 0; y < size; y++) for (let pass = 0; pass < 2; pass++) {
        let run = 0, color = null;
        for (let x = 0; x < size; x++) {
          const c = pass ? mod[x][y] : mod[y][x];
          if (c === color) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { color = c; run = 1; }
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
      mod.forEach(r => r.forEach(c => { if (c) dark++; }));
      return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); format(m);
      const p = penalty();
      if (p < bestP) { bestP = p; best = m; }
      applyMask(m);
    }
    applyMask(best); format(best);
    return { size, modules: mod };
  }

  /** SVG markup for `text` (dark modules on a white, quiet-zoned square). */
  function svg(text, px = 180) {
    const { size, modules } = encode(text);
    const q = 4, n = size + q * 2;
    let d = '';
    modules.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + q},${y + q}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { encode, svg };
})();
if (typeof module !== 'undefined') module.exports = QR;
