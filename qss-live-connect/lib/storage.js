'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const events = new EventEmitter();
const allowed = new Set(['qss-overlay/state.json', 'qss-overlay/config.enc.json', 'qss-overlay/streamlabs-oauth.enc.json']);

function location(name) {
  if (!allowed.has(name)) throw new Error('Unknown QSS data file.');
  return path.join(path.resolve(process.env.QSS_DATA_DIR || path.join(__dirname, '..', 'runtime-data')), name);
}
async function get(name) {
  try { return { statusCode: 200, stream: await fs.readFile(location(name), 'utf8') }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function put(name, body) {
  const destination = location(name);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, destination); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  events.emit('change', name);
}
async function seed() {
  const seeds = [
    ['qss-overlay/state.json', 'QSS_INITIAL_STATE_JSON'],
    ['qss-overlay/config.enc.json', 'QSS_INITIAL_CONFIG_JSON'],
    ['qss-overlay/streamlabs-oauth.enc.json', 'QSS_INITIAL_OAUTH_JSON']
  ];
  for (const [name, variable] of seeds) {
    const body = process.env[variable];
    if (!body || await get(name)) continue;
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid QSS migration data.');
    await put(name, JSON.stringify(value));
  }
}
module.exports = { get, put, seed, events };
