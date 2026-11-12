'use strict';

// The web Fullscreen API cannot exit Chrome's --start-fullscreen mode. Expose
// only an idempotent restore/maximize operation for this reader's own window.
const crypto = require('node:crypto');
const path = require('node:path');
const {execFile} = require('node:child_process');
function restoreWindow(profileRoot, token, action = 'Restore') {
  if (!/^[a-f0-9]{32}$/.test(token)) return Promise.reject(new Error('Invalid window token.'));
  if (!['Restore','Enter','Icon'].includes(action)) return Promise.reject(new Error('Invalid window action.'));
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',path.join(__dirname,'native-window.ps1'),'-ProfileRoot',profileRoot,'-WindowToken',token,'-Action',action],
    {windowsHide:true,timeout:15000,maxBuffer:16384,encoding:'utf8'}, (error, stdout) => {
      if (error) return reject(new Error('Unable to restore the viewer window.'));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('Invalid window response.')); }
    });
  });
}
function createWindowControl(root) {
  const tickets = new Map();
  let busy = false;
  const reply = (res, code, value) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/window/')) return false;
    req.resume();
    for (const [token, expiry] of tickets) if (expiry < Date.now()) tickets.delete(token);
    if (url.pathname === '/api/window/session' && req.method === 'GET') {
      if (tickets.size >= 16) { reply(res,429,{error:'Too many window requests.'}); return true; }
      const token = crypto.randomBytes(16).toString('hex'); tickets.set(token,Date.now()+30000);
      reply(res,200,{token}); return true;
    }
    const actions = {'/api/window/restore':'Restore','/api/window/fullscreen':'Enter','/api/window/icon':'Icon'};
    if (!actions[url.pathname] || req.method !== 'POST') { reply(res,404,{error:'Not found.'}); return true; }
    const token = req.headers['x-viewer-window'];
    if (!['http://127.0.0.1:43187','http://localhost:43187'].includes(req.headers.origin) || !tickets.has(token)) { reply(res,403,{error:'Invalid window request.'}); return true; }
    tickets.delete(token);
    if (busy) { reply(res,409,{error:'Window restoration is already in progress.'}); return true; }
    busy = true;
    try { reply(res,200,await restoreWindow(path.join(root,'.browser-profile'),token,actions[url.pathname])); }
    catch { reply(res,503,{error:'Unable to restore the viewer window.'}); }
    finally { busy = false; }
    return true;
  };
}
module.exports = {createWindowControl, restoreWindow};
