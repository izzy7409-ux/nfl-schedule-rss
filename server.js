const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const SEASON = 2026;
const WEEK1 = Date.UTC(2026, 8, 9);
const RAVENS = 'BAL';
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';

const abbr = c => String(c?.team?.abbreviation || '').toUpperCase();
const team = c => ({
  id: String(c?.id || c?.team?.id || ''),
  name: c?.team?.displayName || '',
  short: c?.team?.shortDisplayName || c?.team?.displayName || '',
  abbr: abbr(c),
  score: Number(c?.score ?? 0),
  record: c?.records?.[0]?.summary || '',
  logo: c?.team?.logos?.[0]?.href || '',
  homeAway: c?.homeAway || ''
});

function etDay(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const g = t => Number(p.find(x => x.type === t)?.value);
  return Math.floor(Date.UTC(g('year'), g('month') - 1, g('day')) / 86400000);
}
function currentWeek() {
  return Math.max(1, Math.min(18, Math.floor((etDay() - Math.floor(WEEK1 / 86400000)) / 7) + 1));
}
async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Purple-Reign-Halftime-Review/1.0)',
      'Accept': 'application/json'
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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
function kickoff(iso) {
  const d = new Date(iso), tz = { timeZone: 'America/New_York' };
  return new Intl.DateTimeFormat('en-US', {
    ...tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d);
}
async function weekEvents(week) {
  const data = await getJson(`${SCOREBOARD}?limit=100&dates=${SEASON}&seasontype=2&week=${week}`);
  return Array.isArray(data?.events) ? data.events : [];
}
function isRavensEvent(e = {}) {
  return (e?.competitions?.[0]?.competitors || []).some(c => abbr(c) === RAVENS);
}
async function findRavensGame(events, week) {
  const direct = (events || []).find(isRavensEvent);
  if (direct) return { week, event: direct };

  const cur = currentWeek();
  const weeks = [...new Set([cur, cur + 1, cur - 1, cur + 2, cur - 2].filter(w => w >= 1 && w <= 18))];
  const found = [];
  for (const w of weeks) {
    try {
      const ev = (await weekEvents(w)).find(isRavensEvent);
      if (ev) found.push({ week: w, event: ev });
    } catch {}
  }
  if (!found.length) throw new Error('No Ravens game found in nearby regular-season weeks.');
  found.sort((a, b) => {
    const rank = x => {
      const comp = x.event?.competitions?.[0] || {};
      const state = comp?.status?.type?.state || 'pre';
      const when = new Date(x.event?.date || 0).getTime();
      return [state === 'in' ? 0 : state === 'pre' ? 1 : 2, Math.abs(x.week - cur), Math.abs(Date.now() - when)];
    };
    const A = rank(a), B = rank(b);
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return 0;
  });
  return found[0];
}
function possessionCompetitor(situation = {}, competitors = []) {
  const p = String(situation?.possession || '');
  return competitors.find(c => String(c.id || c.team?.id || '') === p || abbr(c) === p) || null;
}
function parseSpot(text = '', rav = 'BAL', opp = 'OPP') {
  const m = String(text).match(/at\s+([A-Z]{2,3})\s+(\d{1,2})$/i);
  if (!m) return { label: '', pct: null };
  const side = m[1].toUpperCase(), yard = Number(m[2]);
  return { label: `${side} ${yard}`, pct: side === rav ? yard : side === opp ? 100 - yard : null };
}
function normalizePlay(play = {}, rav, opp) {
  const text = play?.text || play?.headline || play?.shortText || '';
  const clock = String(play?.clock?.displayValue || play?.displayClock || '');
  const period = play?.period?.number || play?.period || '';
  const homeScore = play?.homeScore ?? play?.homeScoreValue;
  const awayScore = play?.awayScore ?? play?.awayScoreValue;
  let scoreLine = '';
  if (rav && opp && homeScore !== undefined && awayScore !== undefined) {
    const rs = rav.homeAway === 'home' ? homeScore : awayScore;
    const os = rav.homeAway === 'home' ? awayScore : homeScore;
    scoreLine = `${rav.abbr} ${rs} - ${opp.abbr} ${os}`;
  }
  return { text, clock, period: period ? `Q${period}` : '', scoreLine };
}
function statMap(summary, teamId) {
  const rows = summary?.boxscore?.teams || [];
  const row = rows.find(r => String(r?.team?.id || '') === String(teamId)) || {};
  const map = {};
  for (const s of row.statistics || []) {
    const keys = [s.name, s.label, s.abbreviation].filter(Boolean).map(x => String(x).toLowerCase());
    for (const k of keys) map[k] = s.displayValue ?? s.value ?? '';
  }
  return map;
}
function pickStat(map, keys, fallback = '--') {
  for (const key of keys) {
    const direct = map[String(key).toLowerCase()];
    if (direct !== undefined && direct !== '') return String(direct);
  }
  return fallback;
}
function buildTeamStats(summary, rav, opp) {
  const r = statMap(summary, rav.id);
  const o = statMap(summary, opp.id);
  const spec = [
    ['Total Yards', ['totalYards','total yards']],
    ['Passing Yards', ['netPassingYards','passingYards','passing yards','net passing yards']],
    ['Rushing Yards', ['rushingYards','rushing yards']],
    ['First Downs', ['firstDowns','1st downs','first downs']],
    ['3rd Down', ['thirdDownEff','3rd down efficiency','third down efficiency']],
    ['Turnovers', ['turnovers','turnovers lost']],
    ['Time of Possession', ['possessionTime','time of possession']],
    ['Penalties', ['totalPenaltiesYards','penalties','penalties-yards']]
  ];
  return spec.map(([label, keys]) => ({ label, ravens: pickStat(r, keys), opponent: pickStat(o, keys) }));
}
function extractPlayerLeaders(summary, ravensId) {
  const players = summary?.boxscore?.players || [];
  const ravensRow = players.find(p => String(p?.team?.id || '') === String(ravensId)) || {};
  const categories = Array.isArray(ravensRow.statistics) ? ravensRow.statistics : [];
  const wanted = [
    { key: 'passing', label: 'Passing' },
    { key: 'rushing', label: 'Rushing' },
    { key: 'receiving', label: 'Receiving' }
  ];
  return wanted.map(w => {
    const cat = categories.find(c => String(c?.name || c?.label || '').toLowerCase().includes(w.key));
    const athlete = cat?.athletes?.[0] || null;
    if (!athlete) return { label: w.label, name: '--', value: '--' };
    const name = athlete?.athlete?.shortName || athlete?.athlete?.displayName || '--';
    const stats = Array.isArray(athlete?.stats) ? athlete.stats : [];
    return { label: w.label, name, value: stats.filter(Boolean).slice(0, 3).join(' · ') || '--' };
  });
}
function buildRavensState(summary, ctx) {
  const event = ctx.event || {};
  const baseComp = event.competitions?.[0] || {};
  const comp = summary?.header?.competitions?.[0] || baseComp;
  const competitors = comp.competitors || baseComp.competitors || [];
  const rav = team(competitors.find(c => abbr(c) === RAVENS) || {});
  const opp = team(competitors.find(c => abbr(c) !== RAVENS) || {});
  if (!rav.abbr || !opp.abbr) throw new Error('Could not load Ravens matchup data.');

  const status = comp.status || baseComp.status || {};
  const state = status?.type?.state || 'pre';
  const situation = comp.situation || summary?.situation || baseComp.situation || {};
  const poss = possessionCompetitor(situation, competitors);
  const down = situation?.downDistanceText || situation?.shortDownDistanceText || '';
  const field = parseSpot(down, rav.abbr, opp.abbr);
  const curDrive = summary?.drives?.current || null;
  const drivePlays = Array.isArray(curDrive?.plays) ? curDrive.plays : [];
  const plays = Array.isArray(summary?.plays) ? summary.plays : [];
  const recentSource = drivePlays.length ? drivePlays.slice(-6) : plays.slice(-6);
  const recent = [...recentSource].reverse().map(p => normalizePlay(p, rav, opp)).filter(p => p.text);
  const last = normalizePlay(situation?.lastPlay || drivePlays[drivePlays.length - 1] || plays[plays.length - 1] || {}, rav, opp);
  const scoring = (Array.isArray(summary?.scoringPlays) ? summary.scoringPlays : []).slice(-6).reverse().map(p => normalizePlay(p, rav, opp)).filter(p => p.text);

  let statusText = status?.type?.shortDetail || status?.type?.description || 'Pregame';
  if (state === 'pre') statusText = `${kickoff(comp.date || event.date)} ET`;
  else if (state === 'post' && !/final/i.test(statusText)) statusText = `FINAL | ${statusText}`;

  return {
    updatedAt: new Date().toISOString(),
    week: ctx.week,
    weekLabel: `Week ${ctx.week}`,
    gameId: String(event.id || ''),
    state,
    statusText,
    period: Number(status?.period || 0),
    clock: status?.displayClock || '',
    network: networks(comp),
    stadium: comp.venue?.fullName || baseComp.venue?.fullName || '',
    ravens: rav,
    opponent: opp,
    ravensScore: rav.score,
    opponentScore: opp.score,
    possession: poss ? team(poss).abbr : '',
    redZone: Boolean(situation?.isRedZone),
    downDistanceText: down,
    fieldPositionLabel: field.label,
    fieldMarkerPct: field.pct,
    driveResult: curDrive?.displayResult || curDrive?.result || curDrive?.description || '',
    lastPlay: last,
    recentPlays: recent,
    scoringPlays: scoring,
    timeouts: {
      ravens: rav.homeAway === 'home' ? situation?.homeTimeouts : situation?.awayTimeouts,
      opponent: rav.homeAway === 'home' ? situation?.awayTimeouts : situation?.homeTimeouts
    },
    teamStats: summary ? buildTeamStats(summary, rav, opp) : [],
    playerLeaders: summary ? extractPlayerLeaders(summary, rav.id) : [],
    dataMode: summary ? 'play-by-play' : 'scoreboard-fallback'
  };
}
function leagueGame(event = {}) {
  const comp = event.competitions?.[0] || {};
  const away = team((comp.competitors || []).find(c => c.homeAway === 'away') || {});
  const home = team((comp.competitors || []).find(c => c.homeAway === 'home') || {});
  const status = comp.status || event.status || {};
  const state = status?.type?.state || 'pre';
  let detail = status?.type?.shortDetail || status?.type?.description || '';
  if (state === 'pre') detail = `${kickoff(comp.date || event.date)} ET`;
  else if (state === 'post' && !/final/i.test(detail)) detail = `FINAL | ${detail}`;
  return {
    id: String(event.id || ''),
    away,
    home,
    state,
    statusText: detail,
    period: Number(status?.period || 0),
    clock: status?.displayClock || '',
    network: networks(comp)
  };
}
async function loadRavensState() {
  const week = currentWeek();
  const events = await weekEvents(week);
  const ctx = await findRavensGame(events, week);
  let summary = null;
  try { summary = await getJson(`${SUMMARY}?event=${ctx.event.id}`); } catch {}
  return buildRavensState(summary, ctx);
}

async function loadHalftimeState() {
  const week = currentWeek();
  const events = await weekEvents(week);
  const ctx = await findRavensGame(events, week);
  let summary = null;
  try { summary = await getJson(`${SUMMARY}?event=${ctx.event.id}`); } catch {}
  const ravens = buildRavensState(summary, ctx);
  const league = events.filter(e => String(e.id) !== String(ctx.event.id)).map(leagueGame);
  return { updatedAt: new Date().toISOString(), ravens, league };
}

function homePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>PRP Live Tools</title><style>body{margin:0;padding:32px;background:#0d0918;color:#fff;font-family:Inter,Arial,sans-serif}a{color:#cab4ff}.card{max-width:840px;margin:0 auto;background:#18122a;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:24px}code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px}</style></head><body><div class="card"><h1>PRP Live Tools</h1><p>Separate EVMux browser-source routes.</p><ul><li><a href="/ravens">Ravens tracker</a></li><li><a href="/halftime">Halftime review</a></li><li><a href="/api/ravens-state">Ravens data</a></li><li><a href="/api/halftime-state">Halftime data</a></li><li><a href="/health">Health check</a></li></ul></div></body></html>`;
}

const RAVENS_OVERLAY = fs.readFileSync(path.join(__dirname, 'overlay.html'), 'utf8');
const HALFTIME_OVERLAY = fs.readFileSync(path.join(__dirname, 'halftime.html'), 'utf8');
const LOGO = fs.existsSync(path.join(__dirname, 'prp-logo.svg')) ? fs.readFileSync(path.join(__dirname, 'prp-logo.svg')) : null;
function send(res, code, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...headers });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, homePage(), 'text/html; charset=utf-8');
  if (url.pathname === '/health') return send(res, 200, 'Purple Reign live tools are running');
  if (url.pathname === '/ravens') return send(res, 200, RAVENS_OVERLAY, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
  if (url.pathname === '/halftime') return send(res, 200, HALFTIME_OVERLAY, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
  if (url.pathname === '/prp-logo.svg' && LOGO) return send(res, 200, LOGO, 'image/svg+xml; charset=utf-8', { 'Cache-Control':'public, max-age=86400' });
  if (url.pathname === '/api/ravens-state') {
    try {
      return send(res, 200, JSON.stringify(await loadRavensState()), 'application/json; charset=utf-8', {
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
      });
    } catch (e) {
      return send(res, 503, JSON.stringify({ error: e.message || 'Tracker unavailable' }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
  }
  if (url.pathname === '/api/halftime-state') {
    try {
      return send(res, 200, JSON.stringify(await loadHalftimeState()), 'application/json; charset=utf-8', {
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
      });
    } catch (e) {
      return send(res, 503, JSON.stringify({ error: e.message || 'Halftime review unavailable' }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
  }
  return send(res, 404, 'Not found');
});
server.listen(PORT, '0.0.0.0', () => console.log(`Purple Reign live tools listening on port ${PORT}`));
