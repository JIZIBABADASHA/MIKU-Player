'use strict';
// The companion Builder checks and prepares updates. The player never replaces its running bundle.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const configFile = () => path.join(app.getPath('appData'), 'MIKU Builder', 'updater.json');
function launch(background = false) {
  const config = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  if (background && !config.enabled) return false;
  if (!path.isAbsolute(config.executable) || !fs.existsSync(config.executable)) throw new Error('請先開啟 MIKU Builder，以設定更新工具。');
  const args = Array.isArray(config.args) && config.args.every(a => typeof a === 'string') ? [...config.args] : [];
  if (background) args.push('--background-update');
  const child = spawn(config.executable, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref(); return true;
}
function start(log) {
  const check = () => { try { launch(true); } catch (e) { if (e.code !== 'ENOENT') log.error('Update check', e); } };
  const first = setTimeout(check, 30000); first.unref();
  const repeat = setInterval(check, 6 * 60 * 60 * 1000); repeat.unref();
}
module.exports = { start, launch };
