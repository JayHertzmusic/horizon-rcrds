/* HORIZON RCRDS — cadena de ayuda en SoundCloud (download gates).
   El artista conecta su SoundCloud (OAuth), ACEPTA un aviso que dice qué se hará en su cuenta, y a cambio
   descarga el extended. Al aceptar, su cuenta entra en la cadena: sigue a Horizon, repostea y da like al track,
   y desde el panel (solo owners) se pueden programar más reposts/likes a otros tracks de la cadena.
   - OAuth con la app de Horizon (SC_CLIENT_ID / SC_CLIENT_SECRET, secretos del Worker).
   - El aviso es editable desde el panel: lo que diga es lo que se hace (nunca acciones no avisadas).
   Nada de esto borra ni cambia la cuenta más allá de seguir / repostear / dar like, lo que el artista aceptó. */

export class ChainError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const now = () => Date.now();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = () => { const u = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const sha256b64u = async s => { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export const CHAIN_SCHEMA = [
  // fichas de un rato (login de SoundCloud y descargas): en D1 y no en KV (KV gratis = 1000 escrituras al día y
  // cualquiera puede pulsar «conectar» en bucle)
  `CREATE TABLE IF NOT EXISTS sc_tokens (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL)`,
  // cuentas de SoundCloud conectadas (miembros de la cadena). id = id de usuario de SoundCloud
  `CREATE TABLE IF NOT EXISTS sc_members (id INTEGER PRIMARY KEY, name TEXT, permalink TEXT, avatar TEXT, followers INTEGER, city TEXT,
     access_token TEXT, refresh_token TEXT, token_exp INTEGER, scope TEXT, email TEXT,
     connected_at INTEGER, last_action_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`,
  // descargas desbloqueadas (quién, qué release, cuándo)
  `CREATE TABLE IF NOT EXISTS sc_unlocks (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, release_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sc_unlocks_rel ON sc_unlocks (release_id, id)`,
  // acciones de la cadena (hechas o programadas): follow | like | repost sobre un track o usuario
  `CREATE TABLE IF NOT EXISTS sc_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL,
     release_id TEXT, scheduled_at INTEGER NOT NULL, done_at INTEGER, status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sc_actions_due ON sc_actions (status, scheduled_at)`,
  // gate por release: si está activo, el archivo (clave en KV), el track de SoundCloud y las acciones al desbloquear
  `CREATE TABLE IF NOT EXISTS sc_gates (release_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, file TEXT, file_name TEXT, file_size INTEGER,
     track_url TEXT, track_id TEXT, actions TEXT, notice TEXT, downloads INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, created_by TEXT)`,
  // cada descarga real (para las estadísticas por día y el ranking)
  `CREATE TABLE IF NOT EXISTS sc_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, release_id TEXT NOT NULL, member_id INTEGER, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sc_downloads_at ON sc_downloads (at)`,
  // cuentas bloqueadas por un owner: no pueden volver a conectar (ni entrar en la cadena ni descargar)
  `CREATE TABLE IF NOT EXISTS sc_blocked (id INTEGER PRIMARY KEY, name TEXT, permalink TEXT, avatar TEXT, followers INTEGER, at INTEGER NOT NULL, by TEXT)`,
];

/* ---------------- SoundCloud API ---------------- */
const SC_API = 'https://api.soundcloud.com';
const SC_AUTH = 'https://secure.soundcloud.com';
const REDIRECT = env => (env.SITE_URL || 'https://horizonrcrds.com').replace(/\/+$/, '') + '/api/sc/callback';

// SoundCloud acepta la clave de la app de dos formas según el flujo: en el cuerpo (como en sus docs) o en la cabecera
// (Basic). Se prueban las dos y se usa la que devuelva token.
async function tokenExchange(env, params) {
  const basic = 'Basic ' + btoa(`${env.SC_CLIENT_ID}:${env.SC_CLIENT_SECRET}`), log = [];
  const tries = [
    { body: { ...params, client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET } },   // clave en el cuerpo
    { headers: { Authorization: basic }, body: params },                                          // clave en la cabecera
  ];
  for (const t of tries) {
    const r = await fetch(`${SC_AUTH}/oauth/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(t.headers || {}) },
      body: new URLSearchParams(t.body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) return { ok: true, j };
    log.push(`${r.status}:${j.error || j.error_description || ''}`);
  }
  return { ok: false, log: log.join(' / ') };
}
// token de la app (client_credentials): para resolver URLs públicas sin un miembro
let appTok = null;
async function appToken(env) {
  if (appTok && appTok.exp > now() + 60e3) return appTok.token;
  const t = await tokenExchange(env, { grant_type: 'client_credentials' });
  if (!t.ok) throw new ChainError(502, `SoundCloud did not give app access (${t.log}).`);
  appTok = { token: t.j.access_token, exp: now() + (t.j.expires_in || 3600) * 1000 };
  return t.j.access_token;
}
// token de un miembro, renovándolo si está a punto de caducar
async function memberToken(env, m) {
  if (m.token_exp && m.token_exp > now() + 60e3) return m.access_token;
  if (!m.refresh_token) return m.access_token;
  const t = await tokenExchange(env, { grant_type: 'refresh_token', refresh_token: m.refresh_token });
  if (!t.ok) throw new ChainError(401, 'SoundCloud access expired. The artist needs to connect again.');
  const j = t.j, exp = now() + (j.expires_in || 3600) * 1000;
  await env.DB.prepare('UPDATE sc_members SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_exp = ? WHERE id = ?')
    .bind(j.access_token, j.refresh_token || null, exp, m.id).run();
  m.access_token = j.access_token; m.token_exp = exp;
  return j.access_token;
}
const scGet = async (tok, path) => { const r = await fetch(`${SC_API}${path}`, { headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } }); const j = await r.json().catch(() => null); return { ok: r.ok, status: r.status, j }; };
const scWrite = (tok, method, path) => fetch(`${SC_API}${path}`, { method, headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } });

// id del track desde su URL de soundcloud.com (resolve). Se guarda en el gate para no resolver cada vez.
async function resolveTrack(env, url) {
  const tok = await appToken(env);
  const r = await fetch(`${SC_API}/resolve?url=${encodeURIComponent(url)}`, { headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.kind !== 'track' || !j.id) throw new ChainError(400, 'That is not a valid SoundCloud track link.');
  return String(j.id);
}
async function resolveUser(env, url) {
  const tok = await appToken(env);
  const r = await fetch(`${SC_API}/resolve?url=${encodeURIComponent(url)}`, { headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.kind !== 'user' || !j.id) throw new ChainError(400, 'That is not a valid SoundCloud profile link.');
  return { id: String(j.id), name: j.username || j.full_name || '', permalink: j.permalink_url || '' };
}
// una acción en la cuenta de un miembro. SoundCloud ha cambiado los endpoints varias veces: se prueban las variantes
// conocidas de cada acción hasta que una funcione.
const SC_ENDPOINTS = {
  follow: t => [['PUT', `/me/followings/${t}`], ['POST', `/me/followings/${t}`], ['PUT', `/users/${t}/followings`]],
  like: t => [['POST', `/likes/tracks/${t}`], ['PUT', `/likes/tracks/${t}`], ['PUT', `/me/favorites/${t}`], ['POST', `/me/likes/tracks/${t}`]],
  repost: t => [['POST', `/reposts/tracks/${t}`], ['PUT', `/reposts/tracks/${t}`], ['PUT', `/e1/me/track_reposts/${t}`]],
};
const scOk = s => s === 200 || s === 201 || s === 202 || s === 204;
async function doAction(env, m, type, target) {
  const tok = await memberToken(env, m), list = SC_ENDPOINTS[type];
  if (!list) throw new ChainError(400, 'Unknown action.');
  const t = encodeURIComponent(target), tries = [];
  for (const [method, path] of list(t)) {
    const r = await scWrite(tok, method, path);
    if (scOk(r.status)) { await env.DB.prepare('UPDATE sc_members SET last_action_at = ? WHERE id = ?').bind(now(), m.id).run(); return; }
    tries.push(`${method} ${path.split('/').slice(0, 3).join('/')}:${r.status}`);
    if (r.status === 401 || r.status === 403) break;   // token/permiso: no tiene sentido probar más
  }
  throw new ChainError(502, `SoundCloud ${type} failed (${tries.join(' / ')})`);
}

/* ---------------- Ajustes de la cadena ---------------- */
const DEFAULT_NOTICE = 'To download, connect your SoundCloud. By connecting you join the HORIZON RCRDS repost chain: your account will follow HORIZON RCRDS, and repost and like this track — and we may repost and like other chain tracks from your account so your own music gets the same support back. You can disconnect anytime in your SoundCloud settings.';
async function setting(env, key, def = '') { const r = await env.DB.prepare("SELECT value FROM panel_settings WHERE key = ?").bind(key).first().catch(() => null); return r?.value ?? def; }
async function setSetting(env, key, value) { await env.DB.prepare("INSERT INTO panel_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, String(value)).run(); }
async function chainSettings(env) {
  return {
    notice: await setting(env, 'sc_notice', DEFAULT_NOTICE),
    horizon_url: await setting(env, 'sc_horizon_url', ''),
    horizon_id: await setting(env, 'sc_horizon_id', ''),
    actions: parse(await setting(env, 'sc_actions', '')) || { follow: true, like: true, repost: true },
    connected: !!(env.SC_CLIENT_ID && env.SC_CLIENT_SECRET),
  };
}

/* ---------------- Panel (solo owners) ---------------- */
export async function chainApi(req, env, s, url, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!s.owner || s.sync) throw new ChainError(403, 'Only owners can manage the SoundCloud chain.');
  // la subida del archivo lee el cuerpo como binario aparte; el resto, JSON
  const body = m === 'POST' && !p.startsWith('/api/chain/file/') ? parse(await req.text()) || {} : null;

  if (p === '/api/chain' && m === 'GET') {
    const st = await chainSettings(env);
    const members = (await DB.prepare('SELECT id, name, permalink, avatar, followers, connected_at, last_action_at, revoked FROM sc_members ORDER BY connected_at DESC').all()).results;
    const gates = (await DB.prepare('SELECT g.*, (SELECT COUNT(*) FROM sc_unlocks u WHERE u.release_id = g.release_id) AS unlocks FROM sc_gates g').all()).results
      .map(g => ({ ...g, actions: parse(g.actions) || st.actions, active: !!g.active, file: !!g.file }));
    const blocked = (await DB.prepare('SELECT id, name, permalink, avatar, followers, at FROM sc_blocked ORDER BY at DESC').all()).results;
    return { settings: st, members, gates, blocked };
  }
  // ajustes generales: aviso, cuenta de Horizon a seguir, acciones por defecto
  if (p === '/api/chain/settings' && m === 'POST') {
    if ('notice' in body) await setSetting(env, 'sc_notice', clean(body.notice, 2000) || DEFAULT_NOTICE);
    if ('horizon_url' in body) {
      const u = clean(body.horizon_url, 300);
      if (u) { const who = await resolveUser(env, u); await setSetting(env, 'sc_horizon_url', who.permalink || u); await setSetting(env, 'sc_horizon_id', who.id); }
      else { await setSetting(env, 'sc_horizon_url', ''); await setSetting(env, 'sc_horizon_id', ''); }
    }
    if (body.actions && typeof body.actions === 'object') await setSetting(env, 'sc_actions', JSON.stringify({ follow: !!body.actions.follow, like: !!body.actions.like, repost: !!body.actions.repost }));
    await audit('Changed the SoundCloud chain settings');
    return { ok: true, settings: await chainSettings(env) };
  }
  // gate de un release: activar, track, acciones y aviso propio (opcional)
  if (p === '/api/chain/gate' && m === 'POST') {
    const rid = clean(body.release_id, 80);
    if (!rid) throw new ChainError(400, 'Which release?');
    const existing = await DB.prepare('SELECT track_url, track_id FROM sc_gates WHERE release_id = ?').bind(rid).first();
    const trackUrl = 'track_url' in body ? clean(body.track_url, 300) : (existing?.track_url || '');
    // el track solo se resuelve si el link cambió (así encender/apagar el gate es instantáneo)
    let trackId = existing?.track_id || null;
    if (trackUrl && trackUrl !== (existing?.track_url || '')) trackId = await resolveTrack(env, trackUrl);
    else if (!trackUrl) trackId = null;
    const actions = body.actions && typeof body.actions === 'object' ? JSON.stringify({ follow: !!body.actions.follow, like: !!body.actions.like, repost: !!body.actions.repost }) : null;
    const notice = 'notice' in body ? clean(body.notice, 2000) : null;
    await DB.prepare(`INSERT INTO sc_gates (release_id, active, track_url, track_id, actions, notice, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id) DO UPDATE SET active = excluded.active, track_url = excluded.track_url, track_id = excluded.track_id,
         actions = COALESCE(excluded.actions, sc_gates.actions), notice = COALESCE(excluded.notice, sc_gates.notice), updated_at = excluded.updated_at`)
      .bind(rid, body.active ? 1 : 0, trackUrl || null, trackId, actions, notice, now(), s.email).run();
    await audit(`${body.active ? 'Turned on' : 'Turned off'} the download gate for ${rid}`);
    return { ok: true, track_id: trackId };
  }
  // borrar el MP3 subido de un release
  if (p.startsWith('/api/chain/file/') && m === 'DELETE') {
    const rid = clean(decodeURIComponent(p.slice('/api/chain/file/'.length)), 80);
    const g = await DB.prepare('SELECT file, file_name FROM sc_gates WHERE release_id = ?').bind(rid).first();
    if (!g?.file) throw new ChainError(404, 'This release has no MP3.');
    await env.FILES.delete(g.file).catch(() => {});
    await DB.prepare('UPDATE sc_gates SET file = NULL, file_name = NULL, file_size = NULL, active = 0, updated_at = ? WHERE release_id = ?').bind(now(), rid).run();
    await audit(`Deleted the download file of ${rid}${g.file_name ? ` (${g.file_name})` : ''}`);
    return { ok: true };
  }
  // subir el archivo del extended (MP3) al KV
  if (p.startsWith('/api/chain/file/') && m === 'POST') {
    const rid = clean(decodeURIComponent(p.slice('/api/chain/file/'.length)), 80);
    const type = (req.headers.get('Content-Type') || '').split(';')[0];
    if (type !== 'audio/mpeg') throw new ChainError(400, 'Upload an MP3 file.');
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 25 * 1024 * 1024) throw new ChainError(400, 'The MP3 must be under 25 MB (use a 320 kbps MP3, not WAV).');
    const name = clean(url.searchParams.get('name'), 160) || `${rid}.mp3`;
    const key = `chain/${rid.replace(/[^\w-]/g, '')}-${now().toString(36)}.mp3`;
    const prev = (await DB.prepare('SELECT file FROM sc_gates WHERE release_id = ?').bind(rid).first())?.file;
    await env.FILES.put(key, buf, { metadata: { type: 'audio/mpeg', at: now() } });
    if (prev && prev !== key) await env.FILES.delete(prev).catch(() => {});
    await DB.prepare(`INSERT INTO sc_gates (release_id, file, file_name, file_size, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id) DO UPDATE SET file = excluded.file, file_name = excluded.file_name, file_size = excluded.file_size, updated_at = excluded.updated_at`)
      .bind(rid, key, name, buf.byteLength, now(), s.email).run();
    await audit(`Uploaded the download file for ${rid}`);
    return { ok: true };
  }
  // dar support a un track (de la cadena o de fuera): repost + like desde las cuentas conectadas
  if (p === '/api/chain/promote' && m === 'POST') {
    const trackUrl = clean(body.track_url, 300);
    if (!trackUrl) throw new ChainError(400, 'Paste the SoundCloud track link to support.');
    const trackId = await resolveTrack(env, trackUrl);
    const acts = [];
    if (body.repost) acts.push('repost');
    if (body.like) acts.push('like');
    if (!acts.length) throw new ChainError(400, 'Choose repost and/or like.');
    const ids = Array.isArray(body.members) ? body.members.map(x => Number(x)).filter(Boolean) : null;
    const members = (ids?.length
      ? await DB.prepare(`SELECT id FROM sc_members WHERE revoked = 0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()
      : await DB.prepare('SELECT id FROM sc_members WHERE revoked = 0').all()).results;
    if (!members.length) throw new ChainError(400, 'No connected accounts to support this track yet.');
    // orgánico: cada acción a una hora distinta y al azar dentro del periodo elegido (no todas de golpe)
    const spreadH = Math.max(0, Math.min(168, Number(body.spread_hours) || 0)), spreadMs = spreadH * 3600e3;
    const t = now(), ins = [];
    const order = members.flatMap(mem => acts.map(type => ({ mem, type }))).sort(() => Math.random() - 0.5);
    for (const { mem, type } of order) {
      const at = spreadMs ? t + Math.floor(Math.random() * spreadMs) : t;
      ins.push(DB.prepare(`INSERT INTO sc_actions (member_id, type, target, release_id, scheduled_at, status, created_at)
        SELECT ?, ?, ?, NULL, ?, 'queued', ? WHERE NOT EXISTS (SELECT 1 FROM sc_actions a WHERE a.member_id = ? AND a.type = ? AND a.target = ? AND a.status IN ('queued', 'done'))`)
        .bind(mem.id, type, trackId, at, t, mem.id, type, trackId));
    }
    for (let i = 0; i < ins.length; i += 50) await DB.batch(ins.slice(i, i + 50));
    await audit(`Queued ${acts.join(' + ')} on ${trackUrl} for ${members.length} chain account(s)${spreadH ? ` over ~${spreadH}h` : ''}`);
    // «Right away»: se hacen ahora mismo (el resto, si hubiera muchas, las sigue la tarea de cada 30 min)
    const processed = spreadH ? 0 : await runChainActions(env, 30);
    return { ok: true, members: members.length, actions: acts.length * members.length, spread_hours: spreadH, processed };
  }
  // estado de la cola de acciones y procesar un lote ahora
  if (p === '/api/chain/queue' && m === 'GET') {
    const rows = (await DB.prepare(`SELECT a.id, a.type, a.target, a.status, a.scheduled_at, a.done_at, a.error, m.name, m.permalink FROM sc_actions a LEFT JOIN sc_members m ON m.id = a.member_id ORDER BY a.id DESC LIMIT 200`).all()).results;
    const counts = Object.fromEntries((await DB.prepare('SELECT status, COUNT(*) AS n FROM sc_actions GROUP BY status').all()).results.map(c => [c.status, c.n]));
    return { actions: rows, counts };
  }
  if (p === '/api/chain/run' && m === 'POST') { const processed = await runChainActions(env, 30); return { ok: true, processed }; }
  if (p === '/api/chain/clear' && m === 'POST') { await DB.prepare("DELETE FROM sc_actions WHERE status = 'queued'").run(); await audit('Cleared the queued chain actions'); return { ok: true }; }

  // sacar a alguien de la cadena: se borran su cuenta conectada (y sus tokens) y sus acciones pendientes.
  // Sus descargas/connects pasados siguen contando en las estadísticas.
  if (p === '/api/chain/member/remove' && m === 'POST') {
    const id = Number(body.id);
    const mem = id ? await DB.prepare('SELECT name FROM sc_members WHERE id = ?').bind(id).first() : null;
    if (!mem) throw new ChainError(404, 'That account is not in the chain.');
    await DB.batch([
      DB.prepare("DELETE FROM sc_actions WHERE member_id = ? AND status = 'queued'").bind(id),
      DB.prepare('DELETE FROM sc_members WHERE id = ?').bind(id),
    ]);
    await audit(`Removed ${mem.name || '#' + id} from the SoundCloud chain`);
    return { ok: true };
  }
  // bloquear: se saca de la cadena (como Remove) y además no puede volver a conectar. Solo para quien el owner elija.
  if (p === '/api/chain/member/block' && m === 'POST') {
    const id = Number(body.id);
    const mem = id ? await DB.prepare('SELECT id, name, permalink, avatar, followers FROM sc_members WHERE id = ?').bind(id).first() : null;
    if (!mem) throw new ChainError(404, 'That account is not in the chain.');
    await DB.batch([
      DB.prepare('INSERT OR REPLACE INTO sc_blocked (id, name, permalink, avatar, followers, at, by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, mem.name, mem.permalink, mem.avatar, mem.followers, now(), s.email),
      DB.prepare("DELETE FROM sc_actions WHERE member_id = ? AND status = 'queued'").bind(id),
      DB.prepare('DELETE FROM sc_members WHERE id = ?').bind(id),
    ]);
    await audit(`Blocked ${mem.name || '#' + id} from the SoundCloud chain`);
    return { ok: true };
  }
  if (p === '/api/chain/member/unblock' && m === 'POST') {
    const id = Number(body.id);
    const b = id ? await DB.prepare('SELECT name FROM sc_blocked WHERE id = ?').bind(id).first() : null;
    if (!b) throw new ChainError(404, 'That account is not blocked.');
    await DB.prepare('DELETE FROM sc_blocked WHERE id = ?').bind(id).run();
    await audit(`Unblocked ${b.name || '#' + id} in the SoundCloud chain`);
    return { ok: true };
  }
  // estadísticas: descargas y connects con fecha de los últimos N días (el panel los agrupa por día en su hora local)
  if (p === '/api/chain/stats' && m === 'GET') {
    // days=all → todo el historial
    const all = url.searchParams.get('days') === 'all';
    const days = all ? null : Math.max(7, Math.min(365, Number(url.searchParams.get('days')) || 90)), since = all ? 0 : now() - (days + 1) * 86400e3;
    const [dl, un, first] = await Promise.all([
      // (las más nuevas primero: si hubiera más de 20.000, las que faltan son las más antiguas, no las de estos días)
      DB.prepare('SELECT release_id AS r, at FROM sc_downloads WHERE at >= ? ORDER BY at DESC LIMIT 20000').bind(since).all(),
      DB.prepare('SELECT release_id AS r, at FROM sc_unlocks WHERE at >= ? ORDER BY at DESC LIMIT 20000').bind(since).all(),
      DB.prepare('SELECT MIN(at) AS at FROM sc_downloads').first(),
    ]);
    return { days, downloads: dl.results, connects: un.results, tracked_since: first?.at || null };
  }
  // quién desbloqueó un release
  if (p === '/api/chain/unlocks' && m === 'GET') {
    const rid = clean(url.searchParams.get('release') || '', 80);
    const rows = (await DB.prepare(`SELECT u.at, m.name, m.permalink, m.avatar, m.followers FROM sc_unlocks u LEFT JOIN sc_members m ON m.id = u.member_id
       ${rid ? 'WHERE u.release_id = ?' : ''} ORDER BY u.id DESC LIMIT 500`).bind(...(rid ? [rid] : [])).all()).results;
    return { unlocks: rows };
  }
  throw new ChainError(404, 'Not found.');
}

/* ---------------- OAuth y gate (público) ---------------- */
// el fan pulsa «Connect»: se le manda a SoundCloud. Al volver, se hacen las acciones y se desbloquea la descarga.
const tokPut = (env, k, v, ttl) => env.DB.prepare('INSERT INTO sc_tokens (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp').bind(k, JSON.stringify(v), now() + ttl * 1000).run();
const tokGet = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM sc_tokens WHERE k = ? AND exp > ?').bind(k, now()).first(); return r ? parse(r.v) : null; };
const tokDel = (env, k) => env.DB.prepare('DELETE FROM sc_tokens WHERE k = ? OR exp < ?').bind(k, now()).run();
export async function scOauth(req, env, url) {
  const DB = env.DB, p = url.pathname;
  const origin = (env.SITE_URL && /^https?:\/\//.test(env.SITE_URL)) ? env.SITE_URL.replace(/\/+$/, '') : url.origin;

  if (p === '/api/sc/login') {
    if (!env.SC_CLIENT_ID) throw new ChainError(503, 'SoundCloud is not connected yet.');
    const rid = clean(url.searchParams.get('r') || '', 80);
    const gate = rid ? await DB.prepare('SELECT active FROM sc_gates WHERE release_id = ?').bind(rid).first() : null;
    if (!gate?.active) throw new ChainError(404, 'This download is not available.');
    const state = token(), verifier = token() + token();
    await tokPut(env, `scstate/${state}`, { verifier, rid, at: now() }, 600);
    const auth = new URL(`${SC_AUTH}/authorize`);
    auth.search = new URLSearchParams({ client_id: env.SC_CLIENT_ID, redirect_uri: REDIRECT(env), response_type: 'code', state,
      code_challenge: await sha256b64u(verifier), code_challenge_method: 'S256' }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (p === '/api/sc/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    // ok = token de descarga (solo se da al conectar de verdad); si no, mensaje de error. Nunca se puede descargar con ?done=1 a mano.
    const back = (msg, ok, rid) => Response.redirect(`${origin}/download${rid ? '/' + encodeURIComponent(rid) : ''}?${ok ? 'dl=' + ok : 'error=' + encodeURIComponent(msg)}`, 302);
    const st = state && /^[\w-]{10,100}$/.test(state) ? await tokGet(env, `scstate/${state}`) : null;
    // cancelado: vuelve a la página de descarga de ese release (antes volvía sin release: «This download link is not valid»)
    if (url.searchParams.get('error')) return back('You cancelled the SoundCloud connection.', false, st?.rid || '');
    if (!code || !st) return back('The link expired. Please try again.', false, '');
    await tokDel(env, `scstate/${state}`).catch(() => {});
    try {
      const t = await tokenExchange(env, { grant_type: 'authorization_code', redirect_uri: REDIRECT(env), code, code_verifier: st.verifier });
      if (!t.ok) { console.error('sc token', t.log); throw new ChainError(502, `SoundCloud sign-in failed (${t.log}).`); }
      const tj = t.j;
      const meR = await scGet(tj.access_token, '/me');
      if (!meR.ok || !meR.j?.id) { console.error('sc /me', meR.status, JSON.stringify(meR.j).slice(0, 200)); throw new ChainError(502, `Could not read the SoundCloud account (${meR.status}).`); }
      const me = meR.j, exp = now() + (tj.expires_in || 3600) * 1000;
      if (await DB.prepare('SELECT 1 FROM sc_blocked WHERE id = ?').bind(Number(me.id)).first()) return back('This SoundCloud account can’t use this download.', false, st.rid);
      const member = { id: String(me.id), access_token: tj.access_token, refresh_token: tj.refresh_token || null, token_exp: exp };
      await DB.prepare(`INSERT INTO sc_members (id, name, permalink, avatar, followers, city, access_token, refresh_token, token_exp, scope, connected_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, permalink = excluded.permalink, avatar = excluded.avatar, followers = excluded.followers,
           access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, sc_members.refresh_token), token_exp = excluded.token_exp, revoked = 0`)
        .bind(member.id, clean(me.username || me.full_name, 120), me.permalink_url || '', me.avatar_url || '', me.followers_count || 0, clean(me.city, 80),
          member.access_token, member.refresh_token, exp, tj.scope || '', now()).run();

      // acciones al desbloquear: seguir a Horizon + like + repost del track del release
      const st2 = await chainSettings(env), gate = await DB.prepare('SELECT * FROM sc_gates WHERE release_id = ?').bind(st.rid).first();
      const acts = parse(gate?.actions) || st2.actions;
      const errs = [];
      if (acts.follow && st2.horizon_id) try { await doAction(env, member, 'follow', st2.horizon_id); } catch (e) { errs.push(e.message); }
      if (gate?.track_id) {
        if (acts.like) try { await doAction(env, member, 'like', gate.track_id); } catch (e) { errs.push(e.message); }
        if (acts.repost) try { await doAction(env, member, 'repost', gate.track_id); } catch (e) { errs.push(e.message); }
      }
      await DB.prepare('INSERT INTO sc_unlocks (member_id, release_id, at) VALUES (?, ?, ?)').bind(member.id, st.rid, now()).run();
      if (errs.length) console.error('chain actions', member.id, errs.join(' | '));
      // token de descarga (vale 1 hora, solo para este release): sin él, el archivo no se sirve
      const dl = token();
      await tokPut(env, `dl/${dl}`, { rid: st.rid, member: member.id, at: now() }, 3600);
      return back('', dl, st.rid);
    } catch (e) {
      console.error('sc callback', e.message);
      return back(e.message || 'Something went wrong. Please try again.', false, st.rid);
    }
  }
  throw new ChainError(404, 'Not found.');
}

// datos públicos del gate de un release (para la página de descarga)
export async function chainPublic(req, env, url) {
  const rid = clean(decodeURIComponent((url.pathname.match(/^\/api\/public\/download\/([^/]+)/) || [])[1] || ''), 80);
  const DB = env.DB;
  if (url.pathname === `/api/public/download/${encodeURIComponent(rid)}` && req.method === 'GET') {
    const gate = await DB.prepare('SELECT active, file, file_name, notice FROM sc_gates WHERE release_id = ?').bind(rid).first();
    // link antiguo (el link del release se cambió en el panel): la página va al nuevo
    if (!gate) {
      const moved = (parse((await DB.prepare("SELECT json FROM site_data WHERE name = 'releases'").first())?.json) || []).find(r => r.id !== rid && Array.isArray(r.aliases) && r.aliases.includes(rid));
      if (moved) return { moved: moved.id };
    }
    if (!gate?.active || !gate.file) throw new ChainError(404, 'This download is not available.');
    const rel = (parse((await DB.prepare("SELECT json FROM site_data WHERE name = 'releases'").first())?.json) || []).find(r => r.id === rid) || {};
    const st = await chainSettings(env);
    return { title: rel.title || '', artist: rel.artist || '', image: rel.image || '', color: rel.color || '', notice: gate.notice || st.notice, connected: st.connected };
  }
  // descargar el archivo: solo con el token que da el servidor al conectar de verdad (bloquea el ?done=1 a mano)
  if (url.pathname === `/api/public/download/${encodeURIComponent(rid)}/file` && req.method === 'GET') {
    const dl = String(url.searchParams.get('t') || '');
    const pass = dl && /^[\w-]{10,100}$/.test(dl) ? await tokGet(env, `dl/${dl}`) : null;
    if (!pass || pass.rid !== rid) throw new ChainError(403, 'Connect your SoundCloud to unlock this download.');
    // de un solo uso: se quema al descargar, así compartir el link no sirve (hay 3 usos de margen por si el navegador reintenta)
    const uses = (pass.uses || 0) + 1;
    if (uses === 1) await DB.batch([   // cuenta una vez por descarga (total + registro con fecha para las estadísticas)
      DB.prepare('UPDATE sc_gates SET downloads = COALESCE(downloads, 0) + 1 WHERE release_id = ?').bind(rid),
      DB.prepare('INSERT INTO sc_downloads (release_id, member_id, at) VALUES (?, ?, ?)').bind(rid, pass.member || null, now()),
    ]).catch(() => {});
    if (uses >= 3) await tokDel(env, `dl/${dl}`).catch(() => {});
    else await tokPut(env, `dl/${dl}`, { ...pass, uses }, 1800).catch(() => {});
    const gate = await DB.prepare('SELECT file, file_name FROM sc_gates WHERE release_id = ? AND active = 1').bind(rid).first();
    if (!gate?.file) throw new ChainError(404, 'Not available.');
    const f = await env.FILES.get(gate.file, { type: 'arrayBuffer' });
    if (!f) throw new ChainError(404, 'File not found.');
    const name = (gate.file_name || `${rid}.mp3`).replace(/[\\/:*?"<>|]+/g, '');
    // (un nombre con «’», acentos o chino rompía la cabecera: error 500. Va en ASCII + el nombre de verdad en UTF-8)
    const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '').trim() || `${rid}.mp3`;
    return new Response(f, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  throw new ChainError(404, 'Not found.');
}

/* ---------------- Cron: acciones programadas de la cadena (fase 2) ---------------- */
export async function runChainActions(env, max = 20) {
  const due = (await env.DB.prepare("SELECT * FROM sc_actions WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?").bind(now(), max).all()).results;
  for (const a of due) {
    const m = await env.DB.prepare('SELECT * FROM sc_members WHERE id = ? AND revoked = 0').bind(a.member_id).first();
    if (!m) { await env.DB.prepare("UPDATE sc_actions SET status = 'skipped', error = 'account not connected', done_at = ? WHERE id = ?").bind(now(), a.id).run(); continue; }
    try { await doAction(env, m, a.type, a.target); await env.DB.prepare("UPDATE sc_actions SET status = 'done', done_at = ? WHERE id = ?").bind(now(), a.id).run(); }
    catch (e) { await env.DB.prepare("UPDATE sc_actions SET status = 'failed', error = ?, done_at = ? WHERE id = ?").bind(String(e.message).slice(0, 200), now(), a.id).run(); }
  }
  return due.length;
}

// números públicos del perfil de SoundCloud de Horizon (Home del panel): seguidores y reproducciones de sus tracks
export async function scLabelStats(env, url) {
  const tok = await appToken(env), h = { headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } };
  const u = await (await fetch(`${SC_API}/resolve?url=${encodeURIComponent(url)}`, h)).json().catch(() => null);
  if (!u || u.kind !== 'user' || !u.id) throw new Error('SoundCloud: profile not found');
  let plays = 0, likes = 0, n = 0, next = `${SC_API}/users/${u.id}/tracks?limit=200&linked_partitioning=true`;
  for (let i = 0; next && i < 10; i++) {
    const j = await (await fetch(next, h)).json().catch(() => null);
    if (!j) break;
    for (const t of j.collection || []) { plays += t.playback_count || 0; likes += t.favoritings_count || t.likes_count || 0; n++; }
    next = j.next_href || '';
  }
  return { followers: u.followers_count || 0, plays, likes, tracks: u.track_count || n, url: String(u.permalink_url || url).split('?')[0] };
}
// lectura de la API de SoundCloud con la clave de la app (estadísticas de cada track: panel → release → Stats)
export async function scApp(env, path) {
  const tok = await appToken(env);
  const r = await fetch(path.startsWith('http') ? path : SC_API + path, { headers: { Authorization: `OAuth ${tok}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error('SoundCloud ' + r.status);
  return r.json();
}
