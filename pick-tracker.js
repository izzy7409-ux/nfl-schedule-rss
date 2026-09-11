const fs = require('fs');
const path = require('path');

const TRACKER_HTML = fs.readFileSync(path.join(__dirname, 'pick-tracker.html'), 'utf8');
const CONTROL_HTML = fs.readFileSync(path.join(__dirname, 'pick-tracker-control.html'), 'utf8');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = 2026;
const WEEK1_START = Date.UTC(2026, 8, 9);
const CONTROL_SECRET = process.env.PICK_TRACKER_CONTROL_SECRET || process.env.PICKEM_CONTROL_SECRET || process.env.CONFIDENCE_CONTROL_SECRET || '';
const DATA_DIR = process.env.PICK_TRACKER_DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'prp-season-picks.json');
const REFRESH_MS = 2 * 60 * 1000;
const CACHE_MS = 60 * 1000;

const clients = new Set();
const weekCache = new Map();
let refreshTimer = null;
let loaded = false;
let lastError = '';
let updatedAt = '';
let store = { version: 1, season: SEASON, picks: {} };

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
function authorized(url, req) {
  if (!CONTROL_SECRET) return true;
  return (url.searchParams.get('key') || '') === CONTROL_SECRET || String(req.headers['x-control-key'] || '') === CONTROL_SECRET;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 300000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (Purple Reign Pick Tracker/1.0)', 'Accept':'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,160)}`);
  return JSON.parse(text);
}
function etDayNumber(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const g = t => Number(parts.find(p => p.type === t)?.value);
  return Math.floor(Date.UTC(g('year'), g('month') - 1, g('day')) / 86400000);
}
function currentRegularWeek() {
  const diff = etDayNumber() - Math.floor(WEEK1_START / 86400000);
  return Math.max(1, Math.min(18, Math.floor(diff / 7) + 1));
}
function pickKey(seasonType, week) { return `${Number(seasonType) || 2}-${Number(week) || 1}`; }
function teamLogo(abbr) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr || '').toLowerCase()}.png`; }
function normalizeTeam(c = {}) {
  const t = c.team || {};
  const abbr = String(t.abbreviation || '').toUpperCase();
  return {
    id: String(t.id || c.id || ''), abbr,
    name: t.shortDisplayName || t.name || abbr,
    fullName: t.displayName || t.shortDisplayName || abbr,
    logo: t.logos?.[0]?.href || t.logo || teamLogo(abbr),
    score: Number(c.score ?? 0),
  };
}
function kickoffParts(iso) {
  const d = new Date(iso);
  const tz = { timeZone:'America/New_York' };
  return {
    day: new Intl.DateTimeFormat('en-US',{...tz,weekday:'short'}).format(d).toUpperCase(),
    date: new Intl.DateTimeFormat('en-US',{...tz,month:'short',day:'numeric'}).format(d),
    time: new Intl.DateTimeFormat('en-US',{...tz,hour:'numeric',minute:'2-digit',hour12:true}).format(d),
  };
}
function normalizeGame(event = {}) {
  const comp = event.competitions?.[0] || {};
  const away = normalizeTeam((comp.competitors || []).find(c => c.homeAway === 'away') || {});
  const home = normalizeTeam((comp.competitors || []).find(c => c.homeAway === 'home') || {});
  const status = comp.status || event.status || {};
  const state = status.type?.state || 'pre';
  const isFinal = state === 'post';
  let winner = '';
  let tie = false;
  if (isFinal) {
    if (away.score > home.score) winner = away.abbr;
    else if (home.score > away.score) winner = home.abbr;
    else tie = true;
  }
  return {
    id: String(event.id || comp.id || ''), date: event.date || comp.date || '', kickoff: kickoffParts(event.date || comp.date),
    state, statusText: status.type?.shortDetail || status.type?.description || '', isFinal, winner, tie,
    away, home,
  };
}
async function fetchWeek(seasonType = 2, week = 1, force = false) {
  seasonType = Number(seasonType) || 2; week = Number(week) || 1;
  const key = pickKey(seasonType, week);
  const cached = weekCache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.games;
  const data = await fetchJson(`${ESPN}?limit=100&dates=${SEASON}&seasontype=${seasonType}&week=${week}`);
  const games = (Array.isArray(data.events) ? data.events : []).map(normalizeGame).filter(g => g.id && g.away.abbr && g.home.abbr).sort((a,b) => new Date(a.date)-new Date(b.date));
  weekCache.set(key, { games, at:Date.now() });
  return games;
}
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive:true });
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && parsed.picks && typeof parsed.picks === 'object') store = { version:1, season:SEASON, ...parsed, picks:parsed.picks };
    }
  } catch (e) {
    lastError = `Storage warning: ${e.message}`;
  }
}
function saveStore() {
  ensureLoaded();
  try {
    fs.mkdirSync(DATA_DIR, { recursive:true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    lastError = '';
  } catch (e) {
    lastError = `Could not save picks: ${e.message}`;
    throw e;
  }
}
function weekRecord(seasonType, week) {
  ensureLoaded();
  const key = pickKey(seasonType, week);
  if (!store.picks[key]) store.picks[key] = { seasonType:Number(seasonType)||2, week:Number(week)||1, games:{} };
  if (!store.picks[key].games) store.picks[key].games = {};
  return store.picks[key];
}
function emptyStats() { return { wins:0, losses:0, ties:0, pending:0, totalPicks:0, graded:0, accuracy:null }; }
function gradeHost(record = {}, games = [], host) {
  const stats = emptyStats();
  const gameMap = new Map(games.map(g => [String(g.id), g]));
  for (const [eventId, picks] of Object.entries(record.games || {})) {
    const pick = String(picks?.[host] || '').toUpperCase();
    if (!pick) continue;
    stats.totalPicks++;
    const g = gameMap.get(String(eventId));
    if (!g || !g.isFinal) { stats.pending++; continue; }
    if (g.tie) { stats.ties++; continue; }
    stats.graded++;
    if (pick === g.winner) stats.wins++; else stats.losses++;
  }
  stats.accuracy = stats.graded ? Math.round((stats.wins / stats.graded) * 1000) / 10 : null;
  return stats;
}
function mergeStats(target, add) {
  for (const k of ['wins','losses','ties','pending','totalPicks','graded']) target[k] += Number(add[k] || 0);
  target.accuracy = target.graded ? Math.round((target.wins / target.graded) * 1000) / 10 : null;
}
async function buildState(manageWeek = currentRegularWeek(), force = false) {
  ensureLoaded();
  const records = Object.values(store.picks || {}).filter(r => Number(r.seasonType || 2) === 2).sort((a,b)=>Number(a.week)-Number(b.week));
  const currentWeek = currentRegularWeek();
  const wantedWeeks = [...new Set([...records.map(r=>Number(r.week)), currentWeek, Number(manageWeek)||currentWeek].filter(w=>w>=1&&w<=18))].sort((a,b)=>a-b);
  const weekGames = {};
  for (const w of wantedWeeks) {
    try { weekGames[w] = await fetchWeek(2, w, force && w === currentWeek); }
    catch (e) { weekGames[w] = []; lastError = e.message || 'Unable to load NFL schedule'; }
  }
  const season = { sutton:emptyStats(), alex:emptyStats() };
  const history = [];
  for (const w of wantedWeeks) {
    const rec = store.picks[pickKey(2,w)] || { seasonType:2, week:w, games:{} };
    const ss = gradeHost(rec, weekGames[w] || [], 'sutton');
    const as = gradeHost(rec, weekGames[w] || [], 'alex');
    if (ss.totalPicks || as.totalPicks || w === currentWeek) history.push({ week:w, label:`Week ${w}`, sutton:ss, alex:as });
    mergeStats(season.sutton, ss); mergeStats(season.alex, as);
  }
  const currentRec = store.picks[pickKey(2,currentWeek)] || { seasonType:2, week:currentWeek, games:{} };
  const current = { week:currentWeek, label:`Week ${currentWeek}`, sutton:gradeHost(currentRec, weekGames[currentWeek] || [], 'sutton'), alex:gradeHost(currentRec, weekGames[currentWeek] || [], 'alex') };
  const manageRec = store.picks[pickKey(2,manageWeek)] || { seasonType:2, week:Number(manageWeek)||currentWeek, games:{} };
  const managementGames = (weekGames[manageWeek] || []).map(g => ({
    ...g,
    picks: {
      sutton: String(manageRec.games?.[g.id]?.sutton || ''),
      alex: String(manageRec.games?.[g.id]?.alex || ''),
    }
  }));
  updatedAt = new Date().toISOString();
  return {
    season:SEASON, seasonType:2, currentWeek, currentWeekLabel:`Week ${currentWeek}`,
    seasonStats:season, currentWeekStats:current, history,
    manageWeek:Number(manageWeek)||currentWeek, manageWeekLabel:`Week ${Number(manageWeek)||currentWeek}`, managementGames,
    storage:{ persistentPath:DATA_FILE, persistent:true }, lastError, updatedAt,
  };
}
function broadcast(state = null) {
  Promise.resolve(state || buildState()).then(s => {
    const payload = `data: ${JSON.stringify(s)}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
  }).catch(()=>{});
}
async function controlAction(body = {}) {
  ensureLoaded();
  const action = String(body.action || '');
  if (action === 'setPick') {
    const week = Math.max(1, Math.min(18, Number(body.week) || currentRegularWeek()));
    const eventId = String(body.eventId || '');
    const host = String(body.host || '').toLowerCase();
    const team = String(body.team || '').toUpperCase();
    if (!eventId || !['sutton','alex'].includes(host)) throw new Error('Invalid pick request');
    const games = await fetchWeek(2, week);
    const game = games.find(g => g.id === eventId);
    if (!game) throw new Error('Game not found in that week');
    if (team && ![game.away.abbr, game.home.abbr].includes(team)) throw new Error('Pick must be one of the two teams');
    const rec = weekRecord(2, week);
    if (!rec.games[eventId]) rec.games[eventId] = {};
    if (team) rec.games[eventId][host] = team; else delete rec.games[eventId][host];
    if (!rec.games[eventId].sutton && !rec.games[eventId].alex) delete rec.games[eventId];
    saveStore();
    const s = await buildState(week, true); broadcast(s); return s;
  }
  if (action === 'clearWeek') {
    const week = Math.max(1, Math.min(18, Number(body.week) || currentRegularWeek()));
    delete store.picks[pickKey(2,week)];
    saveStore();
    const s = await buildState(week, true); broadcast(s); return s;
  }
  if (action === 'refresh') {
    weekCache.clear();
    const s = await buildState(Number(body.week)||currentRegularWeek(), true); broadcast(s); return s;
  }
  if (action === 'import') {
    const incoming = body.data;
    if (!incoming || typeof incoming !== 'object' || typeof incoming.picks !== 'object') throw new Error('Invalid backup data');
    store = { version:1, season:SEASON, picks:incoming.picks };
    saveStore();
    const s = await buildState(Number(body.week)||currentRegularWeek(), true); broadcast(s); return s;
  }
  throw new Error('Unknown action');
}
function startTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    weekCache.clear();
    buildState(currentRegularWeek(), true).then(s=>broadcast(s)).catch(()=>{});
  }, REFRESH_MS);
  refreshTimer.unref?.();
}
async function handle(req, res, url) {
  if (!['/pick-tracker','/pick-tracker-control','/api/pick-tracker-state','/api/pick-tracker-stream','/api/pick-tracker-control','/api/pick-tracker-backup'].includes(url.pathname)) return false;
  ensureLoaded(); startTimer();
  if (url.pathname === '/pick-tracker') { html(res, 200, TRACKER_HTML); return true; }
  if (url.pathname === '/pick-tracker-control') {
    if (!authorized(url, req)) { html(res, 403, '<h1>Forbidden</h1>'); return true; }
    html(res, 200, CONTROL_HTML); return true;
  }
  if (url.pathname === '/api/pick-tracker-state') {
    try { json(res, 200, await buildState(Number(url.searchParams.get('week')) || currentRegularWeek())); }
    catch (e) { json(res, 503, { error:e.message || 'Pick tracker unavailable' }); }
    return true;
  }
  if (url.pathname === '/api/pick-tracker-stream') {
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-store', 'Connection':'keep-alive', 'Access-Control-Allow-Origin':'*' });
    res.write(`data: ${JSON.stringify(await buildState())}\n\n`);
    clients.add(res); req.on('close',()=>clients.delete(res)); return true;
  }
  if (url.pathname === '/api/pick-tracker-backup') {
    if (!authorized(url, req)) { json(res, 403, { error:'Forbidden' }); return true; }
    json(res, 200, store, { 'Content-Disposition':'attachment; filename="prp-season-picks-2026.json"' }); return true;
  }
  if (url.pathname === '/api/pick-tracker-control') {
    if (!authorized(url, req)) { json(res, 403, { error:'Forbidden' }); return true; }
    if (req.method !== 'POST') { json(res, 405, { error:'POST required' }); return true; }
    try { const body = await readBody(req); json(res, 200, await controlAction(body)); }
    catch (e) { json(res, 400, { error:e.message || 'Action failed' }); }
    return true;
  }
  return false;
}

module.exports = { handle };
