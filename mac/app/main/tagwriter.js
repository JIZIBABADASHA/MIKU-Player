'use strict';
// Writes tags into music files (tag editor 「編輯標籤」), the Mac counterpart of TagWriter (TagLib) in TagEditor.cs.
// Only the fields that were changed are written; everything else in the file is kept as it was.
//
//   FLAC          Vorbis comments + PICTURE blocks (in place when the padding has room)
//   MP3           ID3v2 at the start (the version found is kept; a new tag is v2.3)
//   WAV / AIFF    ID3v2 chunk (and the RIFF INFO fields MIKU reads, when the file has them)
//   DSF           ID3v2 at the end, the header pointing at it (in place)
//   M4A / MP4     iTunes ilst atoms; chunk offsets are moved when moov grows
//   OGG / Opus    Vorbis comment header, pages rebuilt
//   APE / WavPack APEv2 tag at the end
//   DFF           an "ID3 " chunk in the FRM8 form (as foobar2000 / JRiver / TagLib write it)
// TAK, TTA, MKA, MP2, CAF and WMA can't be written.
//
// A file that is rewritten as a whole is written next to it first, checked with ffprobe (same audio stream and
// length) and only then put in place of the original.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Fields = ['title', 'artist', 'albumArtist', 'album', 'genre', 'composer', 'year', 'track', 'trackTotal', 'disc', 'discTotal'];
const Multi = new Set(['artist', 'albumArtist', 'genre', 'composer']);
const Writable = new Set(['.flac', '.mp3', '.wav', '.aif', '.aiff', '.aifc', '.dsf', '.dff', '.m4a', '.mp4', '.aac', '.alac', '.ogg', '.oga', '.opus', '.ape', '.wv']);

const ext = p => path.extname(p).toLowerCase();
const canWrite = p => Writable.has(ext(p));

const clean = v => String(v == null ? '' : v).replace(/\0/g, ' ').trim();
const splitNames = v => [...new Set(clean(v).split(';').map(s => s.trim()).filter(Boolean))];
const num = v => { const n = parseInt(clean(v), 10); return Number.isFinite(n) && n > 0 ? n : 0; };
/** "3/12" → [3, 12] */
const pair = s => { const m = /^\s*(\d*)\s*(?:\/\s*(\d*))?/.exec(s || ''); return [m && m[1] ? +m[1] : 0, m && m[2] ? +m[2] : 0]; };

/** Normalised changes: text fields → string ('' clears), multi fields → array, numbers → int (0 clears). */
function normalise(set) {
  const out = {};
  for (const k of Fields) {
    if (!(k in (set || {}))) continue;
    if (Multi.has(k)) out[k] = splitNames(set[k]);
    else if (['year', 'track', 'trackTotal', 'disc', 'discTotal'].includes(k)) out[k] = num(set[k]);
    else out[k] = clean(set[k]);
  }
  return out;
}

function imageSize(b) {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      if (len < 2) break;
      i += 2 + len;
    }
  }
  return [0, 0];
}

/** FLAC / Vorbis METADATA_BLOCK_PICTURE body. */
function flacPicture(cover) {
  const mime = Buffer.from(cover.mime, 'latin1');
  const [w, h] = imageSize(cover.data);
  const b = Buffer.alloc(32 + mime.length + cover.data.length);
  let o = 0;
  b.writeUInt32BE(3, o); o += 4;
  b.writeUInt32BE(mime.length, o); o += 4; mime.copy(b, o); o += mime.length;
  b.writeUInt32BE(0, o); o += 4;                       // description
  b.writeUInt32BE(w, o); o += 4; b.writeUInt32BE(h, o); o += 4;
  b.writeUInt32BE(24, o); o += 4; b.writeUInt32BE(0, o); o += 4;
  b.writeUInt32BE(cover.data.length, o); o += 4; cover.data.copy(b, o);
  return b;
}
const flacPictureType = body => body.length >= 4 ? body.readUInt32BE(0) : 0;

// ───────────────────────────── Vorbis comments (FLAC, Ogg) ─────────────────────────────
function parseVorbis(b) {
  let o = 0;
  const vl = b.readUInt32LE(o); o += 4;
  const vendor = b.toString('utf8', o, o + vl); o += vl;
  const n = b.readUInt32LE(o); o += 4;
  const list = [];
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const l = b.readUInt32LE(o); o += 4;
    list.push(b.toString('utf8', o, o + l)); o += l;
  }
  return { vendor, list, rest: b.slice(o) };
}
function renderVorbis(vc) {
  const parts = [];
  const v = Buffer.from(vc.vendor, 'utf8');
  const u32 = n => { const x = Buffer.alloc(4); x.writeUInt32LE(n); return x; };
  parts.push(u32(v.length), v, u32(vc.list.length));
  for (const s of vc.list) { const x = Buffer.from(s, 'utf8'); parts.push(u32(x.length), x); }
  return Buffer.concat(parts);
}
const vkey = s => { const i = s.indexOf('='); return i < 0 ? s.toUpperCase() : s.slice(0, i).toUpperCase(); };
const vval = s => { const i = s.indexOf('='); return i < 0 ? '' : s.slice(i + 1); };

/** Applies the changes to a list of "KEY=value" comments (and the cover, for Ogg). */
function applyVorbis(list, ch, cover, removeCover, withPictures) {
  const get = k => { const x = list.find(s => vkey(s) === k); return x == null ? '' : vval(x); };
  const drop = (...ks) => { for (let i = list.length - 1; i >= 0; i--) if (ks.includes(vkey(list[i]))) list.splice(i, 1); };
  const put = (k, vals) => { for (const v of vals) if (v !== '' && v != null) list.push(k + '=' + v); };
  const text = { title: 'TITLE', album: 'ALBUM' };
  for (const [f, k] of Object.entries(text)) if (f in ch) { drop(k); put(k, [ch[f]]); }
  const multi = { artist: ['ARTIST'], albumArtist: ['ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'], genre: ['GENRE'], composer: ['COMPOSER'] };
  for (const [f, ks] of Object.entries(multi)) if (f in ch) { drop(...ks); put(ks[0], ch[f]); }
  if ('year' in ch) {
    const old = get('DATE') || get('YEAR');
    drop('DATE', 'YEAR');
    if (ch.year) put('DATE', [old && old.startsWith(String(ch.year)) ? old : String(ch.year)]);
  }
  for (const [nf, tf, nk, tks] of [['track', 'trackTotal', 'TRACKNUMBER', ['TRACKTOTAL', 'TOTALTRACKS']], ['disc', 'discTotal', 'DISCNUMBER', ['DISCTOTAL', 'TOTALDISCS']]]) {
    if (!(nf in ch) && !(tf in ch)) continue;
    const [n0, t0] = pair(get(nk));
    const total0 = num(tks.map(get).find(Boolean)) || t0;
    const n = nf in ch ? ch[nf] : n0, t = tf in ch ? ch[tf] : total0;
    drop(nk, ...tks);
    if (n) put(nk, [String(n)]);
    if (t) put(tks[0], [String(t)]);
  }
  if (withPictures && (cover || removeCover)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const k = vkey(list[i]);
      if (k === 'COVERART' || k === 'COVERARTMIME') { list.splice(i, 1); continue; }
      if (k === 'METADATA_BLOCK_PICTURE') {
        let type = 3;
        try { type = flacPictureType(Buffer.from(vval(list[i]), 'base64')); } catch { }
        if (type === 3 || type === 0) list.splice(i, 1);
      }
    }
    if (cover && !removeCover) list.push('METADATA_BLOCK_PICTURE=' + flacPicture(cover).toString('base64'));
  }
}

// ───────────────────────────── FLAC ─────────────────────────────
function writeFlac(file, ch, cover, removeCover) {
  const fd = fs.openSync(file, 'r');
  let start = 0, blocks = [], audio;
  try {
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') start = 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, start);
    if (magic.toString('latin1') !== 'fLaC') throw new Error('不是 FLAC 檔案');
    let pos = start + 4, last = false;
    while (!last) {
      const h = Buffer.alloc(4);
      if (fs.readSync(fd, h, 0, 4, pos) !== 4) throw new Error('FLAC 檔案不完整');
      last = !!(h[0] & 0x80);
      const type = h[0] & 0x7F, len = h.readUIntBE(1, 3);
      const body = Buffer.alloc(len);
      fs.readSync(fd, body, 0, len, pos + 4);
      blocks.push({ type, body });
      pos += 4 + len;
    }
    audio = pos;
  } finally { fs.closeSync(fd); }
  const oldLen = audio - start - 4;
  // comments
  let vcBlock = blocks.find(b => b.type === 4);
  const vc = vcBlock ? parseVorbis(vcBlock.body) : { vendor: 'MIKU', list: [] };
  applyVorbis(vc.list, ch, null, false, false);
  const vcBody = renderVorbis(vc);
  if (vcBlock) vcBlock.body = vcBody; else blocks.splice(1, 0, vcBlock = { type: 4, body: vcBody });
  // pictures: front cover (and "other") replaced, the rest kept
  if (cover || removeCover) {
    blocks = blocks.filter(b => !(b.type === 6 && [0, 3].includes(flacPictureType(b.body))));
    if (cover && !removeCover) blocks.splice(blocks.indexOf(vcBlock) + 1, 0, { type: 6, body: flacPicture(cover) });
  }
  blocks = blocks.filter(b => b.type !== 1);   // padding is made again
  for (const b of blocks) if (b.body.length > 0xFFFFFF) throw new Error('封面圖片太大');
  const used = blocks.reduce((s, b) => s + 4 + b.body.length, 0);
  const render = pad => {
    const all = pad >= 0 ? [...blocks, { type: 1, body: Buffer.alloc(pad) }] : blocks;
    return Buffer.concat(all.map((b, i) => { const h = Buffer.alloc(4); h[0] = b.type | (i === all.length - 1 ? 0x80 : 0); h.writeUIntBE(b.body.length, 1, 3); return Buffer.concat([h, b.body]); }));
  };
  // fits in the old metadata area (with a padding block of at least 0 bytes): write it in place
  if (used + 4 <= oldLen && oldLen - used - 4 <= 0xFFFFFF) {
    const meta = render(oldLen - used - 4);
    const w = fs.openSync(file, 'r+');
    try { fs.writeSync(w, meta, 0, meta.length, start + 4); } finally { fs.closeSync(w); }
    return;
  }
  if (used === oldLen) { const meta = render(-1); const w = fs.openSync(file, 'r+'); try { fs.writeSync(w, meta, 0, meta.length, start + 4); } finally { fs.closeSync(w); } return; }
  const meta = render(4096);
  return rewrite(file, [{ file, start: 0, end: start + 4 }, meta, { file, start: audio }]);
}

// ───────────────────────────── ID3v2 ─────────────────────────────
function synchsafe(b, o) { return ((b[o] & 0x7F) << 21) | ((b[o + 1] & 0x7F) << 14) | ((b[o + 2] & 0x7F) << 7) | (b[o + 3] & 0x7F); }
function toSynchsafe(n) { const b = Buffer.alloc(4); b[0] = (n >> 21) & 0x7F; b[1] = (n >> 14) & 0x7F; b[2] = (n >> 7) & 0x7F; b[3] = n & 0x7F; return b; }
function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xFF && b[i + 1] === 0x00) i++; }
  return Buffer.from(out);
}

/** Parses an ID3v2 tag (buffer starting with "ID3"): { major, frames: [{ id, flags, data }], size } or throws. */
function parseId3(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = buf[3], flags = buf[5], size = synchsafe(buf, 6);
  if (major === 2) throw new Error('不支援 ID3v2.2 標籤');
  if (major !== 3 && major !== 4) throw new Error('不支援的 ID3 版本');
  let body = buf.slice(10, 10 + size);
  if (flags & 0x80 && major === 3) body = unsync(body);
  let o = 0;
  if (flags & 0x40) o = major === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  const frames = [];
  while (o + 10 <= body.length) {
    const id = body.toString('latin1', o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = major === 4 ? synchsafe(body, o + 4) : body.readUInt32BE(o + 4);
    const fl = body.readUInt16BE(o + 8);
    if (o + 10 + len > body.length) break;
    frames.push({ id, flags: fl, data: Buffer.from(body.slice(o + 10, o + 10 + len)) });
    o += 10 + len;
  }
  return { major, frames, size: 10 + size + (major === 4 && (flags & 0x10) ? 10 : 0) };
}

function frameText(f, major) {
  let d = f.data;
  if (major === 4 && (f.flags & 0x0002)) d = unsync(d);
  if (major === 4 && (f.flags & 0x0001)) d = d.slice(4);
  if (!d.length) return '';
  const enc = d[0], b = d.slice(1);
  let s;
  if (enc === 0) s = b.toString('latin1');
  else if (enc === 3) s = b.toString('utf8');
  else if (enc === 1) { s = (b[0] === 0xFE ? swap16(b.slice(2)) : b.slice(b[0] === 0xFF ? 2 : 0)).toString('utf16le'); }
  else s = swap16(b).toString('utf16le');
  return s.replace(/\0+$/, '').split('\0').join('; ');
}
function swap16(b) { const c = Buffer.from(b.slice(0, b.length & ~1)); c.swap16(); return c; }

function textFrame(id, value, major) {
  let data;
  if (major === 4) data = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
  else if (/^[\x00-\xFF]*$/.test(value)) data = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]);
  else data = Buffer.concat([Buffer.from([1, 0xFF, 0xFE]), Buffer.from(value, 'utf16le')]);
  return { id, flags: 0, data };
}
function apicFrame(cover) {
  return { id: 'APIC', flags: 0, data: Buffer.concat([Buffer.from([0]), Buffer.from(cover.mime, 'latin1'), Buffer.from([0, 3, 0]), cover.data]) };
}
function apicType(f, major) {
  let d = f.data;
  if (major === 4 && (f.flags & 0x0002)) d = unsync(d);
  if (major === 4 && (f.flags & 0x0001)) d = d.slice(4);
  const z = d.indexOf(0, 1);
  return z < 0 ? 3 : d[z + 1];
}

/** The tag after the changes, rendered (with `padding` bytes of padding). */
function applyId3(old, ch, cover, removeCover, padding = 1024) {
  const major = old ? old.major : 3;
  let frames = old ? old.frames.slice() : [];
  const get = id => { const f = frames.find(x => x.id === id); return f ? frameText(f, major) : ''; };
  const set = (id, value) => {
    const i = frames.findIndex(x => x.id === id);
    frames = frames.filter(x => x.id !== id);
    if (value) frames.splice(i < 0 ? frames.length : i, 0, textFrame(id, value, major));
  };
  if ('title' in ch) set('TIT2', ch.title);
  if ('album' in ch) set('TALB', ch.album);
  if ('artist' in ch) set('TPE1', ch.artist.join('; '));
  if ('albumArtist' in ch) set('TPE2', ch.albumArtist.join('; '));
  if ('genre' in ch) set('TCON', ch.genre.join('; '));
  if ('composer' in ch) set('TCOM', ch.composer.join('; '));
  if ('year' in ch) {
    const old = get('TDRC') || get('TYER');
    const y = ch.year ? (old && old.startsWith(String(ch.year)) ? old : String(ch.year)) : '';
    frames = frames.filter(x => x.id !== 'TDRC' && x.id !== 'TYER' && x.id !== 'TDAT');
    if (y) frames.push(textFrame(major === 4 ? 'TDRC' : 'TYER', major === 4 ? y : y.slice(0, 4), major));
  }
  for (const [id, nf, tf] of [['TRCK', 'track', 'trackTotal'], ['TPOS', 'disc', 'discTotal']]) {
    if (!(nf in ch) && !(tf in ch)) continue;
    const [n0, t0] = pair(get(id));
    const n = nf in ch ? ch[nf] : n0, t = tf in ch ? ch[tf] : t0;
    set(id, n ? (t ? `${n}/${t}` : String(n)) : '');
  }
  if (cover || removeCover) {
    frames = frames.filter(f => !(f.id === 'APIC' && [0, 3].includes(apicType(f, major))));
    if (cover && !removeCover) frames.unshift(apicFrame(cover));
  }
  const body = Buffer.concat(frames.map(f => {
    const h = Buffer.alloc(10);
    h.write(f.id, 0, 'latin1');
    if (major === 4) toSynchsafe(f.data.length).copy(h, 4); else h.writeUInt32BE(f.data.length, 4);
    h.writeUInt16BE(f.flags, 8);
    return Buffer.concat([h, f.data]);
  }));
  const total = body.length + padding;
  const head = Buffer.from([0x49, 0x44, 0x33, major, 0, 0, 0, 0, 0, 0]);
  toSynchsafe(total).copy(head, 6);
  return Buffer.concat([head, body, Buffer.alloc(padding)]);
}

function writeMp3(file, ch, cover, removeCover) {
  const fd = fs.openSync(file, 'r');
  let old = null, oldSize = 0;
  try {
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    if (head.toString('latin1', 0, 3) === 'ID3') {
      const size = 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      old = parseId3(buf); oldSize = size;
    }
  } finally { fs.closeSync(fd); }
  const probe = applyId3(old, ch, cover, removeCover, 0);
  // fits where the old tag was: write it in place, padded to the same size
  if (old && probe.length <= oldSize && !(old.major === 4 && oldSize !== old.size)) {
    const tag = applyId3(old, ch, cover, removeCover, oldSize - probe.length);
    const w = fs.openSync(file, 'r+');
    try { fs.writeSync(w, tag, 0, tag.length, 0); } finally { fs.closeSync(w); }
    return;
  }
  const tag = applyId3(old, ch, cover, removeCover, 2048);
  return rewrite(file, [tag, { file, start: oldSize }]);
}

function writeDsf(file, ch, cover, removeCover) {
  const fd = fs.openSync(file, 'r+');
  try {
    const st = fs.fstatSync(fd);
    const head = Buffer.alloc(28);
    if (fs.readSync(fd, head, 0, 28, 0) !== 28 || head.toString('latin1', 0, 4) !== 'DSD ') throw new Error('不是 DSF 檔案');
    const meta = Number(head.readBigInt64LE(20));
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 8, 28 + 4);
    const fmtSize = Number(b.readBigInt64LE(0));
    fs.readSync(fd, b, 0, 12, 28 + fmtSize);
    if (b.toString('latin1', 0, 4) !== 'data') throw new Error('DSF data chunk 缺失');
    const dataEnd = 28 + fmtSize + Number(b.readBigInt64LE(4));
    if (dataEnd > st.size) throw new Error('DSF 檔案不完整');
    let old = null;
    if (meta > 0 && meta < st.size) {
      const buf = Buffer.alloc(st.size - meta);
      fs.readSync(fd, buf, 0, buf.length, meta);
      try { old = parseId3(buf); } catch (e) { if (/ID3v2\.2|版本/.test(e.message)) throw e; old = null; }
    }
    const tag = applyId3(old, ch, cover, removeCover, 0);
    const at = meta > 0 && meta >= dataEnd && meta <= st.size ? meta : dataEnd;
    fs.ftruncateSync(fd, at);
    fs.writeSync(fd, tag, 0, tag.length, at);
    const n = Buffer.alloc(8);
    n.writeBigInt64LE(BigInt(at + tag.length)); fs.writeSync(fd, n, 0, 8, 12);
    n.writeBigInt64LE(BigInt(at)); fs.writeSync(fd, n, 0, 8, 20);
  } finally { fs.closeSync(fd); }
}

/**
 * DFF (DSDIFF): big-endian chunks inside "FRM8" (8-byte size), form type "DSD "; the tag is an "ID3 " chunk with an
 * ID3v2 tag. The old tag chunk at the end is cut off and the new one appended; one before the audio means a rebuild
 * through a temporary file. The audio data is copied byte for byte.
 */
function writeDff(file, ch, cover, removeCover) {
  const fd = fs.openSync(file, 'r+');
  let chunks, tag, keepEnd = 16, inPlace;
  try {
    const st = fs.fstatSync(fd);
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.toString('latin1', 0, 4) !== 'FRM8' || head.toString('latin1', 12, 16) !== 'DSD ') throw new Error('不是 DFF 檔案');
    const end = Math.min(st.size, 12 + Number(head.readBigInt64BE(4)));
    chunks = [];
    const c = Buffer.alloc(12);
    for (let pos = 16; pos + 12 <= end;) {
      fs.readSync(fd, c, 0, 12, pos);
      const id = c.toString('latin1', 0, 4);
      let size = Number(c.readBigInt64BE(4));
      if (size < 0 || pos + 12 + size > st.size) size = st.size - pos - 12;   // a truncated last chunk
      chunks.push({ id, pos, size });
      pos += 12 + size + (size & 1);
    }
    if (!chunks.some(x => x.id === 'DSD ' || x.id === 'DST ')) throw new Error('DFF 沒有音訊資料');
    let old = null;
    const o = chunks.find(x => x.id === 'ID3 ');
    if (o && o.size > 10) {
      const buf = Buffer.alloc(Math.min(o.size, 64 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, o.pos + 12);
      try { old = parseId3(buf); } catch (e) { if (/ID3v2\.2|版本/.test(e.message)) throw e; old = null; }
    }
    tag = applyId3(old, ch, cover, removeCover, 0);
    for (const x of chunks) if (x.id !== 'ID3 ') keepEnd = Math.max(keepEnd, x.pos + 12 + x.size + (x.size & 1));
    inPlace = chunks.filter(x => x.id === 'ID3 ').every(x => x.pos >= keepEnd);
    const tagChunk = Buffer.alloc(12 + tag.length + (tag.length & 1));
    tagChunk.write('ID3 ', 0, 'latin1'); tagChunk.writeBigInt64BE(BigInt(tag.length), 4); tag.copy(tagChunk, 12);
    if (inPlace) {
      fs.ftruncateSync(fd, keepEnd);
      fs.writeSync(fd, tagChunk, 0, tagChunk.length, keepEnd);
      const n = Buffer.alloc(8); n.writeBigInt64BE(BigInt(keepEnd + tagChunk.length - 12)); fs.writeSync(fd, n, 0, 8, 4);
      return;
    }
    const kept = chunks.filter(x => x.id !== 'ID3 ');
    const size = 16 + kept.reduce((s, x) => s + 12 + x.size + (x.size & 1), 0) + tagChunk.length;
    const h = Buffer.from(head); h.writeBigInt64BE(BigInt(size - 12), 4);
    return rewrite(file, [h, ...kept.map(x => ({ file, start: x.pos, end: x.pos + 12 + x.size + (x.size & 1) })), tagChunk]);
  } finally { fs.closeSync(fd); }
}

// ───────────────────────────── RIFF (WAV) / AIFF ─────────────────────────────
function readChunks(file, big) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const h = Buffer.alloc(12);
    fs.readSync(fd, h, 0, 12, 0);
    const chunks = [];
    let pos = 12;
    while (pos + 8 <= st.size) {
      const c = Buffer.alloc(8);
      fs.readSync(fd, c, 0, 8, pos);
      const id = c.toString('latin1', 0, 4);
      let size = big ? c.readUInt32BE(4) : c.readUInt32LE(4);
      if (pos + 8 + size > st.size) size = st.size - pos - 8;   // a truncated last chunk
      chunks.push({ id, pos, size });
      pos += 8 + size + (size & 1);
    }
    return { form: h.toString('latin1', 0, 4), type: h.toString('latin1', 8, 12), chunks, size: st.size, fd: null };
  } finally { fs.closeSync(fd); }
}
function readRange(file, start, len) { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b; } finally { fs.closeSync(fd); } }

/** RIFF INFO fields MIKU (ffmpeg) reads, updated when the file has an INFO list. */
function applyInfo(body, ch) {
  // body: "INFO" + subchunks
  const items = [];
  let o = 4;
  while (o + 8 <= body.length) {
    const id = body.toString('latin1', o, o + 4), size = body.readUInt32LE(o + 4);
    items.push({ id, data: body.slice(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  const put = (id, v) => {
    const i = items.findIndex(x => x.id === id);
    const rest = items.filter(x => x.id !== id);
    if (v) rest.splice(i < 0 ? rest.length : i, 0, { id, data: Buffer.concat([Buffer.from(v, 'utf8'), Buffer.from([0])]) });
    items.length = 0; items.push(...rest);
  };
  if ('title' in ch) put('INAM', ch.title);
  if ('artist' in ch) put('IART', ch.artist.join('; '));
  if ('album' in ch) put('IPRD', ch.album);
  if ('genre' in ch) put('IGNR', ch.genre.join('; '));
  if ('year' in ch) put('ICRD', ch.year ? String(ch.year) : '');
  if ('track' in ch && items.some(x => x.id === 'ITRK' || x.id === 'IPRT')) { put('ITRK', ch.track ? String(ch.track) : ''); put('IPRT', ''); }
  return Buffer.concat([Buffer.from('INFO', 'latin1'), ...items.map(x => {
    const h = Buffer.alloc(8); h.write(x.id, 0, 'latin1'); h.writeUInt32LE(x.data.length, 4);
    return Buffer.concat([h, x.data, Buffer.alloc(x.data.length & 1)]);
  })]);
}

function writeRiffLike(file, ch, cover, removeCover) {
  const head = readRange(file, 0, 12);
  const form = head.toString('latin1', 0, 4);
  const big = form === 'FORM';
  if (!(form === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') && !(big && /^AIF[FC]$/.test(head.toString('latin1', 8, 12)))) throw new Error('不支援這種 WAV / AIFF 檔案');
  const r = readChunks(file, big);
  const id3Chunk = r.chunks.find(c => c.id === 'id3 ' || c.id === 'ID3 ');
  let old = null;
  if (id3Chunk) old = parseId3(readRange(file, id3Chunk.pos + 8, id3Chunk.size));
  const tag = applyId3(old, ch, cover, removeCover, 0);
  const pieces = [];
  const u32 = n => { const b = Buffer.alloc(4); if (big) b.writeUInt32BE(n); else b.writeUInt32LE(n); return b; };
  const chunkHead = (id, len) => Buffer.concat([Buffer.from(id, 'latin1'), u32(len)]);
  let total = 4;
  for (const c of r.chunks) {
    if (c === id3Chunk) continue;
    if (!big && c.id === 'LIST') {
      const body = readRange(file, c.pos + 8, c.size);
      if (body.toString('latin1', 0, 4) === 'INFO') {
        const nb = applyInfo(body, ch);
        pieces.push(chunkHead('LIST', nb.length), nb, Buffer.alloc(nb.length & 1));
        total += 8 + nb.length + (nb.length & 1);
        continue;
      }
    }
    const len = 8 + c.size + (c.size & 1);
    pieces.push({ file, start: c.pos, end: c.pos + len });
    total += len;
  }
  const id = id3Chunk ? id3Chunk.id : (big ? 'ID3 ' : 'id3 ');
  pieces.push(chunkHead(id, tag.length), tag, Buffer.alloc(tag.length & 1));
  total += 8 + tag.length + (tag.length & 1);
  if (total > 0xFFFFFFFF) throw new Error('檔案太大');
  const top = Buffer.concat([Buffer.from(form, 'latin1'), u32(total), head.slice(8, 12)]);
  return rewrite(file, [top, ...pieces]);
}

// ───────────────────────────── MP4 ─────────────────────────────
const Containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'ilst']);
function atoms(b, start = 0, end = b.length) {
  const list = [];
  let o = start;
  while (o + 8 <= end) {
    let size = b.readUInt32BE(o), hl = 8;
    const type = b.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(b.readBigUInt64BE(o + 8)); hl = 16; } else if (size === 0) size = end - o;
    if (size < hl || o + size > end) break;
    list.push({ type, start: o, size, hl });
    o += size;
  }
  return list;
}
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
/** Adds `delta` to every chunk offset (stco / co64) in the moov buffer. */
function shiftOffsets(b, start, end, delta) {
  for (const a of atoms(b, start, end)) {
    if (Containers.has(a.type) && a.type !== 'ilst') shiftOffsets(b, a.start + a.hl, a.start + a.size, delta);
    else if (a.type === 'stco') {
      const n = b.readUInt32BE(a.start + 12);
      for (let i = 0; i < n; i++) { const p = a.start + 16 + i * 4; const v = b.readUInt32BE(p) + delta; if (v > 0xFFFFFFFF) throw new Error('檔案太大，無法寫入標籤'); b.writeUInt32BE(v, p); }
    } else if (a.type === 'co64') {
      const n = b.readUInt32BE(a.start + 12);
      for (let i = 0; i < n; i++) { const p = a.start + 16 + i * 8; b.writeBigUInt64BE(b.readBigUInt64BE(p) + BigInt(delta), p); }
    }
  }
}
function mp4Text(type, value) {
  const data = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(value, 'utf8')]);
  return box(type, box('data', data));
}
function mp4Pair(type, n, t, disk) {
  const v = Buffer.alloc(disk ? 6 : 8);
  v.writeUInt16BE(n, 2); v.writeUInt16BE(t, 4);
  return box(type, box('data', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), v));
}
function writeMp4(file, ch, cover, removeCover) {
  const st = fs.statSync(file);
  const top = [];
  { // top-level atoms (headers only)
    const fd = fs.openSync(file, 'r');
    try {
      let o = 0;
      while (o + 8 <= st.size) {
        const h = Buffer.alloc(16);
        fs.readSync(fd, h, 0, 16, o);
        let size = h.readUInt32BE(0), hl = 8;
        if (size === 1) { size = Number(h.readBigUInt64BE(8)); hl = 16; } else if (size === 0) size = st.size - o;
        if (size < 8) break;
        top.push({ type: h.toString('latin1', 4, 8), start: o, size, hl });
        o += size;
      }
    } finally { fs.closeSync(fd); }
  }
  if (top.some(a => a.type === 'moof')) throw new Error('不支援分段的 MP4');
  const moovA = top.find(a => a.type === 'moov');
  if (!moovA) throw new Error('MP4 檔案沒有 moov');
  const moov = readRange(file, moovA.start, moovA.size);
  // the item list, as a map of the atoms it holds
  const kids = atoms(moov, moovA.hl, moov.length);
  const udtaA = kids.find(a => a.type === 'udta');
  let udtaKids = udtaA ? atoms(moov, udtaA.start + 8, udtaA.start + udtaA.size) : [];
  const metaA = udtaKids.find(a => a.type === 'meta');
  let metaKids = [], ilstItems = [];
  if (metaA) {
    metaKids = atoms(moov, metaA.start + 12, metaA.start + metaA.size);
    const il = metaKids.find(a => a.type === 'ilst');
    if (il) ilstItems = atoms(moov, il.start + 8, il.start + il.size).map(a => ({ type: a.type, buf: moov.slice(a.start, a.start + a.size) }));
  }
  const dataOf = it => { const d = atoms(it.buf, 8).find(a => a.type === 'data'); return d ? it.buf.slice(d.start + 16, d.start + d.size) : Buffer.alloc(0); };
  const getText = t => { const it = ilstItems.find(x => x.type === t); return it ? dataOf(it).toString('utf8') : ''; };
  const getPair = t => { const it = ilstItems.find(x => x.type === t); const d = it ? dataOf(it) : null; return d && d.length >= 6 ? [d.readUInt16BE(2), d.readUInt16BE(4)] : [0, 0]; };
  const setItem = (t, buf) => {
    const i = ilstItems.findIndex(x => x.type === t);
    ilstItems = ilstItems.filter(x => x.type !== t);
    if (buf) ilstItems.splice(i < 0 ? ilstItems.length : i, 0, { type: t, buf });
  };
  const text = (t, v) => setItem(t, v ? mp4Text(t, v) : null);
  if ('title' in ch) text('©nam', ch.title);
  if ('album' in ch) text('©alb', ch.album);
  if ('artist' in ch) text('©ART', ch.artist.join('; '));
  if ('albumArtist' in ch) text('aART', ch.albumArtist.join('; '));
  if ('genre' in ch) { setItem('gnre', null); text('©gen', ch.genre.join('; ')); }
  if ('composer' in ch) text('©wrt', ch.composer.join('; '));
  if ('year' in ch) { const old = getText('©day'); text('©day', ch.year ? (old.startsWith(String(ch.year)) ? old : String(ch.year)) : ''); }
  for (const [t, nf, tf, disk] of [['trkn', 'track', 'trackTotal', false], ['disk', 'disc', 'discTotal', true]]) {
    if (!(nf in ch) && !(tf in ch)) continue;
    const [n0, t0] = getPair(t);
    const n = nf in ch ? ch[nf] : n0, tt = tf in ch ? ch[tf] : t0;
    setItem(t, n || tt ? mp4Pair(t, n, tt, disk) : null);
  }
  if (cover || removeCover) {
    // covr holds every picture; MP4 has no picture types: the cover replaces them all
    setItem('covr', cover && !removeCover ? box('covr', box('data', Buffer.from([0, 0, 0, cover.mime === 'image/png' ? 14 : 13, 0, 0, 0, 0]), cover.data)) : null);
  }
  const ilst = box('ilst', ...ilstItems.map(x => x.buf));
  const hdlr = box('hdlr', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9));
  const metaParts = metaA ? metaKids.filter(a => a.type !== 'ilst').map(a => moov.slice(a.start, a.start + a.size)) : [hdlr];
  const meta = box('meta', Buffer.from([0, 0, 0, 0]), ...metaParts, ilst);
  const udtaParts = udtaKids.filter(a => a.type !== 'meta').map(a => moov.slice(a.start, a.start + a.size));
  const udta = box('udta', ...udtaParts, meta);
  const oldTail = Buffer.from(moov.slice(moovA.hl));
  // a moov written before the audio moves it: shift the chunk offsets by the change in size
  const rebuilt = () => {
    const parts = kids.filter(a => a.type !== 'udta').map(a => oldTail.slice(a.start - moovA.hl, a.start - moovA.hl + a.size));
    return box('moov', ...parts, udta);
  };
  let newMoov = rebuilt();
  const mdat = top.find(a => a.type === 'mdat');
  const before = mdat && mdat.start > moovA.start;
  // use a following "free" atom as room, so the audio needn't move
  const nextFree = top[top.indexOf(moovA) + 1];
  let delta = newMoov.length - moovA.size, freeUsed = null;
  if (before && nextFree && nextFree.type === 'free' && delta <= nextFree.size && (nextFree.size - delta === 0 || nextFree.size - delta >= 8)) { freeUsed = nextFree; delta = 0; }
  if (before && delta) {
    const tmp = Buffer.from(oldTail);
    shiftOffsets(tmp, 0, tmp.length, delta);
    const parts = kids.filter(a => a.type !== 'udta').map(a => tmp.slice(a.start - moovA.hl, a.start - moovA.hl + a.size));
    newMoov = box('moov', ...parts, udta);
  }
  const pieces = [{ file, start: 0, end: moovA.start }, newMoov];
  let after = moovA.start + moovA.size;
  if (freeUsed) {
    const left = freeUsed.size - (newMoov.length - moovA.size);
    if (left > 0) { const f = Buffer.alloc(left); f.writeUInt32BE(left); f.write('free', 4, 'latin1'); pieces.push(f); }
    after = freeUsed.start + freeUsed.size;
  }
  pieces.push({ file, start: after });
  return rewrite(file, pieces);
}

// ───────────────────────────── Ogg (Vorbis / Opus) ─────────────────────────────
const CrcTable = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? ((r << 1) ^ 0x04C11DB7) >>> 0 : (r << 1) >>> 0; t[i] = r >>> 0; } return t; })();
function oggCrc(b) { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CrcTable[((c >>> 24) ^ b[i]) & 0xFF]) >>> 0; return c >>> 0; }
function readPages(buf) {
  const pages = [];
  let o = 0;
  while (o + 27 <= buf.length) {
    if (buf.toString('latin1', o, o + 4) !== 'OggS') throw new Error('Ogg 頁面損壞');
    const n = buf[o + 26];
    const segs = [...buf.slice(o + 27, o + 27 + n)];
    const len = segs.reduce((s, x) => s + x, 0);
    pages.push({ start: o, flags: buf[o + 5], granule: buf.readBigInt64LE(o + 6), serial: buf.readUInt32LE(o + 14), seq: buf.readUInt32LE(o + 18), segs, data: buf.slice(o + 27 + n, o + 27 + n + len), size: 27 + n + len });
    o += 27 + n + len;
  }
  return pages;
}
function makePage(serial, seq, granule, flags, segs, data) {
  const h = Buffer.alloc(27 + segs.length);
  h.write('OggS', 0, 'latin1'); h[4] = 0; h[5] = flags; h.writeBigInt64LE(granule, 6); h.writeUInt32LE(serial, 14); h.writeUInt32LE(seq, 18);
  h[26] = segs.length; Buffer.from(segs).copy(h, 27);
  const p = Buffer.concat([h, data]);
  p.writeUInt32LE(oggCrc(p), 22);
  return p;
}
function writeOgg(file, ch, cover, removeCover) {
  const buf = fs.readFileSync(file);
  const pages = readPages(buf);
  if (!pages.length) throw new Error('不是 Ogg 檔案');
  const serial = pages[0].serial;
  if (pages.some(p => p.serial !== serial)) throw new Error('不支援含多個串流的 Ogg 檔案');
  // the header packets
  const first = pages[0].data;
  const opus = first.toString('latin1', 0, 8) === 'OpusHead';
  const vorbis = first.length > 7 && first[0] === 1 && first.toString('latin1', 1, 7) === 'vorbis';
  if (!opus && !vorbis) throw new Error('不支援這種 Ogg 檔案（只支援 Vorbis / Opus）');
  const want = opus ? 2 : 3;
  const packets = [];
  let cur = [], pi = 0, endPage = -1;
  for (; pi < pages.length && packets.length < want; pi++) {
    const p = pages[pi];
    let o = 0;
    for (const s of p.segs) {
      cur.push(p.data.slice(o, o + s)); o += s;
      if (s < 255) { packets.push(Buffer.concat(cur)); cur = []; if (packets.length === want) break; }
    }
    if (packets.length === want) endPage = pi;
  }
  if (packets.length < want) throw new Error('Ogg 標頭不完整');
  // audio must start on a fresh page after the headers
  {
    const lp = pages[endPage];
    let ended = 0, k = 0;
    for (const p of pages.slice(0, endPage)) for (const sg of p.segs) if (sg < 255) ended++;
    for (; k < lp.segs.length; k++) if (lp.segs[k] < 255 && ++ended === want) break;
    if (k !== lp.segs.length - 1) throw new Error('不支援這種 Ogg 檔案（標頭和音訊在同一頁）');
  }
  const prefix = opus ? 8 : 7;
  const cb = packets[1];
  const vc = parseVorbis(cb.slice(prefix));
  applyVorbis(vc.list, ch, cover, removeCover, true);
  let newComment = Buffer.concat([cb.slice(0, prefix), renderVorbis(vc)]);
  if (vorbis) newComment = Buffer.concat([newComment, Buffer.from([1])]);   // framing bit
  else if (vc.rest.length) newComment = Buffer.concat([newComment, vc.rest]);
  // header pages: the id packet alone on page 0 (as it was), then the comment (and setup) packets
  const out = [buf.slice(0, pages[0].size)];
  let seq = 1;
  const segs = [], data = [];
  let cont = false, ended = false;   // the page being filled: starts inside a packet / a packet ends on it
  const emit = () => { out.push(makePage(serial, seq++, ended ? 0n : -1n, cont ? 1 : 0, segs.splice(0), Buffer.concat(data.splice(0)))); ended = false; };
  for (const pk of vorbis ? [newComment, packets[2]] : [newComment]) {
    const lace = [];
    let n = pk.length;
    while (n >= 255) { lace.push(255); n -= 255; }
    lace.push(n);
    let o = 0;
    lace.forEach((sg, i) => {
      if (segs.length === 255) { emit(); cont = i > 0; }
      segs.push(sg); data.push(pk.slice(o, o + sg)); o += sg;
      if (i === lace.length - 1) ended = true;
    });
  }
  if (segs.length) emit();
  // the rest: same pages, renumbered
  const delta = seq - (pages[endPage].seq + 1);
  for (let i = endPage + 1; i < pages.length; i++) {
    const p = pages[i];
    if (!delta) { out.push(buf.slice(p.start, p.start + p.size)); continue; }
    out.push(makePage(serial, p.seq + delta, p.granule, p.flags, p.segs, p.data));
  }
  const tail = pages.length ? pages[pages.length - 1].start + pages[pages.length - 1].size : 0;
  if (tail < buf.length) out.push(buf.slice(tail));
  return rewrite(file, out);
}

// ───────────────────────────── APEv2 (APE, WavPack) ─────────────────────────────
function writeApe(file, ch, cover, removeCover) {
  const st = fs.statSync(file);
  let end = st.size, id3v1 = null;
  if (st.size >= 128) { const t = readRange(file, st.size - 128, 128); if (t.toString('latin1', 0, 3) === 'TAG') { id3v1 = t; end -= 128; } }
  let items = [], tagStart = end;
  if (end >= 32) {
    const f = readRange(file, end - 32, 32);
    if (f.toString('latin1', 0, 8) === 'APETAGEX') {
      const size = f.readUInt32LE(12), count = f.readUInt32LE(16), flags = f.readUInt32LE(20);
      const body = readRange(file, end - size, size - 32);
      tagStart = end - size - (flags & 0x80000000 ? 32 : 0);
      let o = 0;
      for (let i = 0; i < count && o + 8 < body.length; i++) {
        const len = body.readUInt32LE(o), fl = body.readUInt32LE(o + 4);
        const z = body.indexOf(0, o + 8);
        if (z < 0) break;
        items.push({ key: body.toString('latin1', o + 8, z), flags: fl, value: body.slice(z + 1, z + 1 + len) });
        o = z + 1 + len;
      }
    }
  }
  const getText = k => { const it = items.find(x => x.key.toLowerCase() === k.toLowerCase()); return it ? it.value.toString('utf8') : ''; };
  const put = (k, v, alts = []) => {
    const keys = [k, ...alts].map(x => x.toLowerCase());
    const i = items.findIndex(x => keys.includes(x.key.toLowerCase()));
    items = items.filter(x => !keys.includes(x.key.toLowerCase()));
    if (v) items.splice(i < 0 ? items.length : i, 0, { key: k, flags: 0, value: Buffer.from(v, 'utf8') });
  };
  if ('title' in ch) put('Title', ch.title);
  if ('album' in ch) put('Album', ch.album);
  if ('artist' in ch) put('Artist', ch.artist.join('; '));
  if ('albumArtist' in ch) put('Album Artist', ch.albumArtist.join('; '), ['AlbumArtist', 'Album_Artist']);
  if ('genre' in ch) put('Genre', ch.genre.join('; '));
  if ('composer' in ch) put('Composer', ch.composer.join('; '));
  if ('year' in ch) { const old = getText('Year'); put('Year', ch.year ? (old.startsWith(String(ch.year)) ? old : String(ch.year)) : ''); }
  for (const [k, nf, tf] of [['Track', 'track', 'trackTotal'], ['Disc', 'disc', 'discTotal']]) {
    if (!(nf in ch) && !(tf in ch)) continue;
    const [n0, t0] = pair(getText(k));
    const n = nf in ch ? ch[nf] : n0, t = tf in ch ? ch[tf] : t0;
    put(k, n ? (t ? `${n}/${t}` : String(n)) : '');
  }
  if (cover || removeCover) {
    items = items.filter(x => x.key.toLowerCase() !== 'cover art (front)');
    if (cover && !removeCover) items.push({ key: 'Cover Art (Front)', flags: 2, value: Buffer.concat([Buffer.from(cover.mime === 'image/png' ? 'cover.png' : 'cover.jpg', 'latin1'), Buffer.from([0]), cover.data]) });
  }
  const body = Buffer.concat(items.map(x => { const h = Buffer.alloc(8); h.writeUInt32LE(x.value.length); h.writeUInt32LE(x.flags, 4); return Buffer.concat([h, Buffer.from(x.key, 'latin1'), Buffer.from([0]), x.value]); }));
  const hf = (isHeader) => {
    const b = Buffer.alloc(32);
    b.write('APETAGEX', 0, 'latin1'); b.writeUInt32LE(2000, 8); b.writeUInt32LE(body.length + 32, 12); b.writeUInt32LE(items.length, 16);
    b.writeUInt32LE((0x80000000 | (isHeader ? 0x20000000 : 0)) >>> 0, 20);
    return b;
  };
  const tag = items.length ? Buffer.concat([hf(true), body, hf(false)]) : Buffer.alloc(0);
  const newTail = Buffer.concat([tag, id3v1 || Buffer.alloc(0)]);
  // in place: cut the old tag off and append the new one (the audio isn't touched); restore on failure
  const oldTail = readRange(file, tagStart, st.size - tagStart);
  const fd = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(fd, tagStart);
    fs.writeSync(fd, newTail, 0, newTail.length, tagStart);
  } catch (e) {
    try { fs.ftruncateSync(fd, tagStart); fs.writeSync(fd, oldTail, 0, oldTail.length, tagStart); } catch { }
    throw e;
  } finally { fs.closeSync(fd); }
}

// ───────────────────────────── writing a new file ─────────────────────────────
let verifier = null;   // async (original, temp) => throws when the new file isn't right
const setVerifier = f => { verifier = f; };

/** Writes `pieces` (Buffers and { file, start, end } ranges of the original) to a temp file, checks it, replaces the original. */
async function rewrite(file, pieces) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.miku-' + crypto.randomBytes(4).toString('hex'));
  const out = fs.openSync(tmp, 'w');
  try {
    for (const p of pieces) {
      if (Buffer.isBuffer(p)) { fs.writeSync(out, p); continue; }
      const fd = fs.openSync(p.file, 'r');
      try {
        const end = p.end != null ? p.end : fs.fstatSync(fd).size;
        const chunk = Buffer.alloc(1 << 20);
        for (let o = p.start; o < end;) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - o), o);
          if (n <= 0) break;
          fs.writeSync(out, chunk, 0, n);
          o += n;
        }
      } finally { fs.closeSync(fd); }
    }
  } catch (e) { fs.closeSync(out); try { fs.unlinkSync(tmp); } catch { } throw e; }
  fs.closeSync(out);
  try {
    if (verifier) await verifier(file, tmp);
    const st = fs.statSync(file);
    try { fs.chmodSync(tmp, st.mode); } catch { }
    fs.renameSync(tmp, file);
    try { fs.utimesSync(file, new Date(), new Date()); } catch { }
  } catch (e) { try { fs.unlinkSync(tmp); } catch { } throw e; }
}

/**
 * Writes one file. `set`: field → new value ('' clears). `cover`: { data, mime } to embed as the front cover, or
 * null to keep it; `removeCover` removes the front cover.
 */
async function write(file, set, cover, removeCover) {
  if (!canWrite(file)) throw new Error('不支援寫入這種格式（' + path.extname(file) + '）');
  try { fs.accessSync(file, fs.constants.W_OK); } catch { try { fs.chmodSync(file, fs.statSync(file).mode | 0o200); } catch { throw new Error('沒有寫入權限'); } }
  const ch = normalise(set);
  if (!Object.keys(ch).length && !cover && !removeCover) return;
  switch (ext(file)) {
    case '.flac': return writeFlac(file, ch, cover, removeCover);
    case '.mp3': return writeMp3(file, ch, cover, removeCover);
    case '.dsf': return writeDsf(file, ch, cover, removeCover);
    case '.dff': return writeDff(file, ch, cover, removeCover);
    case '.wav': case '.aif': case '.aiff': case '.aifc': return writeRiffLike(file, ch, cover, removeCover);
    case '.m4a': case '.mp4': case '.aac': case '.alac': {
      const h = readRange(file, 0, 8);
      if (h.toString('latin1', 4, 8) !== 'ftyp') throw new Error('不支援寫入這種 AAC 檔案（ADTS）');
      return writeMp4(file, ch, cover, removeCover);
    }
    case '.ogg': case '.oga': case '.opus': return writeOgg(file, ch, cover, removeCover);
    case '.ape': case '.wv': return writeApe(file, ch, cover, removeCover);
  }
  throw new Error('不支援寫入這種格式');
}

module.exports = { Fields, canWrite, write, setVerifier, imageSize, _test: { parseId3, applyId3, parseVorbis, readPages, oggCrc } };
