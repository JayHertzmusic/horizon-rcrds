/* Estadísticas de cada release (panel → Releases → un release → Stats). Todo de fuentes públicas y gratis:
   - SoundCloud (API de la app): reproducciones, likes, reposts, comentarios y quién lo ha reposteado.
   - YouTube (páginas públicas): visitas y likes del vídeo, y otros canales que lo han subido.
   - Deezer (API pública): ranking del track.
   - Spotify (páginas «embed» públicas): en qué playlists vigiladas está y en qué posición.
   - 1001Tracklists (su buscador): cuántas veces lo han pinchado DJs en sets publicados.
   Se recoge poco a poco (cron, pocas peticiones cada vez) y al abrir un release si los datos son viejos.
   Cada día se guarda una foto de los números para la gráfica. Si una fuente falla, se queda su último dato bueno. */
import { scApp } from './chain.js';

export class TracksError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const TRACKS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS track_stats (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS track_history (id TEXT NOT NULL, day TEXT NOT NULL, sc_plays INTEGER, sc_likes INTEGER, sc_reposts INTEGER, yt_views INTEGER, dz_rank INTEGER, dj_plays INTEGER, PRIMARY KEY (id, day))`,
  // playlists de Spotify vigiladas (las de Horizon se añaden solas; los owners pueden añadir más)
  `CREATE TABLE IF NOT EXISTS sp_watch (id TEXT PRIMARY KEY, name TEXT, owner TEXT, followers INTEGER, tracks TEXT, added_by TEXT, at INTEGER)`,
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const YT_H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
const STALE = 6 * 3600e3;   // al abrir un release, si sus datos tienen más de 6 h se ponen al día
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const firstArtist = a => String(a || '').split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bvs\.?)\s*/i)[0];
const num = s => { const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i); return m ? Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1)) : null; };
const ent = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const timeout = () => AbortSignal.timeout(15000);
const day = () => new Date().toISOString().slice(0, 10);

async function releases(env) {
  return parse((await env.DB.prepare("SELECT json FROM site_data WHERE name = 'releases'").first())?.json) || [];
}

/* ---------- fuentes ---------- */
async function soundcloud(env, r) {
  if (!/soundcloud\.com\//i.test(r.soundcloud_link || '')) return null;
  const t = await scApp(env, `/resolve?url=${encodeURIComponent(r.soundcloud_link.split('?')[0])}`);
  if (t?.kind !== 'track' || !t.id) throw new Error('SoundCloud: track not found');
  const rp = await scApp(env, `/tracks/${t.id}/reposters?limit=50`).catch(() => null);
  const reposters = (rp?.collection || rp || []).filter(u => u && u.permalink_url)
    .map(u => ({ name: u.username || u.permalink, url: String(u.permalink_url).split('?')[0], followers: u.followers_count || 0, avatar: u.avatar_url || '' }))
    .sort((a, b) => b.followers - a.followers).slice(0, 30);
  return { plays: t.playback_count ?? null, likes: t.favoritings_count ?? t.likes_count ?? null, reposts: t.reposts_count ?? null, comments: t.comment_count ?? null, url: String(t.permalink_url || r.soundcloud_link).split('?')[0], reposters };
}
async function youtube(r) {
  const id = (String(r.youtube_link || '').match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  if (!id) return null;
  const url = `https://www.youtube.com/watch?v=${id}`;
  const h = await (await fetch(url, { headers: YT_H, signal: timeout() })).text().catch(() => '');
  let views = num((h.match(/"viewCount":"(\d+)"/) || [])[1]);
  const along = h.match(/along with ([\d,]+) other/);
  const likes = along ? num(along[1]) + 1 : num((h.match(/"label":"([\d,.]+[KM]?) likes"/) || [])[1]);
  // desde Cloudflare la página del vídeo a veces no trae los números: las visitas salen igual en el buscador de YouTube
  for (const q of [`"${id}"`, `${firstArtist(r.artist)} ${r.title}`]) {
    if (views != null) break;
    views = (await ytSearch(q).catch(() => [])).find(v => v.videoId === id)?.views ?? null;
  }
  if (views == null) throw new Error('YouTube: no numbers');
  return { views, likes, url };
}
async function ytSearch(q) {
  const h = await (await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: YT_H, signal: timeout() })).text();
  const m = h.match(/id="yt-initial-data"[^>]*>([\s\S]*?)<\/script>/) || h.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  const j = parse(m?.[1]);
  if (!j) throw new Error('YouTube search: no data');
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length > 40) return;
    if (o.videoRenderer) { out.push(o.videoRenderer); return; }
    for (const k in o) walk(o[k]);
  })(j);
  return out.map(v => ({ videoId: v.videoId, title: v.title?.runs?.map(x => x.text).join('') || '', channel: v.ownerText?.runs?.[0]?.text || '', views: num(v.viewCountText?.simpleText) }));
}
// otros canales que lo han subido (búsqueda pública de YouTube): título con el track y el artista, que no sean de Horizon
async function youtubeOthers(r) {
  const q = `${firstArtist(r.artist)} ${r.title}`;
  const out = await ytSearch(q), own = (String(r.youtube_link || '').match(/(?:v=|youtu\.be\/)([\w-]{11})/) || [])[1];
  // el título del track entero (detrás solo puede venir el final, «(», «[», «-» o «|»): «Pain» no es «Pain In The Ass»
  const words = s => ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}()\[\]|\-–—]+/gu, ' ').trim() + ' ';
  const tw = words(r.title).trim(), a = norm(firstArtist(r.artist));
  const hasTitle = v => { const w = words(v), i = w.indexOf(' ' + tw + ' '); return i >= 0 && /^\s*($|[(\[|\-–—])/.test(w.slice(i + tw.length + 2)); };
  return out.map(v => ({ ...v, id: v.videoId }))
    .filter(v => v.id !== own && !/horizon\s*rcrds/i.test(v.channel) && hasTitle(v.title) && (norm(v.title).includes(a) || norm(v.channel).includes(a)))
    .slice(0, 8).map(v => ({ ...v, url: `https://www.youtube.com/watch?v=${v.id}` }));
}
async function deezer(r) {
  const q = `artist:"${firstArtist(r.artist).replace(/"/g, '')}" track:"${String(r.title).replace(/"/g, '')}"`;
  const j = await (await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}`, { signal: timeout() })).json();
  const t = (j?.data || []).find(x => norm(x.title).startsWith(norm(r.title)));
  return t ? { rank: t.rank ?? null, url: t.link || '' } : { rank: null, url: '' };
}
// 1001Tracklists: el buscador da, de cada track, las veces que sale en sets publicados («total tracklist plays»)
async function djSupport(r) {
  const body = new URLSearchParams({ main_search: `${firstArtist(r.artist)} ${r.title}`, search_selection: '2' });
  const res = await fetch('https://www.1001tracklists.com/search/result.php', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: timeout() });
  const h = await res.text();
  if (!res.ok || !h.includes('sDivTracks')) throw new Error('1001Tracklists ' + res.status);
  const t = norm(r.title), a = norm(firstArtist(r.artist));
  const found = h.split('<div class="bItm oItm" data-id="').slice(1).map(c => {
    const link = c.match(/<a href="(\/track\/[^"]+)"[^>]*>([^<]+)<\/a>/);
    const label = ent((c.match(/title="open label page">([^<]+)</) || [])[1]);
    const plays = +((c.match(/title="total tracklist plays">[\s\S]*?<span>(\d+)<\/span>/) || [])[1] || 0);
    return link ? { name: ent(link[2]), url: 'https://www.1001tracklists.com' + link[1], label, plays } : null;
  }).filter(x => x && norm(x.name).includes(t) && norm(x.name).includes(a));
  // el original primero (sin «remix» si el título no lo lleva), y los de Horizon antes que otros
  found.sort((x, y) => (/remix|edit|vip/i.test(x.name) && !/remix|edit|vip/i.test(r.title)) - (/remix|edit|vip/i.test(y.name) && !/remix|edit|vip/i.test(r.title)) || (/horizon/i.test(y.label) - /horizon/i.test(x.label)) || y.plays - x.plays);
  const best = found[0];
  return best ? { plays: best.plays, url: best.url, others: found.slice(1, 5) } : { plays: 0, url: '', others: [] };
}
// ids de Spotify de los tracks del release (un track o los de su álbum, de la página «embed» pública)
async function spotifyIds(r) {
  const m = String(r.spotify_link || '').match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album)\/([A-Za-z0-9]+)/);
  if (!m) return [];
  if (m[1] === 'track') return [m[2]];
  const e = await embed('album', m[2]);
  return (e?.trackList || []).map(t => String(t.uri || '').split(':').pop()).filter(Boolean);
}
async function embed(kind, id) {
  const h = await (await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { 'User-Agent': UA }, signal: timeout() })).text();
  return parse((h.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1])?.props?.pageProps?.state?.data?.entity || null;
}

/* ---------- playlists vigiladas ---------- */
const PL_ID = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{10,40})/;
async function syncOwnPlaylists(env) {
  const own = parse((await env.DB.prepare("SELECT json FROM site_data WHERE name = 'playlists'").first())?.json) || [];
  const ids = [...new Set(own.map(p => (String(p.link || '').match(PL_ID) || [])[1]).filter(Boolean))];
  if (ids.length) await env.DB.batch(ids.map(id => env.DB.prepare("INSERT OR IGNORE INTO sp_watch (id, added_by, at) VALUES (?, 'horizon', 0)").bind(id)));
}
async function refreshPlaylist(env, id) {
  const e = await embed('playlist', id);
  if (!e) throw new Error('Spotify playlist not readable');
  let followers = null;
  try { followers = num(((await (await fetch(`https://open.spotify.com/playlist/${id}`, { headers: { 'Accept-Language': 'en' }, signal: timeout() })).text()).match(/([\d.,]+[KM]?) saves?\b/i) || [])[1]); } catch { /* sin seguidores */ }
  const tracks = (e.trackList || []).map((t, i) => [String(t.uri || '').split(':').pop(), i + 1]).filter(t => t[0]);
  await env.DB.prepare('UPDATE sp_watch SET name = ?, owner = ?, followers = COALESCE(?, followers), tracks = ?, at = ? WHERE id = ?')
    .bind(String(e.name || e.title || '').slice(0, 200), String(e.subtitle || '').slice(0, 200), followers, JSON.stringify(tracks), Date.now(), id).run();
}

/* ---------- recoger un release ---------- */
async function collect(env, r) {
  const old = parse((await env.DB.prepare('SELECT json FROM track_stats WHERE id = ?').bind(r.id).first())?.json) || {};
  const [sc, yt, yo, dz, dj, sp] = await Promise.allSettled([soundcloud(env, r), youtube(r), youtubeOthers(r), deezer(r), djSupport(r), spotifyIds(r)]);
  const pick = (x, k) => x.status === 'fulfilled' ? x.value : (console.error('track stats', r.id, k, x.reason?.message), old[k] ?? null);
  const v = { sc: pick(sc, 'sc'), yt: pick(yt, 'yt'), ytOthers: pick(yo, 'ytOthers'), dz: pick(dz, 'dz'), dj: pick(dj, 'dj'), spIds: pick(sp, 'spIds') || [] };
  v.failed = [[sc, 'SoundCloud'], [yt, 'YouTube'], [yo, 'YouTube search'], [dz, 'Deezer'], [dj, '1001Tracklists'], [sp, 'Spotify']].filter(([x]) => x.status === 'rejected').map(([, n]) => n);
  const t = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO track_stats (id, json, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, at = excluded.at').bind(r.id, JSON.stringify(v), t),
    env.DB.prepare('INSERT INTO track_history (id, day, sc_plays, sc_likes, sc_reposts, yt_views, dz_rank, dj_plays) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id, day) DO UPDATE SET sc_plays = excluded.sc_plays, sc_likes = excluded.sc_likes, sc_reposts = excluded.sc_reposts, yt_views = excluded.yt_views, dz_rank = excluded.dz_rank, dj_plays = excluded.dj_plays')
      .bind(r.id, day(), v.sc?.plays ?? null, v.sc?.likes ?? null, v.sc?.reposts ?? null, v.yt?.views ?? null, v.dz?.rank ?? null, v.dj?.plays ?? null),
  ]);
  return { ...v, at: t };
}

// cron (cada 30 min): unos pocos releases (los que llevan más sin mirarse; los nuevos primero) y una playlist vigilada
export async function refreshTracks(env, n = 3) {
  await syncOwnPlaylists(env);
  const pl = await env.DB.prepare('SELECT id FROM sp_watch ORDER BY at LIMIT 1').first();
  if (pl) await refreshPlaylist(env, pl.id).catch(async e => { console.error('sp watch', pl.id, e.message); await env.DB.prepare('UPDATE sp_watch SET at = ? WHERE id = ?').bind(Date.now(), pl.id).run(); });
  const rel = await releases(env);
  const seen = new Map((await env.DB.prepare('SELECT id, at FROM track_stats').all()).results.map(x => [x.id, x.at]));
  // los 10 más nuevos cuentan como más viejos (se miran más a menudo)
  const todo = rel.map((r, i) => ({ r, w: (seen.get(r.id) || 0) - (i < 10 ? 12 * 3600e3 : 0) })).sort((a, b) => a.w - b.w).slice(0, n);
  for (const { r } of todo) await collect(env, r).catch(e => console.error('track stats', r.id, e.message));
}

/* ---------- API del panel ---------- */
export async function tracksApi(req, env, s, url, can, ctx) {
  if (!can('view')) throw new TracksError(403, 'Your role has no Releases access.');
  const p = url.pathname, m = req.method;
  // vigilar otra playlist de Spotify (owners)
  if (p === '/api/tracks/watch' && m === 'POST') {
    if (!s.owner) throw new TracksError(403, 'Only owners can add playlists.');
    const b = parse(await req.text()) || {}, id = (String(b.link || '').match(PL_ID) || [])[1];
    if (!id) throw new TracksError(400, 'Paste a Spotify playlist link (open.spotify.com/playlist/…).');
    if (b.remove) { await env.DB.prepare("DELETE FROM sp_watch WHERE id = ? AND added_by <> 'horizon'").bind(id).run(); return { ok: true }; }
    await env.DB.prepare('INSERT OR IGNORE INTO sp_watch (id, added_by, at) VALUES (?, ?, 0)').bind(id, s.email).run();
    try { await refreshPlaylist(env, id); } catch { await env.DB.prepare('DELETE FROM sp_watch WHERE id = ?').bind(id).run(); throw new TracksError(400, 'That playlist can’t be read. Is it public?'); }
    return { ok: true };
  }
  const id = decodeURIComponent(p.slice('/api/tracks/'.length));
  if (m !== 'GET' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new TracksError(404, 'Not found.');
  const r = (await releases(env)).find(x => x.id === id);
  if (!r) throw new TracksError(404, 'Release not found.');
  const row = await env.DB.prepare('SELECT json, at FROM track_stats WHERE id = ?').bind(id).first();
  let v = row ? { ...parse(row.json), at: row.at } : null, refreshing = false;
  if (!v) { await syncOwnPlaylists(env); v = await collect(env, r); }
  else if (Date.now() - v.at > STALE || url.searchParams.get('fresh') === '1') { refreshing = true; ctx.waitUntil(collect(env, r).catch(e => console.error('track stats', id, e.message))); }
  // playlists vigiladas que aún no se han mirado nunca: unas pocas ahora (el resto, en el cron)
  for (const pl of (await env.DB.prepare('SELECT id FROM sp_watch WHERE at = 0 LIMIT 3').all()).results) await refreshPlaylist(env, pl.id).catch(() => env.DB.prepare('UPDATE sp_watch SET at = ? WHERE id = ?').bind(Date.now(), pl.id).run());
  const hist = (await env.DB.prepare('SELECT day, sc_plays, sc_likes, sc_reposts, yt_views, dj_plays FROM track_history WHERE id = ? ORDER BY day').bind(id).all()).results;
  const pls = (await env.DB.prepare('SELECT id, name, owner, followers, tracks, added_by, at FROM sp_watch').all()).results;
  const ids = new Set(v.spIds || []);
  const playlists = pls.map(pl => { const hit = (parse(pl.tracks) || []).find(([t]) => ids.has(t)); return hit ? { name: pl.name || 'Playlist', owner: pl.owner || '', followers: pl.followers, position: hit[1], url: `https://open.spotify.com/playlist/${pl.id}`, horizon: pl.added_by === 'horizon' } : null; })
    .filter(Boolean).sort((a, b) => (b.followers || 0) - (a.followers || 0));
  return { stats: v, history: hist, playlists, watched: pls.length, watchedChecked: pls.filter(x => x.at).length, refreshing };
}
