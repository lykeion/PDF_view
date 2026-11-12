'use strict';
const path = require('node:path');
const {execFile} = require('node:child_process');
function practiceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'railnote.web.app' || url.port || url.username || url.password || url.href.length > 2048) throw new Error('Invalid practice URL');
  return url.href;
}
function openPractice(value, inspect = false) {
  const url = practiceUrl(value);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject) => execFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'practice-app.ps1'),'-Url',url,...(inspect ? ['-Inspect'] : [])],
    {windowsHide:true,timeout:20000,maxBuffer:16384,encoding:'utf8'},(error,stdout) => {
      if (error) return reject(new Error('Unable to open practice app'));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/,'').trim())); } catch { reject(new Error('Invalid app response')); }
    }));
}
function createPracticeHandler(launch = openPractice) {
  let busy = false;
  const reply = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value)); };
  return async (req,res,url) => {
    if (url.pathname !== '/api/practice/open') return false;
    if (req.method !== 'POST' || !['http://127.0.0.1:43187','http://localhost:43187'].includes(req.headers.origin) || !req.headers['content-type']?.startsWith('application/json')) { req.resume();reply(res,403,{error:'Invalid practice request'});return true; }
    if (busy) { req.resume();reply(res,409,{error:'Practice launch in progress'});return true; }
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Request too large'); }
      const target = practiceUrl(JSON.parse(body).url);
      reply(res,200,await launch(target));
    } catch { reply(res,400,{error:'Unable to open practice app'}); }
    finally { busy = false; }
    return true;
  };
}
module.exports = {practiceUrl,openPractice,createPracticeHandler};
