'use strict';
// A process of its own that carries the YouTube Music panel's audio to a playback core (main.js: the live track).
// The page's blocks come over a MessagePort straight from the panel's renderer and leave on a Unix socket the core's
// helper connects to, so they never wait for MIKU's main process: a window being minimized, a library scan or anything
// else that keeps the main process busy for a moment would otherwise be heard as a gap.
//   argv[2]: the socket path. Data: interleaved float32 stereo frames, as the page hands them over.
const net = require('net');
const fs = require('fs');
const file = process.argv[2];
const clients = new Set();
try { fs.unlinkSync(file); } catch { }
net.createServer(c => {
  clients.add(c);
  c.on('error', () => { }); c.on('close', () => clients.delete(c));
}).listen(file);
const forward = d => {
  if (!d || !d.buffer || !clients.size) return;
  const buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  // a reader that does not keep up (a helper busy starting) loses blocks instead of holding a growing queue
  for (const c of clients) if (c.writableLength < (1 << 20)) c.write(buf);
};
process.parentPort.on('message', e => {
  for (const port of e.ports || []) { port.on('message', m => forward(m.data)); port.start(); }
});
process.on('exit', () => { try { fs.unlinkSync(file); } catch { } });
