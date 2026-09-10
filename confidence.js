const fs = require('fs');
const path = require('path');

const CONFIDENCE_HTML = fs.readFileSync(path.join(__dirname, 'confidence.html'), 'utf8');
const CONTROL_HTML = fs.readFileSync(path.join(__dirname, 'confidence-control.html'), 'utf8');
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const ESPN_SCHEDULE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/33/schedule';
const CONTROL_SECRET = process.env.CONFIDENCE_CONTROL_SECRET || '';

const clients = new Set();
const state = {
  apiKey: process.env.YOUTUBE_API_KEY || '',
  videoId: '',
  videoTitle: '',
  liveChatId: '',
  connected: false,
  votingOpen: false,
  lastError: '',
  nextPageToken: '',
  pollTimer: null,
  pollingIntervalMs: 5000,
  votes: new Map(),
  matchup: null,
  matchupUpdatedAt: 0,
};

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function authorized(url, req) {
  if (!CONTROL_SECRET) return true;
  const q = url.searchParams.get('key') || '';
  const h = String(req.headers['x-control-key'] || '');
  return q === CONTROL_SECRET || h === CONTROL_SECRET;
}
function extractVideoId(input = '') {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    const live = parts.indexOf('live');
    if (live >= 0 && parts[live + 1]) return parts[live + 1];
    const shorts = parts.indexOf('shorts');
    if (shorts >= 0 && parts[shorts + 1]) return parts[shorts + 1];
  } catch {}
  return '';
}
function footballSeasonYear(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m <= 1 ? y - 1 : y;
}
function logoFor(abbr) {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr || '').toLowerCase()}.png`;
}
function normalizeScheduleTeam(c = {}) {
  const t = c.team || c;
  const abbr = String(t.abbreviation || c.abbreviation || '').toUpperCase();
  return {
    id: String(t.id || c.id || ''),
    name: t.shortDisplayName || t.displayName || t.name || abbr || 'Opponent',
    fullName: t.displayName || t.name || abbr || 'Opponent',
    abbr,
    logo: t.logo || t.logos?.[0]?.href || logoFor(abbr),
    homeAway: c.homeAway || '',
  };
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Purple Reign Confidence Meter)' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function refreshMatchup(force = false) {
  if (!force && state.matchup && Date.now() - state.matchupUpdatedAt < 5 * 60 * 1000) return state.matchup;
  const season = footballSeasonYear();
  const data = await fetchJson(`${ESPN_SCHEDULE}?season=${season}`);
  const events = Array.isArray(data.events) ? data.events : [];
  const now = Date.now();
  const candidates = events.map(e => {
    const comp = e.competitions?.[0] || {};
    const teams = comp.competitors || [];
    const rav = normalizeScheduleTeam(teams.find(c => String(c.team?.abbreviation || '').toUpperCase() === 'BAL') || {});
    const opp = normalizeScheduleTeam(teams.find(c => String(c.team?.abbreviation || '').toUpperCase() !== 'BAL') || {});
    const date = new Date(e.date || comp.date || 0).getTime();
    const s = comp.status?.type?.state || e.status?.type?.state || 'pre';
    return { e, comp, rav, opp, date, state: s };
  }).filter(x => x.rav.abbr === 'BAL' && x.opp.abbr);
  let pick = candidates.find(x => x.state === 'in');
  if (!pick) pick = candidates.filter(x => x.date >= now - 3 * 60 * 60 * 1000 && x.state !== 'post').sort((a,b) => a.date - b.date)[0];
  if (!pick) pick = candidates.sort((a,b) => b.date - a.date)[0];
  if (!pick) throw new Error('No Ravens matchup found');
  const weekText = pick.e.week?.text || pick.e.week?.number || pick.e.seasonType?.name || '';
  state.matchup = {
    ravens: { name: 'Ravens', fullName: pick.rav.fullName || 'Baltimore Ravens', abbr: 'BAL', logo: pick.rav.logo || logoFor('BAL') },
    opponent: { name: pick.opp.name, fullName: pick.opp.fullName, abbr: pick.opp.abbr, logo: pick.opp.logo || logoFor(pick.opp.abbr) },
    date: new Date(pick.date).toISOString(),
    week: String(weekText || ''),
  };
  state.matchupUpdatedAt = Date.now();
  broadcast();
  return state.matchup;
}
function voteSummary() {
  const counts = {1:0,2:0,3:0,4:0,5:0};
  for (const v of state.votes.values()) if (counts[v] !== undefined) counts[v]++;
  const total = state.votes.size;
  let avg = 0;
  if (total) {
    let sum = 0;
    for (const [k, n] of Object.entries(counts)) sum += Number(k) * n;
    avg = sum / total;
  }
  const percent = total ? Math.round(((avg - 1) / 4) * 100) : null;
  let topBucket = null;
  if (total) {
    topBucket = Number(Object.entries(counts).sort((a,b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0][0]);
  }
  return { counts, total, average: total ? Number(avg.toFixed(2)) : null, percent, topBucket };
}
function publicState() {
  return {
    connected: state.connected,
    votingOpen: state.votingOpen,
    videoId: state.videoId,
    videoTitle: state.videoTitle,
    liveChatId: state.liveChatId ? 'connected' : '',
    lastError: state.lastError,
    matchup: state.matchup,
    votes: voteSummary(),
    apiKeyConfigured: Boolean(state.apiKey),
    updatedAt: new Date().toISOString(),
  };
}
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
async function ytVideo(videoId) {
  if (!state.apiKey) throw new Error('YouTube API key is not configured');
  const u = `${YT_BASE}/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(state.apiKey)}`;
  const data = await fetchJson(u);
  const item = data.items?.[0];
  if (!item) throw new Error('YouTube video not found');
  return item;
}
async function listChat(pageToken = '') {
  if (!state.liveChatId) throw new Error('No live chat connected');
  const q = new URLSearchParams({ liveChatId: state.liveChatId, part: 'id,snippet,authorDetails', maxResults: '200', key: state.apiKey });
  if (pageToken) q.set('pageToken', pageToken);
  return fetchJson(`${YT_BASE}/liveChat/messages?${q.toString()}`);
}
async function primeCursor() {
  const data = await listChat('');
  state.nextPageToken = data.nextPageToken || '';
  state.pollingIntervalMs = Math.max(2500, Number(data.pollingIntervalMillis || 5000));
}
function processMessages(items = []) {
  if (!state.votingOpen) return;
  let changed = false;
  for (const item of items) {
    const text = String(item.snippet?.displayMessage || item.snippet?.textMessageDetails?.messageText || '').trim();
    const m = text.match(/^!([1-5])$/);
    if (!m) continue;
    const voter = String(item.authorDetails?.channelId || item.authorDetails?.displayName || item.id || '');
    if (!voter) continue;
    const bucket = Number(m[1]);
    if (state.votes.get(voter) !== bucket) {
      state.votes.set(voter, bucket);
      changed = true;
    }
  }
  if (changed) broadcast();
}
async function pollOnce() {
  clearTimeout(state.pollTimer);
  if (!state.connected || !state.liveChatId || !state.apiKey) return;
  try {
    const data = await listChat(state.nextPageToken || '');
    state.nextPageToken = data.nextPageToken || state.nextPageToken;
    state.pollingIntervalMs = Math.max(2500, Number(data.pollingIntervalMillis || state.pollingIntervalMs || 5000));
    state.lastError = '';
    processMessages(data.items || []);
  } catch (e) {
    state.lastError = e.message || 'YouTube polling failed';
    broadcast();
  }
  state.pollTimer = setTimeout(pollOnce, state.pollingIntervalMs);
}
async function connectYouTube(input) {
  const videoId = extractVideoId(input);
  if (!videoId) throw new Error('Paste a valid YouTube live URL or 11-character video ID');
  const item = await ytVideo(videoId);
  const chatId = item.liveStreamingDetails?.activeLiveChatId || '';
  if (!chatId) throw new Error('This video does not currently have an active live chat. Start/go live first, then connect.');
  state.videoId = videoId;
  state.videoTitle = item.snippet?.title || '';
  state.liveChatId = chatId;
  state.connected = true;
  state.votingOpen = false;
  state.lastError = '';
  state.votes.clear();
  await primeCursor();
  broadcast();
  pollOnce();
}
function disconnect() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.connected = false;
  state.votingOpen = false;
  state.videoId = '';
  state.videoTitle = '';
  state.liveChatId = '';
  state.nextPageToken = '';
  broadcast();
}
async function openVoting() {
  if (!state.connected) throw new Error('Connect a YouTube live video first');
  await primeCursor();
  state.votingOpen = true;
  state.lastError = '';
  broadcast();
}
function closeVoting() { state.votingOpen = false; broadcast(); }
function resetVotes() { state.votes.clear(); broadcast(); }
function demoVote(bucket) {
  const b = Number(bucket);
  if (b < 1 || b > 5) throw new Error('Demo vote must be 1-5');
  state.votes.set(`demo-${Date.now()}-${Math.random()}`, b);
  broadcast();
}

async function handleAction(body) {
  const action = body.action;
  if (action === 'setApiKey') {
    state.apiKey = String(body.apiKey || '').trim();
    state.lastError = '';
    broadcast();
    return { ok: true, apiKeyConfigured: Boolean(state.apiKey) };
  }
  if (action === 'connect') { await connectYouTube(body.video || body.videoId || ''); return { ok: true }; }
  if (action === 'disconnect') { disconnect(); return { ok: true }; }
  if (action === 'open') { await openVoting(); return { ok: true }; }
  if (action === 'close') { closeVoting(); return { ok: true }; }
  if (action === 'reset') { resetVotes(); return { ok: true }; }
  if (action === 'demoVote') { demoVote(body.bucket); return { ok: true }; }
  if (action === 'refreshMatchup') { await refreshMatchup(true); return { ok: true }; }
  throw new Error('Unknown control action');
}

async function handle(req, res, url) {
  if (url.pathname === '/confidence') { html(res, 200, CONFIDENCE_HTML); return true; }
  if (url.pathname === '/confidence-control') {
    if (!authorized(url, req)) { html(res, 403, '<h1>Forbidden</h1>'); return true; }
    html(res, 200, CONTROL_HTML); return true;
  }
  if (url.pathname === '/api/confidence-state') {
    try { await refreshMatchup(false); } catch (e) { state.lastError ||= e.message; }
    json(res, 200, publicState(), { 'Access-Control-Allow-Origin': '*' }); return true;
  }
  if (url.pathname === '/api/confidence-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return true;
  }
  if (url.pathname === '/api/confidence-control' && req.method === 'POST') {
    if (!authorized(url, req)) { json(res, 403, { error: 'Forbidden' }); return true; }
    try {
      const body = await readBody(req);
      const result = await handleAction(body);
      json(res, 200, { ...result, state: publicState() });
    } catch (e) {
      state.lastError = e.message || 'Control action failed';
      broadcast();
      json(res, 400, { error: state.lastError, state: publicState() });
    }
    return true;
  }
  return false;
}

refreshMatchup(true).catch(e => { state.lastError = e.message || 'Matchup unavailable'; });
setInterval(() => refreshMatchup(true).catch(() => {}), 10 * 60 * 1000).unref?.();

module.exports = { handle };
