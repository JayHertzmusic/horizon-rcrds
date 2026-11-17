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
     track_url TEXT, track_id TEXT, actions TEXT, notice TEXT, updated_at INTEGER, created_by TEXT)`,
];

/* ---------------- SoundCloud API ---------------- */
const SC_API = 'https://api.soundcloud.com';
const SC_AUTH = 'https://secure.soundcloud.com';
const REDIRECT = env => (env.SITE_URL || 'https://horizonrcrds.com').replace(/\/+$/, '') + '/api/sc/callback';

// token de la app (client_credentials): para resolver URLs públicas sin un miembro
let appTok = null;
async function appToken(env) {
  if (appTok && appTok.exp > now() + 60e3) return appTok.token;
  const r = await fetch(`${SC_AUTH}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new ChainError(502, `SoundCloud did not give app access (${r.status}).`);
  appTok = { token: j.access_token, exp: now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
// token de un miembro, renovándolo si está a punto de caducar
async function memberToken(env, m) {
  if (m.token_exp && m.token_exp > now() + 60e3) return m.access_token;
  if (!m.refresh_token) return m.access_token;
  const r = await fetch(`${SC_AUTH}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET, refresh_token: m.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new ChainError(401, 'SoundCloud access expired. The artist needs to connect again.');
  const exp = now() + (j.expires_in || 3600) * 1000;
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
// una acción en la cuenta de un miembro
async function doAction(env, m, type, target) {
  const tok = await memberToken(env, m);
  let r;
  if (type === 'follow') r = await scWrite(tok, 'PUT', `/me/followings/${encodeURIComponent(target)}`);
  else if (type === 'like') r = await scWrite(tok, 'PUT', `/likes/tracks/${encodeURIComponent(target)}`);
  else if (type === 'repost') r = await scWrite(tok, 'POST', `/reposts/tracks/${encodeURIComponent(target)}`);
  else throw new ChainError(400, 'Unknown action.');
  if (r.status === 404 && type === 'repost') r = await scWrite(tok, 'PUT', `/reposts/tracks/${encodeURIComponent(target)}`);   // (según la versión del endpoint)
  if (!r.ok && r.status !== 200 && r.status !== 201) {
    const t = await r.text().catch(() => '');
    throw new ChainError(502, `SoundCloud ${type} failed (${r.status}) ${t.slice(0, 120)}`);
  }
  await env.DB.prepare('UPDATE sc_members SET last_action_at = ? WHERE id = ?').bind(now(), m.id).run();
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
    return { settings: st, members, gates };
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
    const trackUrl = clean(body.track_url, 300);
    let trackId = null;
    if (trackUrl) trackId = await resolveTrack(env, trackUrl);
    const actions = body.actions && typeof body.actions === 'object' ? JSON.stringify({ follow: !!body.actions.follow, like: !!body.actions.like, repost: !!body.actions.repost }) : null;
    const notice = 'notice' in body ? clean(body.notice, 2000) : null;
    await DB.prepare(`INSERT INTO sc_gates (release_id, active, track_url, track_id, actions, notice, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id) DO UPDATE SET active = excluded.active, track_url = excluded.track_url, track_id = excluded.track_id,
         actions = COALESCE(excluded.actions, sc_gates.actions), notice = excluded.notice, updated_at = excluded.updated_at`)
      .bind(rid, body.active ? 1 : 0, trackUrl || null, trackId, actions, notice, now(), s.email).run();
    await audit(`${body.active ? 'Turned on' : 'Turned off'} the download gate for ${rid}`);
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
    const key = `chain/${rid}.mp3`;
    await env.FILES.put(key, buf, { metadata: { type: 'audio/mpeg', at: now() } });
    await DB.prepare(`INSERT INTO sc_gates (release_id, file, file_name, file_size, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(release_id) DO UPDATE SET file = excluded.file, file_name = excluded.file_name, file_size = excluded.file_size, updated_at = excluded.updated_at`)
      .bind(rid, key, name, buf.byteLength, now(), s.email).run();
    await audit(`Uploaded the download file for ${rid}`);
    return { ok: true };
  }
  // quién desbloqueó un release
  if (p === '/api/chain/unlocks' && m === 'GET') {
    const rid = clean(url.searchParams.get('release') || '', 80);
    const rows = (await DB.prepare(`SELECT u.at, m.name, m.permalink, m.avatar, m.followers FROM sc_unlocks u JOIN sc_members m ON m.id = u.member_id
       ${rid ? 'WHERE u.release_id = ?' : ''} ORDER BY u.id DESC LIMIT 500`).bind(...(rid ? [rid] : [])).all()).results;
    return { unlocks: rows };
  }
  throw new ChainError(404, 'Not found.');
}

/* ---------------- OAuth y gate (público) ---------------- */
// el fan pulsa «Connect»: se le manda a SoundCloud. Al volver, se hacen las acciones y se desbloquea la descarga.
export async function scOauth(req, env, url) {
  const DB = env.DB, p = url.pathname;
  const origin = (env.SITE_URL && /^https?:\/\//.test(env.SITE_URL)) ? env.SITE_URL.replace(/\/+$/, '') : url.origin;

  if (p === '/api/sc/login') {
    if (!env.SC_CLIENT_ID) throw new ChainError(503, 'SoundCloud is not connected yet.');
    const rid = clean(url.searchParams.get('r') || '', 80);
    const gate = rid ? await DB.prepare('SELECT active FROM sc_gates WHERE release_id = ?').bind(rid).first() : null;
    if (!gate?.active) throw new ChainError(404, 'This download is not available.');
    const state = token(), verifier = token() + token();
    await env.FILES.put(`scstate/${state}`, JSON.stringify({ verifier, rid, at: now() }), { expirationTtl: 600 });
    const auth = new URL(`${SC_AUTH}/authorize`);
    auth.search = new URLSearchParams({ client_id: env.SC_CLIENT_ID, redirect_uri: REDIRECT(env), response_type: 'code', state,
      code_challenge: await sha256b64u(verifier), code_challenge_method: 'S256' }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (p === '/api/sc/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const back = (msg, ok, rid) => Response.redirect(`${origin}/download${rid ? '/' + encodeURIComponent(rid) : ''}?${ok ? 'done=1' : 'error=' + encodeURIComponent(msg)}`, 302);
    if (url.searchParams.get('error')) return back('You cancelled the SoundCloud connection.', false, '');
    const st = state ? parse(await env.FILES.get(`scstate/${state}`)) : null;
    if (!code || !st) return back('The link expired. Please try again.', false, '');
    await env.FILES.delete(`scstate/${state}`).catch(() => {});
    try {
      const tr = await fetch(`${SC_AUTH}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.SC_CLIENT_ID, client_secret: env.SC_CLIENT_SECRET, redirect_uri: REDIRECT(env), code_verifier: st.verifier, code }) });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) throw new ChainError(502, 'SoundCloud sign-in failed.');
      const meR = await scGet(tj.access_token, '/me');
      if (!meR.ok || !meR.j?.id) throw new ChainError(502, 'Could not read the SoundCloud account.');
      const me = meR.j, exp = now() + (tj.expires_in || 3600) * 1000;
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
      return back('', true, st.rid);
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
    if (!gate?.active || !gate.file) throw new ChainError(404, 'This download is not available.');
    const rel = (parse((await DB.prepare("SELECT json FROM site_data WHERE name = 'releases'").first())?.json) || []).find(r => r.id === rid) || {};
    const st = await chainSettings(env);
    return { title: rel.title || '', artist: rel.artist || '', image: rel.image || '', color: rel.color || '', notice: gate.notice || st.notice, connected: st.connected };
  }
  // descargar el archivo (solo tras volver de SoundCloud, con ?ok): aquí comprobamos que hay al menos un desbloqueo reciente
  if (url.pathname === `/api/public/download/${encodeURIComponent(rid)}/file` && req.method === 'GET') {
    const gate = await DB.prepare('SELECT file, file_name FROM sc_gates WHERE release_id = ? AND active = 1').bind(rid).first();
    if (!gate?.file) throw new ChainError(404, 'Not available.');
    const f = await env.FILES.get(gate.file, { type: 'arrayBuffer' });
    if (!f) throw new ChainError(404, 'File not found.');
    const name = (gate.file_name || `${rid}.mp3`).replace(/[\\/:*?"<>|]+/g, '');
    return new Response(f, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
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
