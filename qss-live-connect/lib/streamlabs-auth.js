'use strict';

const crypto = require('node:crypto');
const API = 'https://streamlabs.com/api/v2.0';
const COOKIE = '__Host-qss_streamlabs_oauth';
const clean = (value, limit = 4096) => String(value || '').trim().slice(0, limit);
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function equal(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function encryptionKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32) throw new Error('The secure Streamlabs connection is not configured.');
  return key;
}
function encrypt(value, keyValue) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(value, keyValue) {
  if (!value) return {};
  if (value.version !== 1) throw new Error('Unsupported Streamlabs settings version.');
  const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(value.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
}
function cookieValue(header) {
  const pair = String(header || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  return pair ? pair.slice(COOKIE.length + 1) : '';
}
function createAuth({ store, activate, deactivate, origin, fetchImpl = globalThis.fetch, now = Date.now, random = crypto.randomBytes }) {
  const canonical = new URL(origin);
  if (canonical.protocol !== 'https:' || canonical.pathname !== '/' || canonical.search || canonical.hash) throw new Error('A secure QSS origin is required.');
  const redirectUri = canonical.origin + '/api/streamlabs-callback';
  const cookie = (value, maxAge = 600) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  async function request(path, options) {
    let response;
    try {
      response = await fetchImpl(API + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('Streamlabs could not be reached. Try the connection again.'); }
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) throw new Error('Streamlabs did not approve the connection. Check the application settings and account whitelist, then try again.');
      throw new Error('Streamlabs is temporarily unavailable. Try the connection again.');
    }
    try { return await response.json(); } catch { throw new Error('Streamlabs returned an invalid response.'); }
  }
  return {
    origin: canonical.origin,
    redirectUri,
    async status() {
      const c = await store.read();
      return {
        ok: true, applicationConfigured: Boolean(c.clientId && c.clientSecret),
        authorized: Boolean(c.accessToken), connectedAt: c.connectedAt || '', clientId: c.clientId || '',
        includeFreeSubscribers: true, scope: 'socket.token', redirectUri,
        website: canonical.origin + '/qss-overlay', applicationName: 'Quiet Storm Sports',
        lastError: c.lastError || ''
      };
    },
    async configure(body) {
      const c = await store.read();
      const clientId = clean(body.clientId, 200), clientSecret = clean(body.clientSecret, 4096) || c.clientSecret;
      if (!/^[A-Za-z0-9_-]{4,200}$/.test(clientId) || !clientSecret || clientSecret.length < 8 || /[\r\n]/.test(clientSecret)) throw new Error('Enter the Streamlabs application client ID and client secret.');
      const changed = clientId !== c.clientId || clientSecret !== c.clientSecret;
      if (changed && c.accessToken) await deactivate();
      await store.write(changed ? { clientId, clientSecret, lastError: '' } : { ...c, clientId, clientSecret, lastError: '' });
      return this.status();
    },
    async begin() {
      const c = await store.read();
      if (!c.clientId || !c.clientSecret) throw new Error('Complete the one-time Streamlabs application setup first.');
      const state = random(32).toString('hex'), browser = random(32).toString('hex');
      await store.write({ ...c, pending: { stateHash: hash(state), browserHash: hash(browser), expiresAt: now() + 600000 }, lastError: '' });
      const authorization = new URL(API + '/authorize');
      authorization.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri, scope: 'socket.token', state }).toString();
      return { authorizationUrl: authorization.toString(), cookie: cookie(browser) };
    },
    async complete(query, cookieHeader) {
      const c = await store.read();
      const state = clean(query.state, 200), browser = cookieValue(cookieHeader), pending = c.pending;
      if (!pending || pending.expiresAt <= now() || !equal(pending.stateHash, hash(state)) || !equal(pending.browserHash, hash(browser))) throw new Error('This connection link expired or belongs to another browser. Start again from the QSS remote.');
      const ready = { ...c, pending: undefined };
      await store.write(ready);
      if (query.error) throw new Error('The Streamlabs connection was not approved.');
      const code = clean(query.code, 4096);
      if (!code) throw new Error('Streamlabs did not return an authorization code.');
      const tokens = await request('/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, code }).toString()
      });
      const accessToken = clean(tokens.access_token, 8192);
      if (!accessToken || /[\r\n]/.test(accessToken)) throw new Error('Streamlabs did not return an access token.');
      const result = await request('/socket/token', { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } });
      const socketToken = clean(result.socket_token, 8192);
      if (!socketToken || /[\r\n]/.test(socketToken)) throw new Error('Streamlabs did not return an event connection token.');
      await activate(socketToken);
      await store.write({ ...ready, accessToken, refreshToken: clean(tokens.refresh_token, 8192), connectedAt: new Date(now()).toISOString(), lastError: '' });
      return { cookie: cookie('', 0) };
    },
    async disconnect() {
      const c = await store.read();
      await deactivate();
      await store.write({ clientId: c.clientId || '', clientSecret: c.clientSecret || '', lastError: '' });
      return this.status();
    },
    clearCookie: () => cookie('', 0)
  };
}

module.exports = { createAuth, encrypt, decrypt, equal, COOKIE };
