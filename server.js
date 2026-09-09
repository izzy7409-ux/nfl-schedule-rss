const http = require('http');

const PORT = process.env.PORT || 3000;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = 2026;
const WEEK1_START = Date.UTC(2026, 8, 9);

function esc(s='') {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
}

function etDayNumber(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
}

function currentWeek() {
  const start = Math.floor(WEEK1_START / 86400000);
  const diff = etDayNumber() - start;
  return Math.max(1, Math.min(18, Math.floor(diff / 7) + 1));
}

function team(comp, side) {
  const c = (comp.competitors || []).find(x => x.homeAway === side) || {};
  return {
    name: c.team?.displayName || c.team?.shortDisplayName || side.toUpperCase(),
    score: c.score ?? '0'
  };
}

function networks(comp) {
  const out = [];
  for (const b of comp.broadcasts || []) for (const n of b.names || []) out.push(n);
  for (const g of comp.geoBroadcasts || []) {
    const n = g.media?.shortName || g.media?.name;
    if (n) out.push(n);
  }
  return [...new Set(out)].join(' / ');
}

function kickoff(iso) {
  const d = new Date(iso);
  const tz = { timeZone: 'America/New_York' };
  const day = new Intl.DateTimeFormat('en-US', {...tz, weekday:'short'}).format(d).toUpperCase();
  const mon = new Intl.DateTimeFormat('en-US', {...tz, month:'short'}).format(d).toUpperCase();
  const date = new Intl.DateTimeFormat('en-US', {...tz, day:'numeric'}).format(d);
  const time = new Intl.DateTimeFormat('en-US', {...tz, hour:'numeric', minute:'2-digit', hour12:true}).format(d);
  return {day, mon, date, time};
}

function gameText(event) {
  const comp = event.competitions?.[0] || {};
  const away = team(comp, 'away');
  const home = team(comp, 'home');
  const status = comp.status || event.status || {};
  const state = status.type?.state || 'pre';
  const net = networks(comp);
  const netSuffix = net ? ` | ${net}` : '';

  if (state === 'in') {
    let phase = status.type?.shortDetail || '';
    const period = Number(status.period || 0);
    const clock = status.displayClock || '';
    if ((period === 2 && clock === '0:00') || /halftime/i.test(phase)) phase = 'HALFTIME';
    else if (!phase) phase = period ? `Q${period}${clock ? ` ${clock}` : ''}` : 'LIVE';
    return {
      state,
      key: `live-${away.score}-${home.score}-${period}-${clock || phase}`,
      title: `LIVE | ${away.name} ${away.score} - ${home.name} ${home.score} | ${phase}${netSuffix}`,
      description: `${away.name} ${away.score}, ${home.name} ${home.score}. ${phase}.`
    };
  }

  if (state === 'post') {
    const detail = /final/i.test(status.type?.shortDetail || '') ? String(status.type.shortDetail).toUpperCase() : 'FINAL';
    return {
      state,
      key: `final-${away.score}-${home.score}`,
      title: `${detail} | ${away.name} ${away.score} - ${home.name} ${home.score}`,
      description: `Final: ${away.name} ${away.score}, ${home.name} ${home.score}.`
    };
  }

  const k = kickoff(event.date);
  return {
    state,
    key: `pregame-${event.date}`,
    title: `${k.day} ${k.mon} ${k.date} | ${away.name} at ${home.name} | ${k.time} ET${netSuffix}`,
    description: `${away.name} at ${home.name}. Kickoff ${k.time} ET.${net ? ` TV: ${net}.` : ''}`
  };
}

function buildFeed(events, week) {
  const buildDate = new Date().toUTCString();
  const items = [...events].sort((a,b) => new Date(a.date) - new Date(b.date)).map(event => {
    const text = gameText(event);
    const link = event.links?.find(l => l.href)?.href || `https://www.espn.com/nfl/game/_/gameId/${event.id || ''}`;
    const eventId = event.id || 'unknown';
    return `    <item>\n      <title>${esc(text.title)}</title>\n      <link>${esc(link)}</link>\n      <description>${esc(text.description)}</description>\n      <pubDate>${buildDate}</pubDate>\n      <guid isPermaLink="false">espn-nfl-${esc(eventId)}-${esc(text.key)}</guid>\n    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>2026 NFL Week ${week} Live Schedule &amp; Scores</title>\n    <link>https://www.nfl.com/schedules/</link>\n    <description>Live NFL schedule, scores and final results for EVMux.</description>\n    <language>en-us</language>\n    <pubDate>${buildDate}</pubDate>\n    <lastBuildDate>${buildDate}</lastBuildDate>\n    <generator>Purple Reign NFL Live RSS</generator>\n    <ttl>1</ttl>\n${items}\n  </channel>\n</rss>\n`;
}

async function loadFeed() {
  const week = currentWeek();
  const url = `${ESPN}?limit=100&dates=${SEASON}&seasontype=2&week=${week}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PRP-NFL-RSS/1.0)',
      'Accept': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Scoreboard HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.events) || !data.events.length) throw new Error(`No games found for Week ${week}`);
  return buildFeed(data.events, week);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, {
      'Content-Type':'text/plain; charset=utf-8',
      'Cache-Control':'no-store'
    });
    res.end('NFL RSS service is running');
    return;
  }

  if (req.url === '/feed.xml' || req.url === '/rss' || req.url === '/feed') {
    try {
      const xml = await loadFeed();
      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(xml);
    } catch (err) {
      res.writeHead(503, {
        'Content-Type':'application/rss+xml; charset=utf-8',
        'Cache-Control':'no-store'
      });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NFL Live Feed</title><link>https://www.nfl.com/schedules/</link><description>${esc(err.message || 'Feed unavailable')}</description></channel></rss>`);
    }
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NFL RSS service listening on port ${PORT}`);
});
