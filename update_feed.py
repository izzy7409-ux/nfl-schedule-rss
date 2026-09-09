import datetime as dt
import html
import json
import urllib.request
from zoneinfo import ZoneInfo

SEASON = 2026
SEASON_TYPE = 2
WEEK1_START = dt.date(2026, 9, 9)
ET = ZoneInfo('America/New_York')
API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'


def current_week(now=None):
    now = now or dt.datetime.now(ET)
    diff = (now.date() - WEEK1_START).days
    return max(1, min(18, diff // 7 + 1))


def get_json(url):
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (compatible; PRP-NFL-RSS/1.0)',
            'Accept': 'application/json'
        }
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def esc(v):
    return html.escape(str(v or ''), quote=True)


def team_info(comp, side):
    c = next((x for x in comp.get('competitors', []) if x.get('homeAway') == side), {})
    team = c.get('team', {})
    return {
        'name': team.get('displayName') or team.get('shortDisplayName') or side.upper(),
        'score': c.get('score', '0')
    }


def networks(comp):
    out = []
    for b in comp.get('broadcasts', []):
        out += b.get('names', [])
    for g in comp.get('geoBroadcasts', []):
        media = g.get('media', {}) or {}
        name = media.get('shortName') or media.get('name')
        if name:
            out.append(name)
    return ' / '.join(dict.fromkeys(out))


def kickoff_parts(iso):
    d = dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(ET)
    return {
        'day': d.strftime('%a').upper(),
        'month': d.strftime('%b').upper(),
        'date': d.day,
        'time': d.strftime('%-I:%M %p')
    }


def game_text(event):
    comp = (event.get('competitions') or [{}])[0]
    away = team_info(comp, 'away')
    home = team_info(comp, 'home')
    status = comp.get('status') or event.get('status') or {}
    stype = status.get('type', {}) or {}
    state = stype.get('state', 'pre')
    network = networks(comp)
    suffix = f' | {network}' if network else ''

    if state == 'in':
        detail = stype.get('shortDetail') or ''
        period = int(status.get('period') or 0)
        clock = status.get('displayClock') or ''
        if period == 2 and (clock == '0:00' or 'half' in detail.lower()):
            phase = 'HALFTIME'
        else:
            phase = detail or (f'Q{period} {clock}'.strip() if period else 'LIVE')
        title = f'LIVE | {away["name"]} {away["score"]} - {home["name"]} {home["score"]} | {phase}{suffix}'
        desc = f'{away["name"]} {away["score"]}, {home["name"]} {home["score"]}. {phase}.'
        return title, desc

    if state == 'post':
        detail = (stype.get('shortDetail') or 'FINAL').upper()
        title = f'{detail} | {away["name"]} {away["score"]} - {home["name"]} {home["score"]}'
        desc = f'Final: {away["name"]} {away["score"]}, {home["name"]} {home["score"]}.'
        return title, desc

    k = kickoff_parts(event.get('date'))
    title = f'{k["day"]} {k["month"]} {k["date"]} | {away["name"]} at {home["name"]} | {k["time"]} ET{suffix}'
    desc = f'{away["name"]} at {home["name"]}. Kickoff {k["time"]} ET.' + (f' TV: {network}.' if network else '')
    return title, desc


def build_feed(events, week):
    events = sorted(events, key=lambda e: e.get('date', ''))
    items = []
    for event in events:
        title, desc = game_text(event)
        link = next((x.get('href') for x in event.get('links', []) if x.get('href')), 'https://www.espn.com/nfl/')
        event_id = event.get('id', 'unknown')
        items.append(f'''    <item>
      <title>{esc(title)}</title>
      <description>{esc(desc)}</description>
      <link>{esc(link)}</link>
      <guid isPermaLink="false">espn-nfl-{esc(event_id)}</guid>
    </item>''')

    now = dt.datetime.now(dt.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')
    body = '\n'.join(items)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>2026 NFL Week {week} Live Schedule &amp; Scores</title>
    <link>https://www.nfl.com/schedules/</link>
    <description>Automatic NFL schedule, live scores and final results for EVMux.</description>
    <language>en-us</language>
    <lastBuildDate>{now}</lastBuildDate>
    <ttl>5</ttl>
{body}
  </channel>
</rss>
'''


def main():
    week = current_week()
    url = f'{API}?limit=100&dates={SEASON}&seasontype={SEASON_TYPE}&week={week}'
    data = get_json(url)
    events = data.get('events') or []
    if not events:
        raise RuntimeError(f'No NFL events returned for Week {week}')
    with open('feed.xml', 'w', encoding='utf-8') as f:
        f.write(build_feed(events, week))
    print(f'Updated feed.xml for Week {week} with {len(events)} games')


if __name__ == '__main__':
    main()
