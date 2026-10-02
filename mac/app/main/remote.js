'use strict';
// LAN web server for the phone remote: static files, library / artwork, JSON RPC and an SSE state stream.
// Phones pair once with a 4-digit code shown on the Mac. Port of RemoteServer.cs
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
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
    if (body.length > 1024 && /^text\/|json|javascript/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body, { level: 1 });
      headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
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

function readName(buf) {
  try { const n = String(JSON.parse(buf.toString()).name || '').trim(); if (n) return n.slice(0, 40); } catch { }
  return '手機';
}

module.exports = { RemoteServer };
