'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function start(directory, upstreamOrigin) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: '0', QSS_DATA_DIR: directory, QSS_DISABLE_AUTOMATION: '1',
      QSS_CONTROL_SECRET: 'qss-test', PRP_CONTROL_SECRET: 'prp-test', PRP_REMOTE_ORIGIN: upstreamOrigin,
      QSS_STREAMLABS_ORIGIN: 'https://remote.example', QSS_STREAMLABS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      QSS_INITIAL_STATE_JSON: JSON.stringify({ topic: 'QSS separate topic', subsCurrent: 8770, showSupporters: false, accent: '#abcdef', supporters: [{ name: 'Channel Fan', type: 'NEW SUB', value: 'SUB' }] })
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PRP app did not start')); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; const found = output.match(/listening on (\d+)/); if (found) { clearTimeout(timeout); resolve('http://127.0.0.1:' + found[1]); } });
    child.once('exit', code => { clearTimeout(timeout); if (!output.includes('listening on ')) reject(new Error('App exited: ' + code)); });
  });
  return { address, stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); }) };
}
async function nextEvent(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Live stream closed before its update');
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split('\n')) if (line.startsWith('data: ')) return JSON.parse(line.slice(6)).state;
  }
}

test('PRP preserves its rundown while sharing live supporters, exact counts, and queued alerts with QSS', { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prp-overlay-'));
  let legacy = { displayTitle: 'PRP FIRST TOPIC', displayLabel: 'LIVE DISCUSSION', logoText: 'PURPLE REIGN PODCAST', ticker: 'PRP ticker stays separate', visible: true, mode: 'discussion' };
  let online = true, app, controller;
  const upstream = http.createServer((req, res) => {
    if (!online) { res.writeHead(503); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, state: legacy }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  try {
    app = await start(directory, origin);
    const read = async route => (await (await fetch(app.address + route)).json()).state;
    const post = (route, body, headers = { 'x-control-key': 'prp-test' }) => fetch(app.address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const initial = await read('/api/prp-state');
    assert.equal(initial.topic, legacy.displayTitle);
    assert.deepEqual(initial.tickerItems, [legacy.ticker]);
    assert.equal(initial.subsCurrent, 8770); assert.equal(initial.supporters[0].name, 'Channel Fan');
    assert.equal(initial.showSupporters, true); assert.equal(initial.accent, '#9271d6');
    assert.equal((await read('/api/state')).topic, 'QSS separate topic');
    const html = await (await fetch(app.address + '/prp-overlay')).text();
    assert.match(html, /Purple Reign Podcast Lower Third/); assert.match(html, /src="\/prp-logo.svg"/);
    assert.ok(!html.includes('Quiet Storm Sports')); assert.ok(!html.includes('prp-test'));
    assert.equal((await fetch(app.address + '/prp-logo.svg')).status, 200);
    assert.equal((await post('/api/prp-control', { action: 'saveGoal', subsTarget: 12000 }, {})).status, 403);
    assert.equal((await post('/api/prp-control', { action: 'saveGoal', subsTarget: 12000 }, { 'x-control-key': 'prp-test', origin: 'https://other.example' })).status, 403);
    assert.equal((await post('/api/prp-control', { action: 'saveGoal', subsTarget: -2 })).status, 400);
    await post('/api/prp-control', { action: 'saveGoal', subsTarget: 12000 });
    await post('/api/prp-control', { action: 'saveDisplay', accent: '#9271d6', showSupporters: true, showGoal: false, showTicker: false });
    const qss = await read('/api/state'); assert.equal(qss.subsTarget, 10000); assert.equal(qss.showGoal, true); assert.equal(qss.accent, '#abcdef');
    await post('/api/prp-control', { action: 'setExactSubscribers', subsCurrent: 8771 });
    assert.equal((await read('/api/state')).subsCurrent, 8771);
    // Subscribe before the event. Both show consumers must receive the same update.
    controller = new AbortController();
    const prpReader = (await fetch(app.address + '/api/prp-events', { signal: controller.signal })).body.getReader();
    const qssReader = (await fetch(app.address + '/api/events', { signal: controller.signal })).body.getReader();
    await nextEvent(prpReader); await nextEvent(qssReader);
    await post('/api/prp-control', { action: 'addSupporter', name: 'Generous Fan', type: 'GIFTED MEMBERS', value: '5 GIFTS' });
    assert.equal((await nextEvent(prpReader)).supporters[0].value, '5 GIFTS');
    assert.equal((await nextEvent(qssReader)).supporters[0].name, 'Generous Fan');
    // Add real-format queue entries on the isolated test volume, then verify
    // the public merged state carries their identity and exact ten-second timing.
    const sharedPath = path.join(directory, 'qss-overlay/state.json');
    const shared = JSON.parse(await fs.readFile(sharedPath, 'utf8'));
    const now = Date.now();
    shared.superChats = [{ eventId: 'chat', kind: 'superchat', name: 'Donor', value: '$25.00', message: 'Go Ravens', amount: 25, currency: 'USD', startsAt: now, endsAt: now + 10000 }, { eventId: 'gift', kind: 'membership', giftBatch: true, name: 'Gifter', value: '5 GIFTS', avatarUrl: 'https://yt3.ggpht.com/member', startsAt: now + 10000, endsAt: now + 20000 }];
    await fs.writeFile(sharedPath, JSON.stringify(shared));
    const cards = (await read('/api/prp-state')).superChats;
    assert.equal(cards.length, 2); assert.equal(cards[0].message, 'Go Ravens'); assert.equal(cards[1].value, '5 GIFTS'); assert.equal(cards[1].avatarUrl, 'https://yt3.ggpht.com/member');
    assert.equal(cards[0].endsAt - cards[0].startsAt, 10000); assert.equal(cards[1].startsAt, cards[0].endsAt);
    legacy = { ...legacy, displayTitle: 'PRP BREAKING HEADLINE', displayLabel: 'BREAKING NEWS', mode: 'breaking', visible: false };
    const changed = await read('/api/prp-state'); assert.equal(changed.topic, legacy.displayTitle); assert.equal(changed.visible, false); assert.equal(changed.mode, 'breaking');
    controller.abort();
    await app.stop(); online = false;
    app = await start(directory, origin);
    const restored = await read('/api/prp-state');
    assert.equal(restored.topic, 'PRP BREAKING HEADLINE'); assert.equal(restored.subsCurrent, 8771); assert.equal(restored.subsTarget, 12000); assert.equal(restored.showGoal, false); assert.equal(restored.showTicker, false);
    assert.ok(!JSON.stringify(restored).includes('prp-test'));
  } finally {
    controller?.abort(); await app?.stop(); await new Promise(resolve => upstream.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
  }
});
