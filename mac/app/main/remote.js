'use strict';
// LAN web server for the phone remote: static files, library / artwork, JSON RPC and an SSE state stream.
// Phones pair once with a 4-digit code shown on the Mac. Port of RemoteServer.cs
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { AppPaths, Log, Json, hash } = require('./common');

const StorePath = () => path.join(AppPaths.Root, 'remote.json');
const Types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

class RemoteServer {
  constructor(rpc, media, pairRequested, paired) {
    this.rpc = rpc; this.media = media; this.pairRequested = pairRequested; this.paired = paired;
    this.root = path.join(AppPaths.AppDir, 'wwwroot', 'remote');
    this.store = Json.load(StorePath(), { devices: [] });
    this.clients = new Set();
    this.server = null; this.port = 0; this.lastError = null;
    this.code = null; this.codeUntil = 0; this.codeFails = 0; this.lastCodeRequest = 0;
  }
  get running() { return !!this.server; }
  get hasClients() { return this.clients.size > 0; }
  get pendingCode() { return this.code && Date.now() < this.codeUntil ? this.code : null; }

  start(port) {
    this.stop();
    this.port = port;
    return new Promise(resolve => {
      const srv = http.createServer((req, res) => this.handle(req, res).catch(e => { Log.error('Remote request', e); try { res.writeHead(500); res.end(); } catch { } }));
      srv.keepAliveTimeout = 60000;
      srv.on('error', e => {
        this.server = null;
        this.lastError = e.code === 'EADDRINUSE' ? `連接埠 ${port} 已被其他程式使用，請換一個連接埠。` : e.message;
        Log.error('Remote server start', e);
        resolve();
      });
      srv.listen(port, '0.0.0.0', () => {
        this.server = srv; this.lastError = null;
        Log.info(`Remote server listening on port ${port}: ${this.urls().join(', ')}`);
        resolve();
      });
    });
  }
  stop() {
    if (this.server) { try { this.server.close(); this.server.closeAllConnections && this.server.closeAllConnections(); } catch { } }
    this.server = null;
    for (const c of this.clients) try { c.end(); } catch { }
    this.clients.clear();
  }

  urls() {
    const list = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
        // en0/en1 (Wi-Fi / Ethernet) first; utun/bridge interfaces last
        const pri = /^en\d/.test(name) ? 0 : /^(utun|bridge|vmnet|awdl|llw)/.test(name) ? 2 : 1;
        list.push({ ip: a.address, pri });
      }
    }
    return [...new Set(list.sort((a, b) => a.pri - b.pri).map(x => `http://${x.ip}:${this.port}`))];
  }
  deviceList() {
    return this.store.devices.slice().sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
      .map(d => ({ id: hash(d.token), name: d.name, created: d.created, lastSeen: d.lastSeen, lastIp: d.lastIp }));
  }
  revoke(id) { this.store.devices = this.store.devices.filter(d => hash(d.token) !== id); this.save(); }
  save() { try { Json.saveAtomic(StorePath(), this.store); } catch (e) { Log.error('Remote store', e); } }

  broadcast(json) {
    const frame = 'data: ' + json + '\n\n';
    for (const c of this.clients) { try { if (c.writableLength < 512 * 1024) c.write(frame); } catch { } }
  }

  authorized(req, query) {
    let token = req.headers['x-miku-token'];
    if (!token && req.headers.cookie) for (const part of req.headers.cookie.split(';')) { const kv = part.trim(); if (kv.startsWith('miku_token=')) { token = kv.slice(11); break; } }
    if (!token) token = query.get('t');
    if (!token) return false;
    const d = this.store.devices.find(x => x.token === token);
    if (!d) return false;
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (Date.now() - new Date(d.lastSeen).getTime() > 600000 || d.lastIp !== ip) { d.lastSeen = new Date().toISOString(); d.lastIp = ip; this.save(); }
    return true;
  }

  async body(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 1 << 20) throw new Error('body too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  send(req, res, status, type, body, extra = {}) {
    if (!Buffer.isBuffer(body)) body = Buffer.from(body || '');
    const headers = { 'Content-Type': type, ...extra };
    const finish = data => {
      if (res.destroyed || res.writableEnded) return;
      headers['Content-Length'] = data.length;
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    };
    if (body.length > 1024 && /^text\/|json|javascript/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      zlib.gzip(body, { level: 1 }, (err, compressed) => {
        if (!err) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
        finish(err ? body : compressed);
      });
      return;
    }
    finish(body);
  }
  json(req, res, status, value, extra = {}) { this.send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-store', ...extra }); }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname, q = u.searchParams;
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (req.method === 'OPTIONS') return this.send(req, res, 204, 'text/plain', '');
    if (p === '/api/events') {
      if (!this.authorized(req, q)) return this.json(req, res, 401, { e: 'unpaired' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      req.socket.setNoDelay(true);
      this.clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
      const done = () => { clearInterval(ping); this.clients.delete(res); };
      req.on('close', done); res.on('error', done);
      return;
    }
    if (p.startsWith('/api/pair/') && !isLocalNetwork(ip)) return this.json(req, res, 403, { e: '為了安全，第一次配對只能在家裡的 Wi-Fi 或 Tailscale 內進行。配對好之後在外面也能用。' });
    if (p.startsWith('/stream/')) {
      if (!this.authorized(req, q)) return this.json(req, res, 401, { e: 'unpaired' });
      return this.stream(req, res, decodeURIComponent(p.slice(8)), q);
    }
    if (p === '/api/ping') return this.json(req, res, 200, { app: 'MIKU', paired: this.authorized(req, q) });
    if (p === '/api/pair/request' && req.method === 'POST') {
      const name = readName(await this.body(req));
      let code;
      if (Date.now() - this.lastCodeRequest < 2000 && this.code) code = this.code;
      else {
        if (!this.code || Date.now() >= this.codeUntil) { this.code = String(crypto.randomInt(0, 10000)).padStart(4, '0'); this.codeFails = 0; }
        this.codeUntil = Date.now() + 180000;
        code = this.code;
      }
      this.lastCodeRequest = Date.now();
      this.pairRequested && this.pairRequested(name, code);
      return this.json(req, res, 200, { ok: true });
    }
    if (p === '/api/pair/confirm' && req.method === 'POST') {
      const b = await this.body(req);
      const name = readName(b);
      let code = null;
      try { code = String(JSON.parse(b.toString()).code || '').trim(); } catch { }
      let dev = null;
      if (this.code && Date.now() < this.codeUntil && code && code.length === 4 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.code))) {
        dev = { token: crypto.randomBytes(24).toString('hex'), name, created: new Date().toISOString(), lastSeen: new Date().toISOString(), lastIp: ip };
        this.store.devices.push(dev); this.save(); this.code = null;
      } else if (this.code && ++this.codeFails >= 5) this.code = null;
      if (!dev) return this.json(req, res, 403, { e: '配對碼錯誤或已過期，請重新取得配對碼。' });
      this.paired && this.paired(name);
      return this.json(req, res, 200, { token: dev.token }, { 'Set-Cookie': `miku_token=${dev.token}; Path=/; Max-Age=315360000; SameSite=Strict; HttpOnly` });
    }
    if (p.startsWith('/api/') || p.startsWith('/media/')) {
      if (!this.authorized(req, q)) return this.json(req, res, 401, { e: 'unpaired' });
      if (p === '/api/rpc' && req.method === 'POST') {
        let r = null, e = null;
        try { const m = JSON.parse((await this.body(req)).toString()); r = await this.rpc(m.m, m.a || {}); }
        catch (ex) { e = ex.message; }
        return this.json(req, res, 200, { r: r === undefined ? null : r, e });
      }
      if (p.startsWith('/media/')) {
        let r = null;
        try { r = await this.media(p.slice(6), q); } catch (ex) { Log.error('Remote media ' + p, ex); }
        if (!r || !r.data) return this.send(req, res, 404, 'text/plain', 'not found', { 'Cache-Control': 'no-store' });
        return this.send(req, res, 200, r.type, r.data, { 'Cache-Control': 'private, ' + r.cache });
      }
      return this.json(req, res, 404, { e: 'not found' });
    }
    // static files
    let rel = decodeURIComponent(p).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    const file = rel === 'icon.png' ? path.join(AppPaths.AppDir, 'wwwroot', 'icon.png') : path.resolve(this.root, rel);
    if (rel !== 'icon.png' && !file.startsWith(path.resolve(this.root) + path.sep)) return this.send(req, res, 403, 'text/plain', 'forbidden');
    let data;
    try { data = await fs.promises.readFile(file); } catch { return this.send(req, res, 404, 'text/plain', 'not found'); }
    this.send(req, res, 200, Types[path.extname(file).toLowerCase()] || 'application/octet-stream', data, { 'Cache-Control': 'no-cache' });
  }
}

// ───────────── 「在手機上聽」: /stream/{trackId} (port of RemoteStream.cs) ─────────────
// A file the phone's browser can play (listed in c=) goes as it is, with Range support so the phone can seek in it;
// anything else (DSD, APE, WMA…), or a lossless track when a lower quality (q=128…320) is asked for, is encoded by FFmpeg to
// MP3 as it is sent. Such a stream has no length, so the phone seeks by asking again with ss= (seconds).
const MaxTranscodes = 6;
let transcodes = 0;

/** Addresses a phone may pair from: the home network, this Mac and Tailscale (100.64/10). */
function isLocalNetwork(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (m) {
    const a = +m[1], b = +m[2];
    return a === 10 || (a === 172 && (b & 0xF0) === 16) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && (b & 0xC0) === 64);
  }
  return /^fe[89ab]/i.test(ip) || /^f[cd]/i.test(ip);
}

function directFormat(t) {
  const ext = path.extname(t.path || '').toLowerCase();
  switch (t.codec) {
    case 'MP3': return { cap: 'mp3', mime: 'audio/mpeg' };
    case 'AAC': return { cap: 'aac', mime: ext === '.aac' ? 'audio/aac' : 'audio/mp4' };
    case 'ALAC': return { cap: 'alac', mime: 'audio/mp4' };
    case 'FLAC': return { cap: 'flac', mime: 'audio/flac' };
    case 'WAV': return t.bits > 0 && t.bits <= 24 ? { cap: 'wav', mime: 'audio/wav' } : null;
    case 'OGG': return { cap: 'ogg', mime: 'audio/ogg' };
    case 'OPUS': return { cap: 'opus', mime: 'audio/ogg' };
  }
  return null;
}

RemoteServer.prototype.stream = async function (req, res, id, q) {
  let t = null;
  try { t = this.trackResolver ? this.trackResolver(id) : null; } catch (e) { Log.error('Remote stream track', e); }
  if (!t || t.codec === 'YouTube' || !t.path || id.startsWith('cd-') || !fs.existsSync(t.path)) return this.send(req, res, 404, 'text/plain', 'not found', { 'Cache-Control': 'no-store' });
  const kbps = { 128: 128, 192: 192, 256: 256, 320: 320 }[q.get('q')] || 0;   // 0: original
  const caps = new Set((q.get('c') || '').split(',').filter(Boolean));
  const ss = Math.max(0, parseFloat(q.get('ss')) || 0);
  const d = directFormat(t);
  const lossy = ['MP3', 'AAC', 'OGG', 'OPUS', 'WMA'].includes(t.codec);
  // a lossy file the phone can play always goes as it is (encoding it again only loses more); the page makes the
  // same choice from the codec alone (Local.direct in remote/app.js), so it knows whether it can seek in it
  if (d && caps.has(d.cap) && (kbps === 0 || lossy)) return this.sendFile(req, res, t.path, d.mime);
  return this.transcode(req, res, t, kbps || 320, ss);
};

RemoteServer.prototype.sendFile = async function (req, res, file, mime) {
  let size;
  try { size = (await fs.promises.stat(file)).size; } catch { return this.send(req, res, 404, 'text/plain', 'not found', { 'Cache-Control': 'no-store' }); }
  let start = 0, end = size - 1, status = 200;
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, size - parseInt(m[2], 10));
    else { start = parseInt(m[1] || '0', 10); if (m[2]) end = Math.min(size - 1, parseInt(m[2], 10)); }
    if (start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
};

RemoteServer.prototype.transcode = async function (req, res, t, kbps, ss) {
  const { Ffmpeg } = require('./ffmpeg');
  if (!Ffmpeg.path) return this.send(req, res, 415, 'text/plain; charset=utf-8', '這首歌的格式需要 FFmpeg 轉換才能在手機上播放，但 Mac 上找不到 FFmpeg。', { 'Cache-Control': 'no-store' });
  if (transcodes >= MaxTranscodes) return this.send(req, res, 503, 'text/plain', 'busy', { 'Cache-Control': 'no-store', 'Retry-After': '2' });
  const enc = await require('./converter').getEncoders();
  const mp3 = enc.has('libmp3lame');
  const aac = ['aac_at', 'aac'].find(e => enc.has(e));
  if (!mp3 && !aac) return this.send(req, res, 415, 'text/plain; charset=utf-8', 'Mac 上的 FFmpeg 沒有 MP3 / AAC 編碼器。', { 'Cache-Control': 'no-store' });
  const rate = (t.sampleRate > 0 ? t.sampleRate : 44100) % 11025 === 0 ? 44100 : 48000;
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  if (ss > 0.01) args.push('-ss', ss.toFixed(3));
  args.push('-i', t.path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '2', '-ar', String(rate));
  if (mp3) args.push('-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', 'pipe:1');
  else args.push('-c:a', aac, '-b:a', kbps + 'k', '-f', 'adts', 'pipe:1');
  transcodes++;
  let done = false;
  const proc = spawn(Ffmpeg.path, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const finish = () => { if (done) return; done = true; transcodes--; try { proc.kill('SIGKILL'); } catch { } };
  proc.on('error', e => { Log.error('Remote stream ffmpeg', e); finish(); res.destroy(); });
  proc.on('exit', () => { if (!done) { done = true; transcodes--; } });
  // the phone skipped, seeked or went away: stop encoding
  res.on('close', finish);
  // no Content-Length: the stream ends when FFmpeg is done
  res.writeHead(200, { 'Content-Type': mp3 ? 'audio/mpeg' : 'audio/aac', 'Cache-Control': 'no-store', Connection: 'close' });
  if (req.method === 'HEAD') { finish(); return res.end(); }
  proc.stdout.pipe(res);
};

function readName(buf) {
  try { const n = String(JSON.parse(buf.toString()).name || '').trim(); if (n) return n.slice(0, 40); } catch { }
  return '手機';
}

module.exports = { RemoteServer, isLocalNetwork };
