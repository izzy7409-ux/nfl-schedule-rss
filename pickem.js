const fs = require('fs');
const path = require('path');

const PICKEM_HTML = fs.readFileSync(path.join(__dirname, 'pickem.html'), 'utf8');
const CONTROL_HTML = fs.readFileSync(path.join(__dirname, 'pickem-control.html'), 'utf8');
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = 2026;
const WEEK1_START = Date.UTC(2026, 8, 9);
const CONTROL_SECRET = process.env.PICKEM_CONTROL_SECRET || process.env.CONFIDENCE_CONTROL_SECRET || '';
const REFRESH_MS = 10 * 60 * 1000;
const WEATHER_CACHE_MS = 30 * 60 * 1000;

const clients = new Set();
const weatherCache = new Map();
const state = {
  seasonType: 2,
  week: 1,
  weekLabel: 'Week 1',
  games: [],
  selectedIndex: 0,
  updatedAt: '',
  lastError: '',
  refreshing: false,
};

// Approximate stadium coordinates, sufficient for a small game-day forecast.
const STADIUMS = {
  ARI:[33.5276,-112.2626], ATL:[33.7554,-84.4008], BAL:[39.2780,-76.6227], BUF:[42.7738,-78.7868],
  CAR:[35.2258,-80.8528], CHI:[41.8623,-87.6167], CIN:[39.0955,-84.5161], CLE:[41.5061,-81.6995],
  DAL:[32.7473,-97.0945], DEN:[39.7439,-105.0201], DET:[42.3400,-83.0456], GB:[44.5013,-88.0622],
  HOU:[29.6847,-95.4107], IND:[39.7601,-86.1639], JAX:[30.3239,-81.6373], KC:[39.0489,-94.4839],
  LV:[36.0908,-115.1830], LAC:[33.9535,-118.3392], LAR:[33.9535,-118.3392], MIA:[25.9580,-80.2389],
  MIN:[44.9736,-93.2575], NE:[42.0909,-71.2643], NO:[29.9511,-90.0812], NYG:[40.8135,-74.0745],
  NYJ:[40.8135,-74.0745], PHI:[39.9008,-75.1675], PIT:[40.4468,-80.0158], SEA:[47.5952,-122.3316],
  SF:[37.4030,-121.9700], TB:[27.9759,-82.5033], TEN:[36.1665,-86.7713], WAS:[38.9076,-76.8645]
};

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
    req.on('data', c => { data += c; if (data.length > 100000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (Purple Reign Pickem/1.0)', 'Accept':'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,180)}`);
  return JSON.parse(text);
}
function etDayNumber(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const g = t => Number(parts.find(p => p.type === t)?.value);
  return Math.floor(Date.UTC(g('year'), g('month') - 1, g('day')) / 86400000);
}
function regularWeek() {
  const diff = etDayNumber() - Math.floor(WEEK1_START / 86400000);
  return Math.floor(diff / 7) + 1;
}
function teamLogo(abbr) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr || '').toLowerCase()}.png`; }
function normalizeTeam(c = {}) {
  const t = c.team || {};
  const abbr = String(t.abbreviation || '').toUpperCase();
  return {
    id: String(t.id || c.id || ''),
    abbr,
    name: t.shortDisplayName || t.name || abbr,
    fullName: t.displayName || t.shortDisplayName || abbr,
    logo: t.logos?.[0]?.href || t.logo || teamLogo(abbr),
    record: c.records?.[0]?.summary || c.record?.[0]?.summary || '',
    score: c.score ?? '0',
    homeAway: c.homeAway || ''
  };
}
function networks(comp = {}) {
  const out = [];
  for (const b of comp.broadcasts || []) for (const n of b.names || []) out.push(n);
  for (const g of comp.geoBroadcasts || []) {
    const n = g.media?.shortName || g.media?.name;
    if (n) out.push(n);
  }
  return [...new Set(out)].join(' / ');
}
function kickoffParts(iso) {
  const d = new Date(iso);
  const opts = { timeZone:'America/New_York' };
  return {
    day: new Intl.DateTimeFormat('en-US',{...opts,weekday:'short'}).format(d).toUpperCase(),
    date: new Intl.DateTimeFormat('en-US',{...opts,month:'short',day:'numeric'}).format(d),
    time: new Intl.DateTimeFormat('en-US',{...opts,hour:'numeric',minute:'2-digit',hour12:true}).format(d),
  };
}
function spreadInfo(comp = {}) {
  const odds = Array.isArray(comp.odds) ? comp.odds : [];
  const pick = odds.find(o => o?.details) || odds[0] || {};
  const details = String(pick.details || '').trim();
  return {
    text: details || 'Line pending',
    provider: pick.provider?.name || pick.provider?.displayName || '',
    overUnder: pick.overUnder ?? null,
  };
}
function weatherFromEspn(comp = {}, event = {}) {
  const w = comp.weather || event.weather || {};
  const display = String(w.displayValue || '').trim();
  const temp = Number.isFinite(Number(w.temperature)) ? `${Math.round(Number(w.temperature))}°` : '';
  const wind = Number.isFinite(Number(w.windSpeed)) ? `Wind ${Math.round(Number(w.windSpeed))} mph` : '';
  const text = [temp, display && !display.includes(temp) ? display : '', wind].filter(Boolean).join(' · ');
  return text || '';
}
function weatherCode(code) {
  code = Number(code);
  if (code === 0) return 'Clear';
  if ([1,2].includes(code)) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if ([45,48].includes(code)) return 'Fog';
  if ([51,53,55,56,57].includes(code)) return 'Drizzle';
  if ([61,63,65,66,67,80,81,82].includes(code)) return 'Rain';
  if ([71,73,75,77,85,86].includes(code)) return 'Snow';
  if ([95,96,99].includes(code)) return 'Storms';
  return 'Forecast';
}
function buildGame(event = {}) {
  const comp = event.competitions?.[0] || {};
  const away = normalizeTeam((comp.competitors || []).find(c => c.homeAway === 'away') || {});
  const home = normalizeTeam((comp.competitors || []).find(c => c.homeAway === 'home') || {});
  const venue = comp.venue || {};
  const indoor = venue.indoor === true;
  const status = comp.status || event.status || {};
  const odds = spreadInfo(comp);
  const kp = kickoffParts(event.date || comp.date);
  const espnWeather = weatherFromEspn(comp, event);
  let statusText = status.type?.shortDetail || status.type?.description || '';
  const phase = status.type?.state || 'pre';
  if (phase === 'pre') statusText = `${kp.day} · ${kp.time} ET`;
  const city = [venue.address?.city, venue.address?.state].filter(Boolean).join(', ');
  return {
    id: String(event.id || comp.id || ''),
    date: event.date || comp.date || '',
    kickoff: kp,
    phase,
    statusText,
    away,
    home,
    network: networks(comp),
    venue: venue.fullName || '',
    city,
    indoor,
    spread: odds,
    weather: indoor ? 'Indoors' : (espnWeather || 'Forecast pending'),
    weatherSource: indoor ? 'venue' : (espnWeather ? 'ESPN' : ''),
  };
}
async function fetchSlate() {
  const rw = regularWeek();
  let data;
  let seasonType = 2;
  let week = Math.max(1, Math.min(18, rw));
  if (rw >= 1 && rw <= 18) {
    data = await fetchJson(`${ESPN}?limit=100&dates=${SEASON}&seasontype=2&week=${week}`);
  } else {
    data = await fetchJson(`${ESPN}?limit=100`);
    seasonType = Number(data.season?.type || 3);
    week = Number(data.week?.number || 1);
  }
  const events = Array.isArray(data.events) ? data.events : [];
  if (!events.length) throw new Error('No NFL games found for the active week');
  let weekLabel = seasonType === 2 ? `Week ${week}` : `Playoffs · Week ${week}`;
  const games = events.map(buildGame).filter(g => g.away.abbr && g.home.abbr).sort((a,b) => new Date(a.date) - new Date(b.date));
  if (!games.length) throw new Error('NFL slate could not be parsed');
  return { seasonType, week, weekLabel, games };
}
async function fetchWeather(game) {
  if (!game || game.indoor) return game?.weather || 'Indoors';
  const cache = weatherCache.get(game.id);
  if (cache && Date.now() - cache.at < WEATHER_CACHE_MS) return cache.text;
  const coord = STADIUMS[game.home.abbr];
  if (!coord || !game.date) return game.weather || 'Forecast pending';
  const kickoff = new Date(game.date).getTime();
  if (!Number.isFinite(kickoff) || kickoff - Date.now() > 16 * 86400000) return 'Forecast pending';
  try {
    const [lat, lon] = coord;
    const q = new URLSearchParams({
      latitude:String(lat), longitude:String(lon),
      hourly:'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
      temperature_unit:'fahrenheit', wind_speed_unit:'mph', timezone:'UTC', forecast_days:'16'
    });
    const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?${q}`);
    const times = d.hourly?.time || [];
    if (!times.length) return 'Forecast pending';
    let idx = 0, best = Infinity;
    for (let i=0;i<times.length;i++) {
      const diff = Math.abs(new Date(`${times[i]}Z`).getTime() - kickoff);
      if (diff < best) { best = diff; idx = i; }
    }
    const temp = Math.round(Number(d.hourly.temperature_2m?.[idx]));
    const rain = Math.round(Number(d.hourly.precipitation_probability?.[idx]));
    const wind = Math.round(Number(d.hourly.wind_speed_10m?.[idx]));
    const condition = weatherCode(d.hourly.weather_code?.[idx]);
    const parts = [];
    if (Number.isFinite(temp)) parts.push(`${temp}°`);
    parts.push(condition);
    if (Number.isFinite(rain)) parts.push(`${rain}% rain`);
    if (Number.isFinite(wind) && wind >= 5) parts.push(`${wind} mph wind`);
    const text = parts.join(' · ') || 'Forecast pending';
    weatherCache.set(game.id, { text, at:Date.now() });
    return text;
  } catch {
    return game.weather || 'Forecast pending';
  }
}
async function ensureWeather(index = state.selectedIndex) {
  const game = state.games[index];
  if (!game || game.indoor || game.weatherSource === 'ESPN') return;
  const text = await fetchWeather(game);
  if (text && game.weather !== text) {
    game.weather = text;
    game.weatherSource = text === 'Forecast pending' ? '' : 'forecast';
    broadcast();
  }
}
async function warmWeather() {
  for (let i=0;i<state.games.length;i++) {
    if (i === state.selectedIndex) continue;
    await ensureWeather(i);
  }
}
async function refreshSlate(force = false) {
  if (state.refreshing) return;
  if (!force && state.updatedAt && Date.now() - new Date(state.updatedAt).getTime() < REFRESH_MS) return;
  state.refreshing = true;
  try {
    const oldId = state.games[state.selectedIndex]?.id || '';
    const next = await fetchSlate();
    state.seasonType = next.seasonType;
    state.week = next.week;
    state.weekLabel = next.weekLabel;
    state.games = next.games;
    const same = oldId ? state.games.findIndex(g => g.id === oldId) : -1;
    state.selectedIndex = same >= 0 ? same : 0;
    state.updatedAt = new Date().toISOString();
    state.lastError = '';
    await ensureWeather(state.selectedIndex);
    broadcast();
    warmWeather().catch(()=>{});
  } catch (e) {
    state.lastError = e.message || 'Unable to refresh NFL slate';
    broadcast();
  } finally {
    state.refreshing = false;
  }
}
function liteGame(g, i) {
  return { id:g.id, index:i, away:g.away.abbr, home:g.home.abbr, kickoff:g.kickoff, date:g.date };
}
function publicState() {
  const game = state.games[state.selectedIndex] || null;
  return {
    seasonType: state.seasonType,
    week: state.week,
    weekLabel: state.weekLabel,
    selectedIndex: state.selectedIndex,
    totalGames: state.games.length,
    game,
    games: state.games.map(liteGame),
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    refreshing: state.refreshing,
  };
}
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
}
async function selectIndex(index) {
  if (!state.games.length) await refreshSlate(true);
  if (!state.games.length) return;
  const n = state.games.length;
  state.selectedIndex = ((Number(index) % n) + n) % n;
  await ensureWeather(state.selectedIndex);
  broadcast();
}
async function action(body = {}) {
  const a = body.action;
  if (a === 'next') { await selectIndex(state.selectedIndex + 1); return; }
  if (a === 'prev') { await selectIndex(state.selectedIndex - 1); return; }
  if (a === 'first') { await selectIndex(0); return; }
  if (a === 'last') { await selectIndex(state.games.length - 1); return; }
  if (a === 'setIndex') { await selectIndex(Number(body.index || 0)); return; }
  if (a === 'refresh') { state.updatedAt=''; await refreshSlate(true); return; }
  throw new Error('Unknown Pick’em control action');
}
async function handle(req, res, url) {
  if (url.pathname === '/pickem' || url.pathname === '/pick-em') { html(res,200,PICKEM_HTML); return true; }
  if (url.pathname === '/pickem-control') {
    if (!authorized(url,req)) { html(res,403,'<h1>Forbidden</h1>'); return true; }
    html(res,200,CONTROL_HTML); return true;
  }
  if (url.pathname === '/api/pickem-state') {
    await refreshSlate(false);
    json(res,200,publicState(),{'Access-Control-Allow-Origin':'*'}); return true;
  }
  if (url.pathname === '/api/pickem-stream') {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res); req.on('close',()=>clients.delete(res)); return true;
  }
  if (url.pathname === '/api/pickem-control' && req.method === 'POST') {
    if (!authorized(url,req)) { json(res,403,{error:'Forbidden'}); return true; }
    try { const body=await readBody(req); await action(body); json(res,200,{ok:true,state:publicState()}); }
    catch(e){ json(res,400,{error:e.message||'Pick’em control failed',state:publicState()}); }
    return true;
  }
  return false;
}

refreshSlate(true).catch(()=>{});
setInterval(()=>refreshSlate(true).catch(()=>{}), REFRESH_MS).unref?.();

module.exports = { handle };
