'use strict';
// Reads the tags and the format of music files directly, from the few ranges of the file they are in. ffprobe takes
// seconds a file on a network share (many small reads, each a round trip, and some read megabytes of audio to guess
// the length); these reads take a fraction of that. Formats not read here, and files that do not parse, give null:
// the library reads those with ffprobe as before.
//
//   FLAC          STREAMINFO, Vorbis comments, PICTURE
//   MP3           ID3v2 (v2.3 / v2.4) or ID3v1, the first frame (Xing / Info / VBRI for the length)
//   M4A / MP4     moov: the sound track's mdhd and stsd (AAC, ALAC), ilst
//   WAV / RF64    fmt, data, ds64, LIST INFO, ID3 chunk (PCM and float only)
//   AIFF / AIFC   COMM, NAME / AUTH, ID3 chunk (PCM and float only)
//   OGG / Opus    the identification and comment packets, the last page's granule position
//   DSF           the header, ID3v2 at the end
//   DFF           PROP (FS, CHNL, CMPR), the DSD chunk's size, the "ID3 " chunk (DSD, not DST)
//
// Tags come back as ffprobe reports them: lower-case names (title, artist, album_artist, date, track, disc,
// replaygain_track_gain, …), several values joined with ";".
const fs = require('fs');
const path = require('path');
const { _test: { parseId3, parseVorbis, frameText } } = require('./tagwriter');

const MaxTag = 64 * 1024 * 1024;   // the most read for a tag (a tag with large pictures)

/**
 * Ranged reads of an open file. A small read fetches 128 KB and keeps it (the last few blocks): the next headers are
 * then usually in it already, and on a network share each read is a round trip that costs more than the bytes.
 */
const Block = 128 * 1024;
class Source {
  constructor(fh, size, file) { this.fh = fh; this.size = size; this.file = file; this.blocks = []; }
  async at(pos, len) {
    len = Math.max(0, Math.min(len, this.size - pos));
    if (len > Block / 2) return this.raw(pos, len);
    for (const b of this.blocks) if (pos >= b.pos && pos + len <= b.pos + b.buf.length) return b.buf.slice(pos - b.pos, pos - b.pos + len);
    const buf = await this.raw(pos, Block);
    this.blocks.unshift({ pos, buf });
    if (this.blocks.length > 4) this.blocks.pop();
    return buf.slice(0, len);
  }
  async raw(pos, len) {
    len = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await this.fh.read(b, got, len - got, pos + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got < len ? b.slice(0, got) : b;
  }
}

async function withFile(file, fn) {
  const fh = await fs.promises.open(file, 'r');
  try { return await fn(new Source(fh, (await fh.stat()).size, file)); } finally { await fh.close(); }
}

// ───────────────────────────── tags ─────────────────────────────

function addTag(tags, k, v) {
  k = String(k).trim().toLowerCase();
  v = String(v == null ? '' : v).trim();
  if (!k || !v) return;
  tags[k] = tags[k] == null ? v : tags[k] + ';' + v;
}

/** ID3v1 genres (also MP4's gnre, the number + 1), as ffprobe names them. */
const Genres = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies',
  'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
  'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock',
  'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult',
  'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave',
  'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk',
  'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock',
  'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour',
  'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club',
  'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A capella',
  'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror', 'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk',
  'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue',
  'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop'];

/** ID3v2 frame data with the v2.4 frame flags (unsynchronisation, data length) undone. */
function frameData(f, major) {
  let d = f.data;
  if (major === 4 && (f.flags & 0x0002)) {
    const out = [];
    for (let i = 0; i < d.length; i++) { out.push(d[i]); if (d[i] === 0xFF && d[i + 1] === 0x00) i++; }
    d = Buffer.from(out);
  }
  if (major === 4 && (f.flags & 0x0001)) d = d.slice(4);
  return d;
}

const Id3Names = { TIT2: 'title', TPE1: 'artist', TPE2: 'album_artist', TALB: 'album', TCON: 'genre', TCOM: 'composer', TYER: 'date', TDRC: 'date', TRCK: 'track', TPOS: 'disc' };

/** An ID3v2 tag (buffer from "ID3") into tags; hasPic when it has an APIC frame. Null when it does not parse. */
function id3Tags(buf, into = {}) {
  let tag;
  try { tag = parseId3(buf); } catch { return null; }   // ID3v2.2 and unknown versions: left to ffprobe
  if (!tag) return null;
  return id3FrameTags(tag, into);
}

/**
 * The ID3v2 tag at `pos` into tags, its pictures skipped (only their headers read: a cover can be megabytes).
 * { tags, hasPic, size } or null (no tag, or one that does not parse). A tag unsynchronised as a whole, or with an
 * extended header, is read whole.
 */
async function id3TagsAt(src, pos, into = {}) {
  const h = await src.at(pos, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const major = h[3], flags = h[5], body = (h[6] & 0x7f) << 21 | (h[7] & 0x7f) << 14 | (h[8] & 0x7f) << 7 | (h[9] & 0x7f);
  const size = 10 + body + (major === 4 && (flags & 0x10) ? 10 : 0);
  if (major !== 3 && major !== 4) return null;   // ID3v2.2: left to ffprobe
  if ((flags & 0x80 && major === 3) || (flags & 0x40)) {
    const r = id3Tags(await src.at(pos, Math.min(size, MaxTag)), into);
    return r && { ...r, size };
  }
  const frames = [];
  for (let o = 10; o + 10 <= 10 + body;) {
    const fh = await src.at(pos + o, 10);
    const id = fh.toString('latin1', 0, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = major === 4 ? ((fh[4] & 0x7f) << 21 | (fh[5] & 0x7f) << 14 | (fh[6] & 0x7f) << 7 | (fh[7] & 0x7f)) : fh.readUInt32BE(4);
    if (o + 10 + len > 10 + body) break;
    if (id === 'APIC') frames.push({ id, flags: 0, data: Buffer.alloc(0) });
    else if (id[0] === 'T' && len <= MaxTag) frames.push({ id, flags: fh.readUInt16BE(8), data: await src.at(pos + o + 10, len) });
    o += 10 + len;
  }
  return { ...id3FrameTags({ major, frames }, into), size };
}

function id3FrameTags(tag, into) {
  let hasPic = false;
  for (const f of tag.frames) {
    if (f.id === 'APIC') { hasPic = true; continue; }
    if (f.id === 'TXXX') {
      const s = frameText(f, tag.major), i = s.indexOf('; ');
      if (i > 0 && into[s.slice(0, i).trim().toLowerCase()] == null) addTag(into, s.slice(0, i), s.slice(i + 2));
      continue;
    }
    // several values: "; " between them, as ffprobe gives them
    const k = Id3Names[f.id];
    if (k && into[k] == null) addTag(into, k, frameText(f, tag.major).split('; ').map(x => x.trim()).filter(Boolean).join('; '));
  }
  return { tags: into, hasPic };
}

/** The picture in an ID3v2 tag (the front cover when there are several), or null. */
function id3Picture(buf) {
  let tag;
  try { tag = parseId3(buf); } catch { return null; }
  let best = null;
  for (const f of (tag && tag.frames) || []) {
    if (f.id !== 'APIC') continue;
    const d = frameData(f, tag.major), wide = d[0] === 1 || d[0] === 2;
    let i = d.indexOf(0, 1);   // the MIME type ends
    if (i < 0) continue;
    const type = d[i + 1];
    i += 2;
    if (wide) { while (i + 1 < d.length && (d[i] || d[i + 1])) i += 2; i += 2; } else { while (i < d.length && d[i]) i++; i++; }
    if (i >= d.length) continue;
    if (!best || type === 3) best = d.slice(i);
    if (type === 3) break;
  }
  return best;
}

/** Reads the ID3v2 tag that starts at `pos` (null when there is none). */
async function id3At(src, pos) {
  const h = await src.at(pos, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const size = ((h[6] & 0x7f) << 21 | (h[7] & 0x7f) << 14 | (h[8] & 0x7f) << 7 | (h[9] & 0x7f)) + 10 + (h[5] & 0x10 ? 10 : 0);
  return src.at(pos, Math.min(size, MaxTag));
}

/** Vorbis comments (FLAC, OGG) into tags; hasPic when a METADATA_BLOCK_PICTURE is among them. */
function vorbisTags(b, tags = {}) {
  let hasPic = false;
  for (const c of parseVorbis(b).list) {
    const i = c.indexOf('=');
    if (i <= 0) continue;
    const k = c.slice(0, i);
    if (/^metadata_block_picture$/i.test(k)) { hasPic = true; continue; }
    addTag(tags, k, c.slice(i + 1));
  }
  return { tags, hasPic };
}

/** A FLAC PICTURE block body: { type, data }. */
function flacPictureBlock(b) {
  let o = 0;
  const type = b.readUInt32BE(o); o += 4;
  o += 4 + b.readUInt32BE(o);   // MIME type
  o += 4 + b.readUInt32BE(o);   // description
  o += 16;                      // width, height, depth, colours
  const len = b.readUInt32BE(o); o += 4;
  return { type, data: b.slice(o, o + len) };
}

// ───────────────────────────── formats ─────────────────────────────

async function flac(src, wantPicture) {
  if ((await src.at(0, 4)).toString('latin1') !== 'fLaC') return null;
  const r = { tags: {}, hasPic: false };
  let pic = null, info = null;
  for (let pos = 4, n = 0; pos + 4 <= src.size && n < 1000; n++) {
    const h = await src.at(pos, 4);
    if (h.length < 4) break;
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
    if (type === 0) info = await src.at(pos + 4, 34);
    else if (type === 4 && !wantPicture) vorbisTags(await src.at(pos + 4, Math.min(len, MaxTag)), r.tags);
    else if (type === 6) {
      r.hasPic = true;
      if (wantPicture && (!pic || pic.type !== 3)) pic = flacPictureBlock(await src.at(pos + 4, Math.min(len, MaxTag)));
    }
    pos += 4 + len;
    if (last) break;
  }
  if (wantPicture) return pic ? pic.data : null;
  if (!info || info.length < 34) return null;
  const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const total = (info[13] & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
  if (!rate) return null;
  r.sampleRate = rate;
  r.channels = ((info[12] >> 1) & 7) + 1;
  r.bits = (((info[12] & 1) << 4) | (info[13] >> 4)) + 1;
  r.duration = total / rate;
  r.bitrate = r.duration > 0 ? Math.round(src.size * 8 / r.duration / 1000) : 0;
  return r;
}

const Mp3Rates = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];   // by version bits
const Mp3Kbps1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];        // MPEG-1 layer III
const Mp3Kbps2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];            // MPEG-2 / 2.5 layer III

/** A layer III frame header at b[o]: { rate, kbps, mono, mpeg1, length } or null. */
function mp3Header(b, o) {
  if (o + 4 > b.length || b[o] !== 0xFF || (b[o + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[o + 1] >> 3) & 3, layer = (b[o + 1] >> 1) & 3, bi = b[o + 2] >> 4, ri = (b[o + 2] >> 2) & 3;
  if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || ri === 3) return null;
  const mpeg1 = ver === 3, rate = Mp3Rates[ver][ri], kbps = (mpeg1 ? Mp3Kbps1 : Mp3Kbps2)[bi];
  const length = Math.floor((mpeg1 ? 144000 : 72000) * kbps / rate) + ((b[o + 2] >> 1) & 1);
  return { rate, kbps, mono: (b[o + 3] >> 6) === 3, mpeg1, length };
}

async function mp3(src, wantPicture) {
  if (wantPicture) { const tag = await id3At(src, 0); return tag ? id3Picture(tag) : null; }
  let pos = 0, r = { tags: {}, hasPic: false };
  if ((await src.at(0, 3)).toString('latin1') === 'ID3') {
    const t = await id3TagsAt(src, 0);
    if (!t) return null;
    r = t;
    pos = t.size;
  }
  // the first frame (two in a row, so a stray sync in junk is not taken)
  const b = await src.at(pos, 256 * 1024);
  let o = 0, h = null;
  for (; o + 4 <= b.length; o++) {
    h = mp3Header(b, o);
    if (h && mp3Header(b, o + h.length)) break;
    h = null;
  }
  if (!h) return null;
  const v1 = src.size >= 128 ? await src.at(src.size - 128, 128) : Buffer.alloc(0);
  const hasV1 = v1.length === 128 && v1.toString('latin1', 0, 3) === 'TAG';
  if (hasV1 && !Object.keys(r.tags).length) {
    const s = (a, n) => v1.toString('latin1', a, a + n).replace(/\0.*$/s, '').trim();
    addTag(r.tags, 'title', s(3, 30)); addTag(r.tags, 'artist', s(33, 30)); addTag(r.tags, 'album', s(63, 30)); addTag(r.tags, 'date', s(93, 4));
    if (v1[125] === 0 && v1[126]) addTag(r.tags, 'track', v1[126]);
  }
  const audio = src.size - pos - o - (hasV1 ? 128 : 0);
  // Xing / Info (after the side information) or VBRI (32 bytes in): the number of frames
  const side = h.mpeg1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const x = o + 4 + side, spf = h.mpeg1 ? 1152 : 576;
  let frames = 0;
  const id = b.toString('latin1', x, x + 4);
  if ((id === 'Xing' || id === 'Info') && (b.readUInt32BE(x + 4) & 1)) frames = b.readUInt32BE(x + 8);
  else if (b.toString('latin1', o + 36, o + 40) === 'VBRI') frames = b.readUInt32BE(o + 36 + 14);
  // no frame count (VBR without a Xing / VBRI header, or CBR): the frames read so far give the average bit rate (all
  // of them in a short file, so its length is exact)
  let kbps = h.kbps;
  if (!frames) {
    let n = 0, bytes = 0;
    for (let p = o, f; (f = mp3Header(b, p)) && p + f.length <= b.length; p += f.length) { n++; bytes += f.length; }
    if (n > 1) kbps = bytes * 8 * h.rate / (n * spf) / 1000;
  }
  r.sampleRate = h.rate;
  r.channels = h.mono ? 1 : 2;
  r.bits = 0;
  r.duration = frames ? frames * spf / h.rate : audio * 8 / (kbps * 1000);
  r.bitrate = r.duration > 0 ? Math.round(audio * 8 / r.duration / 1000) : Math.round(kbps);
  return r;
}

/** Box list of b[start, end) as tagwriter's atoms() gives, but tolerant of a truncated last box. */
function boxes(b, start = 0, end = b.length) {
  const list = [];
  for (let o = start; o + 8 <= end;) {
    let size = b.readUInt32BE(o), hl = 8;
    if (size === 1) { if (o + 16 > end) break; size = Number(b.readBigUInt64BE(o + 8)); hl = 16; } else if (size === 0) size = end - o;
    if (size < hl || o + size > end) break;
    list.push({ type: b.toString('latin1', o + 4, o + 8), start: o, body: o + hl, end: o + size });
    o += size;
  }
  return list;
}
const child = (b, parent, type) => boxes(b, parent.body, parent.end).find(x => x.type === type);
const path4 = (b, parent, ...types) => { let p = parent; for (const t of types) { p = p && child(b, p, t); } return p; };

const Mp4Names = { '\xa9nam': 'title', '\xa9ART': 'artist', aART: 'album_artist', '\xa9alb': 'album', '\xa9gen': 'genre', '\xa9wrt': 'composer', '\xa9day': 'date' };

async function mp4(src, wantPicture) {
  // the top-level boxes, to moov (often after mdat, at the end of the file)
  let moov = null;
  for (let pos = 0, n = 0; pos + 8 <= src.size && n < 64; n++) {
    const h = await src.at(pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (n === 0 && type !== 'ftyp') return null;
    if (size === 1) size = Number(h.readBigUInt64BE(8)); else if (size === 0) size = src.size - pos;
    if (size < 8) return null;
    if (type === 'moov') { if (size > MaxTag) return null; moov = await src.at(pos, size); break; }
    pos += size;
  }
  if (!moov) return null;
  const root = { body: 8, end: moov.length };
  const ilst = (() => {
    const meta = path4(moov, root, 'udta', 'meta');
    return meta && boxes(moov, meta.body + 4, meta.end).find(x => x.type === 'ilst');   // meta is a full box
  })();
  const r = { tags: {}, hasPic: false };
  let pic = null;
  for (const it of ilst ? boxes(moov, ilst.body, ilst.end) : []) {
    const kids = boxes(moov, it.body, it.end), data = kids.find(x => x.type === 'data');
    if (!data || data.end - data.body < 8) continue;
    const kind = moov.readUInt32BE(data.body) & 0xFFFFFF, v = moov.slice(data.body + 8, data.end);
    if (it.type === 'covr') { r.hasPic = true; if (!pic) pic = v; continue; }
    if (it.type === 'gnre') {
      if (v.length >= 2 && Genres[v.readUInt16BE(0) - 1] && r.tags.genre == null) addTag(r.tags, 'genre', Genres[v.readUInt16BE(0) - 1]);
      continue;
    }
    if (it.type === 'trkn' || it.type === 'disk') {
      if (v.length >= 6) { const n = v.readUInt16BE(2), of = v.readUInt16BE(4); if (n) addTag(r.tags, it.type === 'trkn' ? 'track' : 'disc', of ? `${n}/${of}` : n); }
      continue;
    }
    const text = kind === 1 ? v.toString('utf8') : null;
    if (text == null) continue;
    if (it.type === '----') {
      const name = kids.find(x => x.type === 'name');
      if (name) addTag(r.tags, moov.toString('utf8', name.body + 4, name.end), text);
    } else if (Mp4Names[it.type]) addTag(r.tags, Mp4Names[it.type], text);
  }
  if (wantPicture) return pic;
  // the sound track
  for (const trak of boxes(moov, root.body, root.end).filter(x => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia'), hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || moov.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd'), stsd = path4(moov, mdia, 'minf', 'stbl', 'stsd');
    if (!mdhd || !stsd) return null;
    const v1 = moov[mdhd.body] === 1;
    const scale = moov.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
    const dur = v1 ? Number(moov.readBigUInt64BE(mdhd.body + 24)) : moov.readUInt32BE(mdhd.body + 16);
    const e = stsd.body + 8;   // the first sample entry
    if (e + 36 > stsd.end) return null;
    const fmt = moov.toString('latin1', e + 4, e + 8), eEnd = e + moov.readUInt32BE(e);
    r.channels = moov.readUInt16BE(e + 24);
    r.bits = 0;
    r.sampleRate = moov.readUInt32BE(e + 32) >>> 16;
    const ext = e + 36 + (moov.readUInt16BE(e + 16) === 1 ? 16 : 0);   // QuickTime sound description version 1
    if (fmt === 'alac') {
      const c = boxes(moov, ext, eEnd).find(x => x.type === 'alac');
      if (c && c.end - c.body >= 28) {
        r.bits = moov[c.body + 9];
        r.channels = moov[c.body + 13] || r.channels;
        r.sampleRate = moov.readUInt32BE(c.body + 24) || r.sampleRate;
      }
      r.codec = 'ALAC';
    } else if (fmt === 'mp4a') r.codec = 'AAC';
    else return null;   // other codecs in MP4: ffprobe
    r.duration = scale ? dur / scale : 0;
    // the audio's own rate: the sample sizes (stsz) added up, without the tags and pictures in the file
    const stsz = path4(moov, mdia, 'minf', 'stbl', 'stsz');
    let bytes = src.size;
    if (stsz && stsz.end - stsz.body >= 12) {
      const fixed = moov.readUInt32BE(stsz.body + 4), count = moov.readUInt32BE(stsz.body + 8);
      if (fixed) bytes = fixed * count;
      else if (stsz.body + 12 + count * 4 <= stsz.end) { bytes = 0; for (let i = 0; i < count; i++) bytes += moov.readUInt32BE(stsz.body + 12 + i * 4); }
    }
    r.bitrate = r.duration > 0 ? Math.round(bytes * 8 / r.duration / 1000) : 0;
    return r;
  }
  return null;
}

/**
 * The legacy code pages tried for RIFF INFO text that is not UTF-8, the system language's first. INFO is usually
 * written in the Windows ANSI code page of the machine that tagged it (Big5, Shift-JIS, GBK…); Windows MIKU decodes it
 * with its own ANSI code page (FixRiffInfo / DecodeInfo in Library.cs), the Mac has none, so the language decides.
 */
const CodePages = (() => {
  const all = ['big5', 'shift_jis', 'gbk', 'euc-kr'];
  let lang = '';
  try { lang = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { }
  lang = (process.env.LANG || '').startsWith('zh_TW') || (process.env.LANG || '').startsWith('zh_HK') ? 'zh-TW' : lang;
  const first = /^zh[-_](TW|HK|MO|Hant)/i.test(lang) ? 'big5' : /^ja/i.test(lang) ? 'shift_jis' : /^zh/i.test(lang) ? 'gbk' : /^ko/i.test(lang) ? 'euc-kr' : 'big5';
  return [first, ...all.filter(x => x !== first)].filter(enc => { try { new TextDecoder(enc); return true; } catch { return false; } });
})();

/** RIFF INFO text: UTF-8 when it is valid UTF-8, else the first code page it decodes in without an error, else Latin-1. */
function decodeInfo(raw) {
  const z = raw.indexOf(0);
  if (z >= 0) raw = raw.slice(0, z);
  for (const enc of ['utf-8', ...CodePages]) {
    try { return new TextDecoder(enc, { fatal: true }).decode(raw); } catch { }
  }
  return raw.toString('latin1');
}

/**
 * Text whose tagging program stored characters its code page could not hold as '?' (Big5 INFO "獅子神レオナ" →
 * "獅子神???"), as Windows MIKU's RestoreLost: a value of the same file that fits it, one non-ASCII character per '?'
 * (another field, a part of one, the file name or a folder name); else, when it is mostly '?', nothing (but the album,
 * which groups the tracks). Only non-ASCII characters get lost this way, so a real '?' ("Why?") never fits.
 */
const NameSeparators = /\s*(?:[;/、,&＆×]|\bfeat\.?(?=\s)|\bft\.|[()（）])\s*/i;
const TextFields = ['title', 'artist', 'album_artist', 'album', 'genre', 'composer'];
function restoreLost(tags, file, dropFrom = []) {
  const fields = TextFields.filter(k => tags[k] && tags[k].includes('?'));
  if (!fields.length) return;
  // (macOS may give the names decomposed, NFD: composed, one character per '?')
  const dirs = path.dirname(file).split(path.sep).filter(Boolean).reverse().slice(0, 4);
  const known = [...Object.values(tags), path.basename(file, path.extname(file)), ...dirs].map(s => s && s.normalize('NFC')).filter(s => s && !s.includes('?'));
  const parts = [...new Set(known.flatMap(k => k.split(NameSeparators)).map(p => p.trim()).filter(Boolean))];
  const count = s => (s.match(/\?/g) || []).length;
  const lost = s => count(s) >= 2 && (count(s) * 2 >= s.replace(/\s/g, '').length || s.includes('???'));
  // a '?' stands for one non-ASCII character, but not the full-width '？' a file name has for a real '?'
  const pattern = s => new RegExp('^' + [...s].map(c => c === '?' ? '[^\\x00-\\x7F\\uFF1F]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'u');
  const fit = (s, list) => {
    if (/^[?\s]*$/.test(s) && count(s) < 2) return null;
    const re = pattern(s);
    return list.find(x => re.test(x)) || null;
  };
  // word by word, when no whole value fits ("THE IDOLM@STER CINDERELLA MASTER ???? -彩-": "????" is the こいかぜ of the
  // folder). A word is replaced only when one candidate fits it, looked for first where the field most likely comes
  // from (the album in the folder names, the title in the file name, a name in the other names), then everywhere
  const wordsOf = list => [...new Set(list.flatMap(k => k.split(NameSeparators)).flatMap(p => p.split(/\s+/)).filter(w => /[^\x00-\x7F]/.test(w)))];
  const stem = path.basename(file, path.extname(file)).normalize('NFC');
  const names = ['artist', 'album_artist', 'composer'].map(k => tags[k]).filter(s => s && !s.includes('?'));
  const near = { album: dirs.map(d => d.normalize('NFC')), title: [stem], artist: names, album_artist: names, composer: names, genre: [] };
  const byWord = (v, k) => {
    const toks = v.split(/(\s+)/);
    for (let i = 0; i < toks.length; i += 2) {
      if (!toks[i].includes('?')) continue;
      const re = pattern(toks[i]);
      let found = null;
      for (const words of [wordsOf(near[k] || []), wordsOf(known)]) {
        const m = [...new Set(words.filter(w => re.test(w)))];
        if (m.length === 1) { found = m[0]; break; }
        if (m.length > 1) break;   // ambiguous where it most likely comes from: left as it is
      }
      if (!found) return null;
      toks[i] = found;
    }
    return toks.join('');
  };
  for (const k of fields) {
    const v = tags[k], whole = fit(v, known) || fit(v, parts) || byWord(v, k);
    if (whole) tags[k] = whole;
    else if (lost(v) && k !== 'album' && dropFrom.includes(k)) delete tags[k];
  }
}

async function riff(src, wantPicture) {
  const h = await src.at(0, 12);
  const id = h.toString('latin1', 0, 4);
  if (h.length < 12 || !['RIFF', 'RF64', 'BW64'].includes(id) || h.toString('latin1', 8, 12) !== 'WAVE') return null;
  const r = { tags: {}, hasPic: false }, info = {};
  let fmt = null, data = -1, ds64 = -1;
  for (let pos = 12, n = 0; pos + 8 <= src.size && n < 200; n++) {
    const c = await src.at(pos, 8);
    if (c.length < 8) break;
    const cid = c.toString('latin1', 0, 4);
    let size = c.readUInt32LE(4);
    if (cid === 'ds64') { const b = await src.at(pos + 8, 24); if (b.length >= 16) ds64 = Number(b.readBigUInt64LE(8)); }
    else if (cid === 'fmt ') fmt = await src.at(pos + 8, Math.min(size, 64));
    else if (cid === 'data') { data = size === 0xFFFFFFFF && ds64 >= 0 ? ds64 : size; size = data; }
    else if (cid === 'LIST') {
      const b = await src.at(pos + 8, Math.min(size, 1024 * 1024));
      if (b.toString('latin1', 0, 4) === 'INFO')
        for (let o = 4; o + 8 <= b.length;) {
          const k = b.toString('latin1', o, o + 4), l = b.readUInt32LE(o + 4);
          if (info[k] == null) info[k] = decodeInfo(b.slice(o + 8, Math.min(b.length, o + 8 + l)));
          o += 8 + l + (l & 1);
        }
    } else if (cid === 'id3 ' || cid === 'ID3 ') {
      if (wantPicture) return id3Picture(await src.at(pos + 8, Math.min(size, MaxTag)));
      const t = await id3TagsAt(src, pos + 8, r.tags);
      if (t) r.hasPic = r.hasPic || t.hasPic;
    }
    if (cid === 'data' && size > src.size) break;
    pos += 8 + size + (size & 1);
  }
  if (wantPicture) return null;
  if (!fmt || fmt.length < 16 || data < 0) return null;
  let tag = fmt.readUInt16LE(0);
  if (tag === 0xFFFE && fmt.length >= 26) tag = fmt.readUInt16LE(24);
  if (tag !== 1 && tag !== 3) return null;   // not PCM / float: ffprobe
  // the fields as Windows MIKU (TagLib) reads them: IART is the album artist, ISTR the artist (with neither an ID3
  // artist nor ISTR, the library takes the album artist as the artist). An ID3 chunk's values (Unicode) come first.
  // TCOM: the composer as some taggers put it into INFO (an ID3 frame name; ffprobe reads it, TagLib does not)
  const Info = { INAM: 'title', ISTR: 'artist', IART: 'album_artist', IPRD: 'album', IGNR: 'genre', IWRI: 'composer', TCOM: 'composer', ICRD: 'date', ITRK: 'track', IPRT: 'track' };
  r.fromInfo = [];
  for (const [k, name] of Object.entries(Info)) if (info[k] && r.tags[name] == null) { addTag(r.tags, name, info[k]); r.fromInfo.push(name); }
  r.channels = fmt.readUInt16LE(2);
  r.sampleRate = fmt.readUInt32LE(4);
  r.bits = fmt.readUInt16LE(14);
  const align = fmt.readUInt16LE(12) || r.channels * r.bits / 8;
  r.duration = r.sampleRate && align ? Math.min(data, src.size) / align / r.sampleRate : 0;
  r.bitrate = Math.round(r.sampleRate * r.channels * r.bits / 1000);
  return r;
}

/** An 80-bit IEEE extended float (AIFF's sample rate). */
function ext80(b, o) {
  const e = ((b[o] & 0x7f) << 8) | b[o + 1];
  const m = b.readUInt32BE(o + 2) * 2 ** 32 + b.readUInt32BE(o + 6);
  return e === 0 && m === 0 ? 0 : m * 2 ** (e - 16383 - 63);
}

async function aiff(src, wantPicture) {
  const h = await src.at(0, 12);
  if (h.length < 12 || h.toString('latin1', 0, 4) !== 'FORM') return null;
  const form = h.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  const r = { tags: {}, hasPic: false }, text = {};
  let comm = null;
  for (let pos = 12, n = 0; pos + 8 <= src.size && n < 200; n++) {
    const c = await src.at(pos, 8);
    if (c.length < 8) break;
    const cid = c.toString('latin1', 0, 4), size = c.readUInt32BE(4);
    if (cid === 'COMM') comm = await src.at(pos + 8, Math.min(size, 64));
    else if (cid === 'NAME' || cid === 'AUTH') text[cid] = (await src.at(pos + 8, Math.min(size, 4096))).toString('latin1').replace(/\0.*$/s, '');
    else if (cid === 'ID3 ' || cid === 'id3 ') {
      if (wantPicture) return id3Picture(await src.at(pos + 8, Math.min(size, MaxTag)));
      const t = await id3TagsAt(src, pos + 8, r.tags);
      if (t) r.hasPic = r.hasPic || t.hasPic;
    }
    pos += 8 + size + (size & 1);
  }
  if (wantPicture) return null;
  if (!comm || comm.length < 18) return null;
  if (form === 'AIFC') {
    const ct = comm.toString('latin1', 18, 22);
    if (!['NONE', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'FL32', 'fl64', 'FL64'].includes(ct)) return null;
  }
  if (text.NAME && r.tags.title == null) addTag(r.tags, 'title', text.NAME);
  if (text.AUTH && r.tags.artist == null) addTag(r.tags, 'artist', text.AUTH);
  r.channels = comm.readUInt16BE(0);
  const frames = comm.readUInt32BE(2);
  r.bits = comm.readUInt16BE(6);
  r.sampleRate = Math.round(ext80(comm, 8));
  r.duration = r.sampleRate ? frames / r.sampleRate : 0;
  r.bitrate = Math.round(r.sampleRate * r.channels * r.bits / 1000);
  return r;
}

/** The first `count` packets of the first logical stream, read page by page (the comment packet may hold pictures). */
async function oggPackets(src, count) {
  const packets = [];
  let cur = [], serial = null;
  for (let pos = 0, n = 0; pos + 27 <= src.size && packets.length < count && n < 4096; n++) {
    const h = await src.at(pos, 27 + 255);
    if (h.length < 27 || h.toString('latin1', 0, 4) !== 'OggS') return null;
    const segs = h[26], lace = h.slice(27, 27 + segs);
    const len = lace.reduce((s, x) => s + x, 0);
    const s = h.readUInt32LE(14);
    if (serial == null) serial = s;
    if (s === serial) {
      const data = await src.at(pos + 27 + segs, len);
      let o = 0;
      for (const l of lace) {
        cur.push(data.slice(o, o + l)); o += l;
        if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; if (packets.length >= count) break; }
      }
      if (cur.reduce((t, x) => t + x.length, 0) > MaxTag) return null;
    }
    pos += 27 + segs + len;
  }
  return packets.length >= count ? { packets, serial } : null;
}

async function ogg(src, wantPicture) {
  const p = await oggPackets(src, 2);
  if (!p) return null;
  const [id, com] = p.packets;
  let opus = false;
  const r = { tags: {}, hasPic: false };
  if (id.toString('latin1', 0, 7) === '\x01vorbis' && com.toString('latin1', 0, 7) === '\x03vorbis') {
    r.channels = id[11]; r.sampleRate = id.readUInt32LE(12);
    if (wantPicture) return oggPicture(com.slice(7));
    vorbisTags(com.slice(7), r.tags);
    r.hasPic = /metadata_block_picture=/i.test(com.toString('latin1'));
  } else if (id.toString('latin1', 0, 8) === 'OpusHead' && com.toString('latin1', 0, 8) === 'OpusTags') {
    opus = true;
    r.channels = id[9]; r.sampleRate = 48000;
    if (wantPicture) return oggPicture(com.slice(8));
    vorbisTags(com.slice(8), r.tags);
    r.hasPic = /metadata_block_picture=/i.test(com.toString('latin1'));
  } else return null;
  // the length: the last page's granule position
  const tail = await src.at(Math.max(0, src.size - 65536), 65536);
  let granule = -1n;
  for (let o = tail.length - 27; o >= 0; o--) {
    if (tail[o] === 0x4F && tail.toString('latin1', o, o + 4) === 'OggS' && tail.readUInt32LE(o + 14) === p.serial) { granule = tail.readBigInt64LE(o + 6); break; }
  }
  if (granule < 0n) return null;
  r.bits = 0;
  r.duration = opus ? Math.max(0, Number(granule) - id.readUInt16LE(10)) / 48000 : Number(granule) / r.sampleRate;
  // Vorbis: the nominal bit rate in its header, as ffprobe reports it; else (Opus, or none given) from the size
  const nominal = opus ? 0 : id.readInt32LE(20);
  r.bitrate = nominal > 0 ? Math.round(nominal / 1000) : r.duration > 0 ? Math.round(src.size * 8 / r.duration / 1000) : 0;
  return r;
}
function oggPicture(comments) {
  let best = null;
  for (const c of parseVorbis(comments).list) {
    const i = c.indexOf('=');
    if (i <= 0 || !/^metadata_block_picture$/i.test(c.slice(0, i))) continue;
    try {
      const p = flacPictureBlock(Buffer.from(c.slice(i + 1), 'base64'));
      if (!best || p.type === 3) best = p;
      if (p.type === 3) break;
    } catch { }
  }
  return best ? best.data : null;
}

async function dsf(src, wantPicture) {
  const h = await src.at(0, 80);
  if (h.length < 80 || h.toString('latin1', 0, 4) !== 'DSD ' || h.toString('latin1', 28, 32) !== 'fmt ') return null;
  const at = Number(h.readBigUInt64LE(20)), has = at && at + 10 <= src.size;
  if (wantPicture) { const tag = has ? await id3At(src, at) : null; return tag ? id3Picture(tag) : null; }
  const r = (has && await id3TagsAt(src, at)) || { tags: {}, hasPic: false };
  r.channels = h.readUInt32LE(52);
  r.sampleRate = h.readUInt32LE(56);
  r.bits = 1;
  r.duration = r.sampleRate ? Number(h.readBigUInt64LE(64)) / r.sampleRate : 0;
  r.bitrate = Math.round(r.sampleRate * r.channels / 1000);
  return r;
}

async function dff(src, wantPicture) {
  const h = await src.at(0, 16);
  if (h.length < 16 || h.toString('latin1', 0, 4) !== 'FRM8' || h.toString('latin1', 12, 16) !== 'DSD ') return null;
  const end = Math.min(src.size, 12 + Number(h.readBigUInt64BE(4)));
  let rate = 0, channels = 0, cmpr = '', bytes = -1, tagAt = -1, tagSize = 0;
  for (let pos = 16, n = 0; pos + 12 <= end && n < 200; n++) {
    const c = await src.at(pos, 12);
    if (c.length < 12) break;
    const cid = c.toString('latin1', 0, 4), size = Number(c.readBigUInt64BE(4));
    if (cid === 'PROP') {
      const b = await src.at(pos + 12, Math.min(size, 1024 * 1024));
      for (let o = 4; o + 12 <= b.length;) {   // after "SND "
        const k = b.toString('latin1', o, o + 4), l = Number(b.readBigUInt64BE(o + 4));
        if (k === 'FS  ') rate = b.readUInt32BE(o + 12);
        else if (k === 'CHNL') channels = b.readUInt16BE(o + 12);
        else if (k === 'CMPR') cmpr = b.toString('latin1', o + 12, o + 16);
        o += 12 + l + (l & 1);
      }
    } else if (cid === 'DSD ') bytes = size;
    else if (cid === 'ID3 ' && size > 10) { tagAt = pos + 12; tagSize = size; }
    if (size < 0) break;
    pos += 12 + size + (size & 1);
  }
  if (wantPicture) return tagAt >= 0 ? id3Picture(await src.at(tagAt, Math.min(tagSize, MaxTag))) : null;
  if (cmpr !== 'DSD ' || !rate || !channels || bytes < 0) return null;   // DST: ffprobe
  const r = (tagAt >= 0 && await id3TagsAt(src, tagAt)) || { tags: {}, hasPic: false };
  r.sampleRate = rate;
  r.channels = channels;
  r.bits = 1;
  r.duration = bytes * 8 / channels / rate;
  r.bitrate = Math.round(rate * channels / 1000);
  return r;
}

const Readers = {
  '.flac': flac, '.mp3': mp3, '.m4a': mp4, '.mp4': mp4, '.alac': mp4, '.wav': riff, '.aif': aiff, '.aiff': aiff, '.aifc': aiff,
  '.ogg': ogg, '.oga': ogg, '.opus': ogg, '.dsf': dsf, '.dff': dff,
};

/**
 * The tags and format of a file: { tags, hasPic, duration, sampleRate, channels, bits, bitrate, codec? }, or null
 * when its format is not read here or it does not parse (then ffprobe reads it).
 */
async function read(file) {
  const fn = Readers[path.extname(file).toLowerCase()];
  if (!fn) return null;
  let r;
  try { r = await withFile(file, src => fn(src, false)); } catch { return null; }
  // characters lost as '?' (any format, as Windows MIKU; only values from RIFF INFO are dropped when nothing fits)
  if (r) { restoreLost(r.tags, file, r.fromInfo); delete r.fromInfo; }
  return r;
}

/** The picture in a file's tag (the front cover when there are several), or null (then ffmpeg looks). */
async function picture(file) {
  const fn = Readers[path.extname(file).toLowerCase()];
  if (!fn) return null;
  try { const b = await withFile(file, src => fn(src, true)); return Buffer.isBuffer(b) && b.length ? b : null; } catch { return null; }
}

module.exports = { read, picture };
