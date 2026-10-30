'use strict';
const { createAuth, equal } = require('./streamlabs-auth');
function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function authorized(req) {
  let formKey = '';
  if (req.method === 'POST' && req.query?.action === 'connect') {
    formKey = typeof req.body === 'string' && String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')
      ? new URLSearchParams(req.body).get('controlKey') : req.body?.controlKey;
  }
  const supplied = req.headers['x-control-key'] || req.query?.key || formKey || '';
  return Boolean(process.env.QSS_CONTROL_SECRET) && equal(supplied, process.env.QSS_CONTROL_SECRET);
}
function sameOrigin(req, origin) {
  return req.headers.origin ? req.headers.origin === origin : Boolean(req.headers['x-control-key']);
}
function parseBody(req) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (JSON.stringify(body).length > 20000) throw new Error('Connection settings are too large.');
  return body;
}
function makeAuth() {
  const { createStore } = require('./streamlabs-store');
  const { saveConfig } = require('./qss-state');
  return createAuth({
    origin: process.env.QSS_STREAMLABS_ORIGIN || 'https://quiet-storm-sports-production.up.railway.app',
    store: createStore(),
    activate: async streamlabsToken => {
      try { await saveConfig({ streamlabsToken, automationEnabled: true }); }
      catch { throw new Error('The Streamlabs event connection could not be saved. Try again from the QSS remote.'); }
    },
    deactivate: async () => {
      try { await saveConfig({ streamlabsToken: '', automationEnabled: false }); }
      catch { throw new Error('The Streamlabs event connection could not be disconnected. Try again.'); }
    }
  });
}
function makeControlHandler(auth = makeAuth()) {
  return async (req, res) => {
    secureHeaders(res);
    if (!authorized(req)) return res.status(403).json({ ok: false, error: 'Open your private QSS control link to manage Streamlabs.' });
    try {
      if (req.method === 'GET') return res.status(200).json(await auth.status());
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      if (!sameOrigin(req, auth.origin)) return res.status(403).json({ ok: false, error: 'Open the Streamlabs connection from your QSS remote.' });
      const action = req.query?.action;
      const body = action === 'connect' ? {} : parseBody(req);
      const selectedAction = action || body.action;
      if (selectedAction === 'configure') return res.status(200).json(await auth.configure(body));
      if (selectedAction === 'disconnect') return res.status(200).json(await auth.disconnect());
      if (selectedAction === 'connect') {
        const result = await auth.begin();
        res.setHeader('Set-Cookie', result.cookie);
        return res.redirect(303, result.authorizationUrl);
      }
      return res.status(400).json({ ok: false, error: 'Unknown Streamlabs action.' });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'The Streamlabs connection could not be updated.' });
    }
  };
}
function makeCallbackHandler(auth = makeAuth()) {
  return async (req, res) => {
    secureHeaders(res);
    if (req.method !== 'GET') return res.status(405).end();
    try {
      const result = await auth.complete(req.query || {}, req.headers.cookie || '');
      res.setHeader('Set-Cookie', result.cookie);
      return res.redirect(303, '/streamlabs-result.html?status=connected');
    } catch {
      res.setHeader('Set-Cookie', auth.clearCookie());
      return res.redirect(303, '/streamlabs-result.html?status=error');
    }
  };
}
module.exports = { makeControlHandler, makeCallbackHandler, makeAuth };
