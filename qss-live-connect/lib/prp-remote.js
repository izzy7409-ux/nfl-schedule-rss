'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encrypt, decrypt, equal } = require('./streamlabs-auth');
const template = fs.readFileSync(path.join(__dirname, '..', 'prp-control.html'), 'utf8');
const cookieName = '__Host-prp_remote';
const pages = new Set(['/lower-third-control', '/prp-remote']);
const apiPaths = new Set(['/api/lower-third-state', '/api/lower-third-stream', '/api/lower-third-control']);
const attribute = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createRemote({ fetchImpl = fetch, origin = process.env.QSS_STREAMLABS_ORIGIN || 'https://quiet-storm-sports-production.up.railway.app', upstreamOrigin = process.env.PRP_REMOTE_ORIGIN || 'https://ravens-live-tracker-production.up.railway.app', prpKey = process.env.PRP_CONTROL_SECRET || '', qssKey = process.env.QSS_CONTROL_SECRET || '', encryptionKey = process.env.QSS_STREAMLABS_ENCRYPTION_KEY, now = Date.now } = {}) {
  const binding = crypto.createHash('sha256').update(prpKey + '\0' + qssKey).digest('hex');
  function validKey(value) { return Boolean(value) && (Boolean(qssKey) && equal(value, qssKey) || Boolean(prpKey) && equal(value, prpKey)); }
  function session(req) {
    try {
      const value = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!value) return false;
      const data = decrypt(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')), encryptionKey);
      return data.purpose === 'prp-remote' && data.expiresAt > now() && equal(data.binding, binding);
    } catch { return false; }
  }
  function authorized(req, url) { return validKey(req.headers['x-control-key'] || url.searchParams.get('key') || '') || session(req); }
  function setSession(res) {
    const data = encrypt({ purpose: 'prp-remote', binding, expiresAt: now() + 43200000 }, encryptionKey);
    res.setHeader('Set-Cookie', cookieName + '=' + Buffer.from(JSON.stringify(data)).toString('base64url') + '; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Lax');
  }
  function login(res, failed = false) {
    res.statusCode = failed ? 401 : 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRP Lower Third Remote</title><style>body{margin:0;padding:24px;background:#09070e;color:#fff;font:16px Arial,sans-serif}main{max-width:480px;margin:10vh auto;padding:28px;background:#171321;border:1px solid #453653;border-radius:20px}h1{margin-top:0}p{line-height:1.5;color:#c0b8cd}label{display:block;margin:24px 0 9px}input{box-sizing:border-box;width:100%;padding:14px;background:#0c0a12;color:#fff;border:1px solid #54416b;border-radius:10px;font:inherit}button{margin-top:14px;padding:13px 18px;border:0;border-radius:10px;background:#9271d6;color:#fff;font:bold 15px Arial}</style></head><body><main><h1>PRP Lower Third Remote</h1><p>PRP and Quiet Storm Sports controls in one place.</p><form method="post" action="/lower-third-control/login"><label for="remoteLink">Your existing private PRP or QSS remote link</label><input id="remoteLink" name="remoteLink" type="password" autocomplete="off" required><button type="submit">Open controls</button></form>' + (failed ? '<p role="alert">That link could not unlock the remote. Use your full private PRP or QSS remote link.</p>' : '') + '</main></body></html>');
  }
  async function upstream(pathname, options = {}) {
    return fetchImpl(new URL(pathname, upstreamOrigin), { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
  }
  async function verifyUpstream() {
    const response = await upstream('/lower-third-control', { headers: { 'x-control-key': prpKey } });
    await response.text();
    if (!response.ok) throw new Error('The PRP remote could not be reached.');
  }
  function controlHtml() {
    const qss = new URL('/qss-control', origin); qss.searchParams.set('key', qssKey);
    return template.replaceAll('__QSS_REMOTE_URL__', attribute(qss.href));
  }
  async function handle(req, res, url, readBody) {
    const pathname = url.pathname;
    if (!pages.has(pathname) && pathname !== '/lower-third-control/login' && !apiPaths.has(pathname)) return false;
    if (!prpKey || !qssKey) { res.status(503).json({ ok: false, error: 'The combined remote is not configured.' }); return true; }
    if (pathname === '/lower-third-control/login' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== new URL(origin).origin) { res.status(403).json({ ok: false, error: 'Open this form from your remote.' }); return true; }
      const data = await readBody(req), raw = String(data.remoteLink || '').trim();
      let key = raw;
      try { key = new URL(raw).searchParams.get('key') || ''; } catch {}
      if (!validKey(key)) { login(res, true); return true; }
      await verifyUpstream(); setSession(res); res.redirect(303, '/lower-third-control'); return true;
    }
    if (pages.has(pathname) && req.method === 'GET') {
      if (!authorized(req, url)) { login(res, Boolean(url.searchParams.get('key'))); return true; }
      await verifyUpstream();
      if (url.searchParams.has('key')) { setSession(res); res.redirect(303, '/lower-third-control'); return true; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(controlHtml()); return true;
    }
    if (!authorized(req, url)) { res.status(403).json({ ok: false, error: 'Open your private PRP remote first.' }); return true; }
    if (pathname === '/api/lower-third-stream' && req.method === 'GET') {
      const abort = new AbortController(); req.on('close', () => abort.abort());
      try {
        const response = await fetchImpl(new URL(pathname, upstreamOrigin), { signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('The PRP connection is unavailable.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        for await (const chunk of response.body) res.write(chunk);
      } catch { if (!res.headersSent) res.status(503).json({ ok: false, error: 'The PRP connection is unavailable.' }); }
      finally { res.end(); }
      return true;
    }
    let options = {};
    if (pathname === '/api/lower-third-control') {
      if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST required' }); return true; }
      if (req.headers.origin && req.headers.origin !== new URL(origin).origin) { res.status(403).json({ ok: false, error: 'Open the controls from your remote.' }); return true; }
      options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-control-key': prpKey }, body: JSON.stringify(await readBody(req)) };
    } else if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'GET required' }); return true; }
    const response = await upstream(pathname, options);
    res.status(response.status); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(await response.text()); return true;
  }
  return { handle };
}
module.exports = { createRemote };
