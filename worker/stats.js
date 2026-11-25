/* Números públicos de HORIZON RCRDS para el Home del panel: YouTube (suscriptores, visitas, vídeos), SoundCloud
   (seguidores, reproducciones de sus tracks) y Spotify (saves de sus playlists). Se miran solos cada 30 min (cron) y se guardan en panel_settings;
   si una fuente falla, se queda el último número bueno. Todo es información pública (sin claves de pago). */
import { scLabelStats } from './chain.js';

const KEY = 'social_stats';
const YT_ABOUT = 'https://www.youtube.com/@HORIZONRCRDS/about';
const SC_PROFILE = 'https://soundcloud.com/horizonirecords';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// «29,514 views» → 29514 · «1.2K subscribers» → 1200
function num(s) {
  const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}
async function youtube() {
  const r = await fetch(YT_ABOUT, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  if (!r.ok) throw new Error('YouTube ' + r.status);
  const h = await r.text(), get = k => (h.match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1];
  const subs = num(get('subscriberCountText')), views = num(get('viewCountText')), videos = num(get('videoCountText'));
  if (subs == null && views == null) throw new Error('YouTube: no numbers');
  return { subs, views, videos, url: 'https://www.youtube.com/@HORIZONRCRDS' };
}

// Spotify: los «saves» (seguidores) de cada playlist de Horizon, sumados (la página pública de cada playlist los muestra)
async function spotify(env) {
  const row = await env.DB.prepare("SELECT json FROM site_data WHERE name = 'playlists'").first();
  const ids = [...new Set((JSON.parse(row?.json || '[]') || []).map(p => (String(p.link || '').match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/) || [])[1]).filter(Boolean))];
  if (!ids.length) throw new Error('Spotify: no playlists');
  const got = await Promise.all(ids.map(async id => {
    const r = await fetch(`https://open.spotify.com/playlist/${id}`, { headers: { 'Accept-Language': 'en' } });
    if (!r.ok) return null;
    const m = (await r.text()).match(/([\d.,]+[KM]?) saves?\b/i);
    return m ? num(m[1]) : null;
  }));
  const ok = got.filter(n => n != null);
  if (!ok.length) throw new Error('Spotify: no numbers');
  return { saves: ok.reduce((a, n) => a + n, 0), playlists: ids.length, url: 'https://open.spotify.com/user/315n3grwllchjxzjrsem7uqv5bse' };
}

async function load(env) {
  const row = await env.DB.prepare('SELECT value FROM panel_settings WHERE key = ?').bind(KEY).first().catch(() => null);
  try { return JSON.parse(row?.value || 'null'); } catch { return null; }
}
export async function refreshStats(env) {
  const old = (await load(env)) || {};
  const [yt, sc, sp] = await Promise.allSettled([youtube(), scLabelStats(env, SC_PROFILE), spotify(env)]);
  if (sp.status === 'rejected') console.error('stats spotify', sp.reason?.message);
  if (yt.status === 'rejected') console.error('stats youtube', yt.reason?.message);
  if (sc.status === 'rejected') console.error('stats soundcloud', sc.reason?.message);
  const v = { at: Date.now(), yt: yt.value || old.yt || null, sc: sc.value || old.sc || null, sp: sp.value || old.sp || null };
  await env.DB.prepare("INSERT INTO panel_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(KEY, JSON.stringify(v)).run();
  return v;
}
// el panel lo pide al abrir Home; si son de hace más de 30 min (o no hay), se ponen al día
export async function statsApi(env, ctx) {
  const v = await load(env);
  if (!v || !v.yt || !v.sc || !v.sp) return refreshStats(env);
  if (Date.now() - v.at > 30 * 60e3) ctx.waitUntil(refreshStats(env).catch(e => console.error('stats', e)));
  return v;
}
