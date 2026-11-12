'use strict';

// This server only exposes the viewer assets and the three original PDF folders.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createHandoffHandler} = require('./handoff.cjs');
const {createWindowControl} = require('./window-control.cjs');
const {createPracticeHandler} = require('./practice-app.cjs');
const {createGptDraftHandler} = require('./gpt-draft.cjs');
const {createCatalog} = require('./book-catalog.cjs');
const catalog = createCatalog(__dirname);
const {createUpdater} = require('./updater.cjs');
const appRelease = require('./app-release.json');

const HOST = '127.0.0.1';
const PORT = 43187;
const APP = 'paper-local-pdf-viewer';
const ROOT = __dirname;
const WORKSPACE = path.resolve(ROOT, '..', '..');
const LIBRARY_ROOT = fs.existsSync(path.join(ROOT, 'library')) ? path.join(ROOT, 'library') : WORKSPACE;
const INSTANCE = crypto.createHash('sha256').update(path.resolve(ROOT).toLowerCase()).digest('hex').slice(0, 16);
const LIBRARY_NAMES = ['유관사 개념 pdf', '유관사 기출 pdf', '유관사 최빈출 pdf'];
const STATIC_FILES = new Set(['index.html', 'app.js', 'style.css', 'layout.mjs', 'display-raster.mjs', 'display-worker.mjs', 'margin-crop.mjs', 'wheel-navigation.mjs', 'gpt-question.mjs', 'favicon.svg', 'app-icon.ico', 'practice-links.json', 'handoff.html', 'handoff.js']);
STATIC_FILES.add('library-manager.mjs');STATIC_FILES.add('update-client.mjs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.bin': 'application/octet-stream', '.icc': 'application/octet-stream',
};
const VENDOR_EXTENSIONS = new Set(Object.keys(MIME).filter(ext => ext !== '.html' && ext !== '.pdf'));
const filesById = new Map();
let libraryCache = null;
let libraryTimestamp = 0;
let libraryLoading = null;

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Reject junctions and symbolic links at every component, not just the leaf.
async function safeRegularFile(base, relative) {
  const components = relative.split(/[\\/]/);
  if (!components.length || components.some(part => !part || part === '.' || part === '..' || part.includes(':') || part.startsWith('.'))) return null;
  const absolute = path.resolve(base, ...components);
  if (!isWithin(base, absolute)) return null;
  let current = base;
  const rootInfo = await fsp.lstat(base);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink()) return null;
    if (i < components.length - 1 && !info.isDirectory()) return null;
    if (i === components.length - 1 && !info.isFile()) return null;
  }
  const [realBase, realFile] = await Promise.all([fsp.realpath(base), fsp.realpath(absolute)]);
  return isWithin(realBase, realFile) ? absolute : null;
}

async function scanLibrary() {
  if (libraryCache && Date.now() - libraryTimestamp < 10000) return libraryCache;
  if (libraryLoading) return libraryLoading;
  libraryLoading = (async () => {
    const groups = [];
    const allFiles = [];
    const nextMap = new Map();
    for (const name of LIBRARY_NAMES) {
      const base = path.join(LIBRARY_ROOT, name);
      const groupFiles = [];
      let visited = 0;
      async function walk(directory, depth) {
        if (depth > 6 || visited > 10000) return;
        let entries;
        try {
          const info = await fsp.lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) return;
          entries = await fsp.readdir(directory, {withFileTypes: true});
        } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name, 'ko', {numeric: true}));
        for (const entry of entries) {
          if (++visited > 10000) return;
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(absolute, depth + 1);
          else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
            try {
              const relativePath = path.relative(base, absolute).split(path.sep).join('/');
              const checked = await safeRegularFile(base, relativePath);
              if (!checked) continue;
              const info = await fsp.stat(checked);
              const id = crypto.createHash('sha256').update(name + '/' + relativePath).digest('hex').slice(0, 24);
              const item = {id, name: entry.name, relativePath, size: info.size, modified: info.mtimeMs, group: name};
              groupFiles.push(item);
              allFiles.push(item);
              nextMap.set(id, {base, relativePath});
            } catch { /* An unreadable or concurrently removed PDF is skipped. */ }
          }
        }
      }
      await walk(base, 0);
      groups.push({name, files: groupFiles});
    }
    filesById.clear();
    for (const [id, entry] of nextMap) filesById.set(id, entry);
    libraryCache = {groups, files: allFiles};
    libraryTimestamp = Date.now();
    return libraryCache;
  })();
  try { return await libraryLoading; }
  finally { libraryLoading = null; }
}

function json(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return {start, end};
}

async function sendFile(req, res, absolute, isPdf = false) {
  const info = await fsp.stat(absolute);
  const range = parseRange(req.headers.range, info.size);
  const headers = {
    'Content-Type': MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': isPdf ? 'private, max-age=0, must-revalidate' : 'no-cache',
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
  };
  if (isPdf) headers['Content-Disposition'] = 'inline';
  if (range === false) {
    res.writeHead(416, {...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': '0'});
    return res.end();
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else headers['Content-Length'] = info.size;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !info.size) return res.end();
  const stream = fs.createReadStream(absolute, range || undefined);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function createServer() {
  const handoff = createHandoffHandler();
  const windowControl = createWindowControl(ROOT);
  const practice = createPracticeHandler();
  const gptDraft = createGptDraftHandler();
  const updater = createUpdater(ROOT);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Prevent browser DNS rebinding to the loopback listener.
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) return json(res, 403, {error: 'Invalid local host.'});
    if (req.headers.origin && ![`http://${HOST}:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) return json(res, 403, {error: 'Cross-origin requests are not allowed.'});
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (await handoff(req, res, url)) return;
      if (await windowControl(req, res, url)) return;
      if (await practice(req, res, url)) return;
      if (await gptDraft(req, res, url)) return;
      if (url.pathname==='/api/books/pdf'&&['GET','HEAD'].includes(req.method)){
        const file=await catalog.resolve(url.searchParams.get('id'));if(!file)return json(res,404,{error:'PDF를 찾지 못했습니다.'});return await sendFile(req,res,file,true);
      }
      if (await catalog.handler(req,res,url)) return;
      if (await updater.handler(req,res,url)) return;
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, {error: 'Read-only server.'});
      }
      if (url.pathname === '/api/health') return json(res, 200, {app: APP, version: 1, release:appRelease.version, instance: INSTANCE, handoff: true, windowControl: true});
      if (url.pathname === '/api/library') {const library=await scanLibrary(),custom=await catalog.library();return json(res,200,{groups:[...library.groups,custom],files:[...library.files,...custom.files]});}
      if (url.pathname === '/api/pdf') {
        const id = url.searchParams.get('id');
        if (!/^[a-f0-9]{24}$/.test(id || '')) return json(res, 404, {error: 'PDF not found.'});
        await scanLibrary();
        const entry = filesById.get(id);
        if (!entry) return json(res, 404, {error: 'PDF not found.'});
        const absolute = await safeRegularFile(entry.base, entry.relativePath);
        if (!absolute) return json(res, 404, {error: 'PDF not found.'});
        return await sendFile(req, res, absolute, true);
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
      const extension = path.extname(relative).toLowerCase();
      const isVendorAsset = relative.startsWith('vendor/') && VENDOR_EXTENSIONS.has(extension);
      if (!STATIC_FILES.has(relative) && !isVendorAsset) return json(res, 404, {error: 'Not found.'});
      const absolute = await safeRegularFile(ROOT, relative);
      if (!absolute) return json(res, 404, {error: 'Not found.'});
      return await sendFile(req, res, absolute);
    } catch (error) {
      if (!res.headersSent) json(res, ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? 404 : 400, {error: 'Unable to open this local resource.'});
      else res.destroy();
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Run launch.ps1 to verify the existing viewer.`
      : `Unable to start viewer: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => console.log(`PDF viewer: http://${HOST}:${PORT}`));
}

module.exports = {createServer, parseRange, isWithin, safeRegularFile, scanLibrary, HOST, PORT, APP};
