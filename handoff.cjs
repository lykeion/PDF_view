'use strict';

// Short-lived, loopback-only transport for this viewer's own reading state.
// No Chrome profile files or other sites' data are accessed.
const crypto = require('node:crypto');
const MAX_STATE = 256 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const KEYS = ['naranhi-history', 'naranhi-last-document'];

function reply(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}
function failure(status, message) { return Object.assign(new Error(message), {status}); }
function body(req, max) {
  if (Number(req.headers['content-length']) > max) { req.resume(); return Promise.reject(failure(413, 'Transfer is too large.')); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const onData = chunk => {
      size += chunk.length;
      if (size > max) { cleanup(); req.resume(); reject(failure(413, 'Transfer is too large.')); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onError = () => { cleanup(); reject(failure(400, 'Transfer interrupted.')); };
    function cleanup() { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError); }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onError);
  });
}
function validateState(value, file) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['storage', 'file'].includes(key))) throw failure(400, 'Invalid viewer state.');
  const storage = value.storage;
  if (!storage || Array.isArray(storage) || typeof storage !== 'object' || Object.keys(storage).some(key => !KEYS.includes(key))) throw failure(400, 'Invalid storage keys.');
  for (const value of Object.values(storage)) if (typeof value !== 'string') throw failure(400, 'Invalid storage value.');
  if (storage['naranhi-history']) {
    const history = JSON.parse(storage['naranhi-history']);
    if (!history || Array.isArray(history) || typeof history !== 'object' || Object.keys(history).length > 40 || Object.entries(history).some(([key, item]) => key.length > 2048 || !item || !Number.isSafeInteger(item.page) || item.page < 1)) throw failure(400, 'Invalid reading history.');
  }
  const last = storage['naranhi-last-document'] ? JSON.parse(storage['naranhi-last-document']) : null;
  if (last && (!['library', 'local'].includes(last.type) || typeof last.name !== 'string' || last.name.length > 2048 || (last.type === 'library' && !/^[a-f0-9]{24}$/.test(last.id)) || (last.type === 'local' && (typeof last.key !== 'string' || last.key.length > 2048)))) throw failure(400, 'Invalid last document.');
  if (last?.type === 'local') {
    const meta = value.file;
    if (!meta || !file || meta.key !== last.key || typeof meta.name !== 'string' || meta.name !== last.name || typeof meta.type !== 'string' || meta.type.length > 100 || !Number.isSafeInteger(meta.lastModified) || meta.lastModified < 0 || meta.size !== file.length || meta.size > MAX_FILE || meta.key !== `local:${meta.name}:${meta.size}:${meta.lastModified}`) throw failure(400, 'The saved PDF is incomplete.');
    return {storage, file: {key: meta.key, name: meta.name, type: meta.type, lastModified: meta.lastModified, size: meta.size}};
  }
  if (value.file || file) throw failure(400, 'Unexpected PDF transfer.');
  return {storage, file: null};
}
function createHandoffHandler() {
  const transfers = new Map();
  return async function handoff(req, res, url) {
    if (!url.pathname.startsWith('/api/handoff')) return false;
    try {
      if (req.method === 'POST' && req.headers['x-viewer-handoff'] !== '1') throw failure(403, 'Missing handoff header.');
      if (url.pathname === '/api/handoff' && req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'JSON required.');
        await body(req, 1024);
        for (const [key, entry] of transfers) if (entry.imported) transfers.delete(key);
        if (transfers.size >= 2) throw failure(429, 'A transfer is already in progress.');
        const token = crypto.randomBytes(32).toString('hex');
        transfers.set(token, {state: null, file: null, imported: false, busy: false});
        setTimeout(() => transfers.delete(token), 120000).unref();
        reply(res, 201, {token}); return true;
      }
      const match = /^\/api\/handoff\/([a-f0-9]{64})\/(status|state|file|complete)$/.exec(url.pathname);
      const entry = match && transfers.get(match[1]);
      if (!entry) throw failure(404, 'Transfer expired or not found.');
      const action = match[2];
      if (req.method === 'GET' && action === 'status') reply(res, 200, {ready: !!entry.state || entry.imported, imported: entry.imported});
      else if (req.method === 'GET' && action === 'state' && entry.state) reply(res, 200, entry.state);
      else if (req.method === 'GET' && action === 'file' && entry.state?.file && entry.file) {
        res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': entry.file.length, 'Cache-Control': 'no-store'}); res.end(entry.file);
      } else if (req.method === 'POST' && action === 'complete' && entry.state) {
        await body(req, 1024); entry.state = null; entry.file = null; entry.imported = true; reply(res, 200, {imported: true});
      } else if (req.method === 'POST' && ['state', 'file'].includes(action) && !entry.state && !entry.imported && !entry.busy) {
        entry.busy = true;
        try {
          if (action === 'file') {
            if (req.headers['content-type'] !== 'application/pdf') throw failure(415, 'PDF required.');
            const file = await body(req, MAX_FILE);
            if (!file.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw failure(400, 'Invalid PDF.');
            entry.file = file;
          } else {
            if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'JSON required.');
            entry.state = validateState(JSON.parse((await body(req, MAX_STATE)).toString('utf8')), entry.file);
          }
          reply(res, 200, {ready: !!entry.state});
        } finally { entry.busy = false; }
      } else throw failure(409, 'Transfer is not ready or already completed.');
    } catch (error) { if (!res.headersSent) reply(res, error.status || 400, {error: error.message || 'Unable to transfer reading state.'}); }
    return true;
  };
}
module.exports = {createHandoffHandler};
