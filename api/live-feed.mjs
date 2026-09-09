const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SEASON = 2026;
const REGULAR_SEASON_TYPE = 2;
const WEEK_1_START_ET = { year: 2026, month: 9, day: 9 };

function xmlEscape(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function easternDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dayNumber({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function currentWeek(date = new Date()) {
  const today = easternDateParts(date);
  const diff = dayNumber(today) - dayNumber(WEEK_1_START_ET);
  return Math.min(18, Math.max(1, Math.floor(diff / 7) + 1));
}

async function getJson(url, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PRP-NFL-RSS/1.0)',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`Scoreboard HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (i === 0) await new Promise(r => setTimeout(r, 250));
    }
  }
  throw lastError;
}

function networkFor(competition) {
  const names = [];
  for (const broadcast of competition?.broadcasts || []) {
    for (const name of broadcast?.names || []) names.push(name);
  }
  for (const geo of competition?.geoBroadcasts || []) {
    const name = geo?.media?.shortName || geo?.media?.name;
    if (name) names.push(name);
  }
  return [...new Set(names)].join(' / ');
}

function kickoffParts(isoDate) {
  const date = new Date(isoDate);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short'
  }).format(date).toUpperCase();
  const month = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short'
  }).format(date).toUpperCase();
  const dateNum = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', day: 'numeric'
  }).format(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date).replace(/\s/g, ' ');
  return { day, month, dateNum, time };
}

function teamInfo(competition, side) {
  const competitor = (competition?.competitors || []).find(c => c.homeAway === side);
  return {
    name: competitor?.team?.displayName || competitor?.team?.shortDisplayName || side.toUpperCase(),
    abbr: competitor?.team?.abbreviation || '',
    score: competitor?.score ?? '0',
    winner: Boolean(competitor?.winner)
  };
}

function gameTitle(event) {
  const competition = event?.competitions?.[0] || {};
  const away = teamInfo(competition, 'away');
  const home = teamInfo(competition, 'home');
  const status = competition?.status || event?.status || {};
  const state = status?.type?.state || 'pre';
  const network = networkFor(competition);
  const networkSuffix = network ? ` | ${network}` : '';

  if (state === 'in') {
    const period = Number(status?.period || 0);
    const clock = status?.displayClock || '';
    const detail = status?.type?.shortDetail || '';
    let phase = detail;
    if (period === 2 && (clock === '0:00' || /halftime/i.test(detail))) phase = 'HALFTIME';
    else if (!phase && period) phase = `Q${period}${clock ? ` ${clock}` : ''}`;
    return `LIVE | ${away.name} ${away.score} - ${home.name} ${home.score} | ${phase}${networkSuffix}`;
  }

  if (state === 'post') {
    const detail = status?.type?.shortDetail || 'FINAL';
    const finalLabel = /final/i.test(detail) ? detail.toUpperCase() : 'FINAL';
    return `${finalLabel} | ${away.name} ${away.score} - ${home.name} ${home.score}`;
  }

  const kickoff = kickoffParts(event?.date);
  return `${kickoff.day} ${kickoff.month} ${kickoff.dateNum} | ${away.name} at ${home.name} | ${kickoff.time} ET${networkSuffix}`;
}

function gameDescription(event, week) {
  const competition = event?.competitions?.[0] || {};
  const away = teamInfo(competition, 'away');
  const home = teamInfo(competition, 'home');
  const status = competition?.status || event?.status || {};
  const state = status?.type?.state || 'pre';
  const network = networkFor(competition);
  if (state === 'in') {
    return `2026 NFL Week ${week}. ${away.name} ${away.score}, ${home.name} ${home.score}. ${status?.type?.shortDetail || 'Game in progress'}.${network ? ` TV: ${network}.` : ''}`;
  }
  if (state === 'post') {
    return `2026 NFL Week ${week} final. ${away.name} ${away.score}, ${home.name} ${home.score}.`;
  }
  const kickoff = kickoffParts(event?.date);
  return `2026 NFL Week ${week}. ${away.name} at ${home.name}. Kickoff ${kickoff.time} ET.${network ? ` TV: ${network}.` : ''}`;
}

function buildRss(events, week) {
  const sorted = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));
  const items = sorted.map(event => {
    const title = gameTitle(event);
    const desc = gameDescription(event, week);
    const link = event?.links?.find(l => l?.href)?.href || `https://www.espn.com/nfl/game/_/gameId/${event?.id || ''}`;
    return `    <item>\n      <title>${xmlEscape(title)}</title>\n      <description>${xmlEscape(desc)}</description>\n      <link>${xmlEscape(link)}</link>\n      <guid isPermaLink="false">espn-nfl-${xmlEscape(event?.id || crypto.randomUUID())}</guid>\n    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>2026 NFL Week ${week} Live Schedule & Scores</title>\n    <link>https://www.nfl.com/schedules/</link>\n    <description>Live NFL schedule, scores and final results for EVMux. Automatically updates from the current 2026 regular-season week.</description>\n    <language>en-us</language>\n    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n    <ttl>1</ttl>\n${items}\n  </channel>\n</rss>\n`;
}

export async function GET() {
  try {
    const week = currentWeek();
    const url = `${ESPN_SCOREBOARD}?limit=100&dates=${SEASON}&seasontype=${REGULAR_SEASON_TYPE}&week=${week}`;
    const data = await getJson(url);
    const events = Array.isArray(data?.events) ? data.events : [];
    if (!events.length) throw new Error(`No NFL events returned for Week ${week}`);

    return new Response(buildRss(events, week), {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30, stale-if-error=300',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    const message = `Live NFL feed temporarily unavailable: ${error?.message || 'unknown error'}`;
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>NFL Live Feed</title><description>${xmlEscape(message)}</description></channel></rss>`, {
      status: 503,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }
}
