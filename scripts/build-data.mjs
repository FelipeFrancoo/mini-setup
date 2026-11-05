// Gera _site/ (index.html + data.json + avatar) para o GitHub Pages.
// Roda na GitHub Action a cada 15 min. O iPad (iOS 9) só lê arquivos do
// próprio site, então não depende dos certificados de APIs externas.
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const USER = process.env.GH_USER;
const TOKEN = process.env.GITHUB_TOKEN;
const LAT = process.env.LAT || '-17.88';
const LON = process.env.LON || '-51.72';
const TZ = process.env.TZ_NAME || 'America/Sao_Paulo';
const REPO_LIMIT = 6;
const OUT = '_site';

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mini-setup-painel',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (e) { console.warn(`⚠ ${label}: ${e.message}`); return fallback; }
}

// ---------- commits ----------
async function getCommits() {
  const repos = [];
  const add = (name) => { if (name && !repos.includes(name) && repos.length < REPO_LIMIT) repos.push(name); };

  const events = await safe('eventos', () => gh(`/users/${USER}/events/public?per_page=100`), []);
  for (const ev of events) if (ev.type === 'PushEvent' || ev.type === 'CreateEvent') add(ev.repo?.name);

  if (repos.length < REPO_LIMIT) {
    const list = await safe('repos', () => gh(`/users/${USER}/repos?sort=pushed&per_page=${REPO_LIMIT}`), []);
    for (const r of list) add(r.full_name);
  }

  const all = [];
  await Promise.all(repos.map(async (repo) => {
    const list = await safe(`commits ${repo}`, () => gh(`/repos/${repo}/commits?per_page=10&author=${USER}`), []);
    for (const c of list) {
      all.push({
        repo: repo.split('/')[1],
        msg: (c.commit?.message || '').split('\n')[0].slice(0, 140),
        date: c.commit?.committer?.date || c.commit?.author?.date,
        sha: (c.sha || '').slice(0, 7),
      });
    }
  }));
  all.sort((a, b) => new Date(b.date) - new Date(a.date));
  const recent = all.slice(0, 12);
  const active = new Set(all.filter(c => Date.now() - new Date(c.date) < 30 * 864e5).map(c => c.repo)).size;
  return { commits: recent, activeRepos: active };
}

// ---------- mapa de contribuições ----------
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function contribGraphQL() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const j = await r.json();
  const cal = j?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error(JSON.stringify(j.errors || j).slice(0, 200));
  const days = cal.weeks.flatMap(w => w.contributionDays).map(d => ({
    date: d.date, count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0,
  }));
  return { total: cal.totalContributions, days };
}

async function contribFallback() {
  const r = await fetch(`https://github-contributions-api.jogruber.de/v4/${USER}?y=last`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return { total: j.total?.lastYear ?? 0, days: j.contributions.map(d => ({ date: d.date, count: d.count, level: d.level })) };
}

// ---------- clima ----------
async function getWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,weather_code,is_day` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=${encodeURIComponent(TZ)}&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return {
    temp: d.current.temperature_2m,
    code: d.current.weather_code,
    isDay: d.current.is_day === 1,
    max: d.daily.temperature_2m_max[0],
    min: d.daily.temperature_2m_min[0],
    rain: d.daily.precipitation_probability_max[0] ?? 0,
  };
}

// ---------- avatar (salvo no próprio site) ----------
async function getAvatar(url) {
  const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=96`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await writeFile(`${OUT}/avatar.png`, Buffer.from(await r.arrayBuffer()));
  return 'avatar.png';
}

// ---------- main ----------
if (!USER) { console.error('Defina GH_USER no workflow.'); process.exit(1); }
await mkdir(OUT, { recursive: true });
await copyFile('index.html', `${OUT}/index.html`);

const profile = await safe('perfil', () => gh(`/users/${USER}`), null);
const [gc, contributions, weather, avatar] = await Promise.all([
  safe('commits', getCommits, { commits: [], activeRepos: 0 }),
  safe('contribuições (graphql)', contribGraphQL, null).then(c => c || safe('contribuições (fallback)', contribFallback, null)),
  safe('clima', getWeather, null),
  profile?.avatar_url ? safe('avatar', () => getAvatar(profile.avatar_url), null) : null,
]);

const data = {
  generatedAt: new Date().toISOString(),
  user: { login: profile?.login || USER, avatar },
  commits: gc.commits,
  activeRepos: gc.activeRepos,
  contributions,
  weather,
};
await writeFile(`${OUT}/data.json`, JSON.stringify(data));
console.log(`✓ ${data.commits.length} commits · ${contributions?.days?.length ?? 0} dias no mapa · clima ${weather ? 'ok' : 'falhou'}`);
