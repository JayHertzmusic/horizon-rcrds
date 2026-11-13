/* HORIZON RCRDS — la web en Cloudflare (Worker "horizon-web").
   - Las páginas, estilos y portadas de siempre se sirven tal cual (carpeta de la web, "static assets").
   - releases.json, mixtapes.json, playlists.json y sync-ignore.json salen de la base de datos (D1).
   - Lo que se sube desde el panel o llega de SoundCloud (portadas, fragmentos mp3, logo…) se guarda en KV.
   - Panel: /admin (owners) y /team (equipo) con login de Google; /api/* comprueba el rol en cada cambio.
   - La sincronización con SoundCloud (GitHub Actions) se identifica con el token OIDC que GitHub da a ese
     workflow: no hay claves guardadas en ningún sitio. */
import STATIC_FILES from './static-files.json';

// Secciones del panel y lo que se puede hacer en cada una. Una sección nueva (p. ej. eventos) se añade aquí.
const SECTIONS = [
  { id: 'releases', label: 'Releases', actions: ['view', 'edit', 'delete'] },
  { id: 'radio', label: 'Mixtapes', actions: ['view', 'edit', 'delete'] },
  { id: 'playlists', label: 'Playlists', actions: ['view', 'edit', 'delete'] },
  { id: 'player', label: 'Reproductor', actions: ['view', 'edit'] },
];
// Datos de la web: nombre en la API → archivo público y sección del panel
const DATA = {
  releases: { file: 'releases.json', sec: 'releases' },
  mixtapes: { file: 'mixtapes.json', sec: 'radio' },
  playlists: { file: 'playlists.json', sec: 'playlists' },
  ignore: { file: 'sync-ignore.json', sec: null },
};
const BY_FILE = Object.fromEntries(Object.entries(DATA).map(([k, v]) => [v.file, k]));
// Archivos fijos que se sustituyen (no van ligados a un release)
const PROTECTED = { 'release_preview.mp3': 'player', 'logo.png': 'brand', 'favicon_icon.png': 'brand' };
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp3: 'audio/mpeg' };
const MAX_FILE = 25 * 1024 * 1024;
const SESSION_MS = 14 * 864e5;
const SYNC_WORKFLOW = '.github/workflows/soundcloud-sync.yml';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------------- Utilidades ---------------- */
const enc = new TextEncoder();
const now = () => Date.now();
function b64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function randomToken() {
  const u = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;
const FILE_NAME = /^[\w-][\w.-]{0,80}$/;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const owners = env => String(env.OWNER_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const fail = (status, message) => json({ message, panel: true }, status);
const isDevOrigin = o => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o || '');

/* ---------------- Base de datos ---------------- */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    `CREATE TABLE IF NOT EXISTS site_data (name TEXT PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, updated_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS site_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS site_history (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL, by_email TEXT, message TEXT)`,
    `CREATE TABLE IF NOT EXISTS site_files (name TEXT PRIMARY KEY, type TEXT, size INTEGER, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS panel_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '{}', created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS panel_members (email TEXT PRIMARY KEY, role_id TEXT, name TEXT, picture TEXT, added_by TEXT, added_at INTEGER, last_login INTEGER)`,
    `CREATE TABLE IF NOT EXISTS panel_sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, area TEXT NOT NULL, name TEXT, picture TEXT, created_at INTEGER, expires_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS panel_sessions_email ON panel_sessions (email)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT NOT NULL, name TEXT, picture TEXT, text TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS panel_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, email TEXT, name TEXT, action TEXT NOT NULL, detail TEXT)`,
    `INSERT OR IGNORE INTO site_meta (k, v) VALUES ('version', 0)`,
  ].map(q => env.DB.prepare(q)));
  // nombre que le pone el owner a cada persona (columna añadida después)
  try { await env.DB.prepare('ALTER TABLE panel_members ADD COLUMN label TEXT').run(); } catch { /* ya existe */ }
  schemaReady = true;
}
const audit = (env, who, action, detail = '') => env.DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)')
  .bind(now(), who.email, who.name || '', clean(action, 300), clean(detail, 300)).run();

/* ---------------- Permisos ---------------- */
function normPerms(p) {
  const out = {};
  for (const s of SECTIONS) {
    const v = {};
    for (const a of s.actions) v[a] = !!(p && p[s.id] && p[s.id][a]);
    if (v.edit || v.delete) v.view = true;
    out[s.id] = v;
  }
  return out;
}
const fullPerms = () => Object.fromEntries(SECTIONS.map(s => [s.id, Object.fromEntries(s.actions.map(a => [a, true]))]));
async function resolve(env, email) {
  if (owners(env).includes(email)) return { owner: true, role: { id: 'owner', name: 'Owner' }, perms: fullPerms() };
  const m = await env.DB.prepare('SELECT m.email, m.role_id, m.label, r.name AS role_name, r.perms FROM panel_members m LEFT JOIN panel_roles r ON r.id = m.role_id WHERE m.email = ?').bind(email).first();
  if (!m) return null;
  return { owner: false, label: m.label || '', role: m.role_name ? { id: m.role_id, name: m.role_name } : null, perms: normPerms(m.role_name ? parse(m.perms) : null) };
}
const can = (s, sec, act) => s.owner || !!s.perms?.[sec]?.[act];
const anyCan = (s, act) => s.owner || SECTIONS.some(x => s.perms?.[x.id]?.[act]);
function need(s, sec, act) {
  if (can(s, sec, act)) return;
  const label = SECTIONS.find(x => x.id === sec)?.label || sec;
  const what = { view: 'ver', edit: 'editar', delete: 'eliminar o excluir' }[act] || act;
  throw new HttpError(403, `Tu rol no tiene permiso para ${what} en ${label}.`);
}

/* ---------------- Firmas (Google y GitHub) ---------------- */
const jwksCache = new Map();
async function jwks(url, force) {
  const c = jwksCache.get(url);
  if (!force && c && now() - c.at < 3600e3) return c.keys;
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(502, 'No se pudo comprobar la firma. Inténtalo otra vez.');
  const keys = (await r.json()).keys || [];
  jwksCache.set(url, { at: now(), keys });
  return keys;
}
async function verifyJwt(token, jwksUrl, bad) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw bad;
  const dec = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));
  let header, p;
  try { header = dec(parts[0]); p = dec(parts[1]); } catch { throw bad; }
  if (header.alg !== 'RS256') throw bad;
  let jwk = (await jwks(jwksUrl)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(jwksUrl, true)).find(k => k.kid === header.kid);
  if (!jwk) throw bad;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]))) throw bad;
  const t = now() / 1000;
  if (!(p.exp > t - 60) || (p.nbf && p.nbf > t + 60)) throw bad;
  return p;
}
async function verifyGoogle(token, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(500, 'Falta el ID de cliente de Google en el servidor.');
  const bad = new HttpError(401, 'No se pudo comprobar tu cuenta de Google. Vuelve a intentarlo.');
  const p = await verifyJwt(token, 'https://www.googleapis.com/oauth2/v3/certs', bad);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) || p.aud !== env.GOOGLE_CLIENT_ID) throw bad;
  if (p.email_verified !== true && p.email_verified !== 'true') throw new HttpError(403, 'Tu email de Google no está verificado.');
  return { email: String(p.email || '').toLowerCase(), name: clean(p.name, 80), picture: /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(p.picture || '') ? p.picture : '' };
}
// Token OIDC del workflow de sincronización (solo ese archivo, en la rama main del repositorio de la web)
async function verifyGithubSync(token, env) {
  const bad = new HttpError(401, 'Sincronización no autorizada.');
  const p = await verifyJwt(token, 'https://token.actions.githubusercontent.com/.well-known/jwks', bad);
  const repo = String(env.SYNC_REPO || '');
  if (p.iss !== 'https://token.actions.githubusercontent.com' || p.aud !== 'horizon-web') throw bad;
  if (!repo || p.repository !== repo || p.ref !== 'refs/heads/main') throw bad;
  if (!String(p.workflow_ref || '').startsWith(`${repo}/${SYNC_WORKFLOW}@`)) throw bad;
  return { hash: 'sync', area: 'sync', email: 'sync@github', name: 'Sync SoundCloud', picture: '', owner: true, sync: true, role: { id: 'sync', name: 'Sync' }, perms: fullPerms() };
}

/* ---------------- Sesiones ---------------- */
async function startSession(env, g, area) {
  const who = await resolve(env, g.email);
  if (!who) throw new HttpError(403, `La cuenta ${g.email} no tiene acceso. Pide a un owner que te añada al equipo.`);
  if (area === 'admin' && !who.owner) throw new HttpError(403, 'Esta zona es solo para los owners. Entra en horizonrcrds.com/team');
  const token = randomToken(), hash = await sha256(token), t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM panel_sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('INSERT INTO panel_sessions (hash, email, area, name, picture, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(hash, g.email, area, g.name, g.picture, t, t + SESSION_MS),
    env.DB.prepare('UPDATE panel_members SET name = ?, picture = ?, last_login = ? WHERE email = ?').bind(g.name, g.picture, t, g.email),
  ]);
  await audit(env, g, `Entró en /${area}`);
  return { token, user: { email: g.email, name: who.label || g.name, picture: g.picture, ...who }, sections: SECTIONS };
}
async function session(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/);
  if (!m) throw new HttpError(401, 'Tienes que iniciar sesión.');
  if (m[1].includes('.')) return verifyGithubSync(m[1], env);
  const hash = await sha256(m[1]);
  const s = await env.DB.prepare('SELECT * FROM panel_sessions WHERE hash = ?').bind(hash).first();
  if (!s || s.expires_at < now()) throw new HttpError(401, 'Tu sesión ha caducado. Vuelve a entrar.');
  const who = await resolve(env, s.email);
  if (!who || (s.area === 'admin' && !who.owner)) {
    await env.DB.prepare('DELETE FROM panel_sessions WHERE hash = ?').bind(hash).run();
    throw new HttpError(401, 'Ya no tienes acceso a este panel.');
  }
  return { hash, area: s.area, email: s.email, picture: s.picture || '', ...who, name: who.label || s.name || '' };
}
const userOut = s => ({ email: s.email, name: s.name, picture: s.picture, owner: s.owner, role: s.role, perms: s.perms });

/* ---------------- Datos y archivos de la web ---------------- */
async function readData(env) {
  const rows = (await env.DB.prepare('SELECT name, json FROM site_data').all()).results;
  const out = {};
  for (const k of Object.keys(DATA)) {
    const v = parse(rows.find(r => r.name === k)?.json || '[]');
    out[k] = Array.isArray(v) ? v : [];
  }
  const ver = await env.DB.prepare(`SELECT v FROM site_meta WHERE k = 'version'`).first();
  return { version: ver?.v || 0, ...out };
}
// Todos los archivos de assets/: los de la web publicada + los subidos (KV), sin los borrados
async function fileList(env) {
  const files = {};
  for (const [name, f] of Object.entries(STATIC_FILES)) files[name] = { v: f.v, size: f.size };
  const rows = (await env.DB.prepare('SELECT name, size, updated_at, deleted FROM site_files').all()).results;
  for (const r of rows) {
    if (r.deleted) delete files[r.name];
    else files[r.name] = { v: r.updated_at.toString(36), size: r.size };
  }
  return files;
}
async function serveData(key, req, env) {
  const row = await env.DB.prepare('SELECT json, version FROM site_data WHERE name = ?').bind(key).first();
  const etag = `"${key}-${row?.version ?? 0}"`;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === 'HEAD' ? null : (row?.json ?? '[]'), { headers });
}
async function serveFile(name, req, env) {
  const obj = await env.FILES.getWithMetadata('f/' + name, { type: 'arrayBuffer' });
  if (!obj.value) return env.ASSETS.fetch(req);          // no se ha subido: el de la web publicada (o 404)
  const data = obj.value, size = data.byteLength, meta = obj.metadata || {};
  const headers = new Headers({
    'Content-Type': meta.type || TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream',
    'Cache-Control': PROTECTED[name] ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    ETag: `"${meta.at || size}"`,
  });
  if (req.headers.get('If-None-Match') === headers.get('ETag')) return new Response(null, { status: 304, headers });
  // Safari (iPhone) necesita poder pedir trozos del audio
  const range = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(req.method === 'HEAD' ? null : data.slice(start, end + 1), { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(req.method === 'HEAD' ? null : data, { headers });
}

/* ¿"after" es "before" con algunos elementos quitados (sin cambiar nada más)? */
function onlyRemoved(after, before) {
  let i = 0;
  for (const b of before) if (i < after.length && JSON.stringify(after[i]) === JSON.stringify(b)) i++;
  return i === after.length;
}
function assetRefs(d) {
  const refs = new Map();
  const add = (f, sec) => { if (typeof f === 'string' && f) { if (!refs.has(f)) refs.set(f, new Set()); refs.get(f).add(sec); } };
  for (const r of d.releases) add(r?.image, 'releases');
  for (const m of d.mixtapes) { add(m?.image, 'radio'); add(m?.preview, 'radio'); }
  for (const p of d.playlists) add(p?.image, 'playlists');
  return refs;
}
/* Revisa un cambio de alguien que no es owner contra su rol, lista por lista y archivo por archivo. */
function checkChange(s, old, next, uploads, removes) {
  for (const [k, d] of Object.entries(DATA)) {
    if (!d.sec || JSON.stringify(next[k]) === JSON.stringify(old[k])) continue;
    if (next[k].length < old[k].length) need(s, d.sec, 'delete');
    if (!onlyRemoved(next[k], old[k])) need(s, d.sec, 'edit');
  }
  if (JSON.stringify(next.ignore) !== JSON.stringify(old.ignore)) {
    const key = x => JSON.stringify(x), a = new Set(next.ignore.map(key)), b = new Set(old.ignore.map(key));
    const secOf = x => (x?.kind || (/mixtape/i.test(x?.title || '') ? 'mixtape' : 'release')) === 'mixtape' ? 'radio' : 'releases';
    for (const x of [...next.ignore.filter(x => !b.has(key(x))), ...old.ignore.filter(x => !a.has(key(x)))]) need(s, secOf(x), 'delete');
  }
  const oldRefs = assetRefs(old), newRefs = assetRefs(next);
  for (const f of uploads) {
    if (PROTECTED[f]) { need(s, PROTECTED[f], 'edit'); continue; }
    const secs = [...(newRefs.get(f) || [])];
    if (!secs.length) throw new HttpError(403, `Tu rol no puede subir ${f}.`);
    if (!secs.some(sec => can(s, sec, 'edit'))) need(s, secs[0], 'edit');
  }
  for (const f of removes) {
    const secs = [...(oldRefs.get(f) || [])];
    if (PROTECTED[f] || !secs.length || newRefs.has(f)) throw new HttpError(403, `Tu rol no puede borrar ${f}.`);
    if (!secs.some(sec => can(s, sec, 'edit') || can(s, sec, 'delete'))) need(s, secs[0], 'delete');
  }
}

/* Publicar: un cambio = listas nuevas + archivos subidos + archivos que ya no se usan. */
async function publish(req, env, s) {
  if (!s.sync && !anyCan(s, 'edit') && !anyCan(s, 'delete')) throw new HttpError(403, 'Tu rol solo puede ver.');
  let form;
  try { form = await req.formData(); } catch { throw new HttpError(400, 'Petición no válida.'); }
  const meta = parse(form.get('meta')) || {};
  const old = await readData(env);
  if (Number(meta.base) !== old.version) throw new HttpError(409, 'Alguien ha publicado a la vez. Vuelve a intentarlo.');
  const next = { ...old }, changed = [];
  for (const k of Object.keys(DATA)) {
    if (!(meta.lists && k in meta.lists)) continue;
    const v = meta.lists[k];
    if (!Array.isArray(v) || v.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new HttpError(400, `${DATA[k].file} no es una lista válida.`);
    if (JSON.stringify(v).length > 1_000_000) throw new HttpError(400, `${DATA[k].file} es demasiado grande.`);
    if (JSON.stringify(v) !== JSON.stringify(old[k])) { next[k] = v; changed.push(k); }
  }
  if (!next.releases.length) throw new HttpError(400, 'La web necesita al menos un lanzamiento.');
  const uploads = [];
  for (const [field, f] of form.entries()) {
    if (!field.startsWith('file:') || typeof f === 'string') continue;
    const name = field.slice(5), ext = name.split('.').pop().toLowerCase();
    if (!FILE_NAME.test(name) || !TYPES[ext]) throw new HttpError(400, `Nombre de archivo no válido: ${name}`);
    if (f.size > MAX_FILE) throw new HttpError(400, `${name} pesa demasiado (máx. 25 MB).`);
    uploads.push({ name, type: TYPES[ext], data: await f.arrayBuffer() });
  }
  const files = await fileList(env);
  const removes = [...new Set(Array.isArray(meta.remove) ? meta.remove : [])].filter(n => typeof n === 'string' && FILE_NAME.test(n) && files[n] && !uploads.some(u => u.name === n));
  if (!s.owner) checkChange(s, old, next, uploads.map(u => u.name), removes);
  if (!changed.length && !uploads.length && !removes.length) return json({ unchanged: true, version: old.version });

  const t = now(), version = old.version + 1, who = s.sync ? 'sync' : s.email, message = clean(meta.message, 300) || 'Cambio en la web';
  for (const u of uploads) await env.FILES.put('f/' + u.name, u.data, { metadata: { type: u.type, at: t } });
  const q = [env.DB.prepare(`UPDATE site_meta SET v = ? WHERE k = 'version'`).bind(version)];
  for (const k of changed) {
    const body = JSON.stringify(next[k], null, 2) + '\n';
    q.push(env.DB.prepare('INSERT INTO site_data (name, json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by').bind(k, body, version, t, who));
    q.push(env.DB.prepare('INSERT INTO site_history (name, json, at, by_email, message) VALUES (?, ?, ?, ?, ?)').bind(k, JSON.stringify(old[k]), t, who, message));
  }
  for (const u of uploads) q.push(env.DB.prepare('INSERT INTO site_files (name, type, size, updated_at, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT(name) DO UPDATE SET type = excluded.type, size = excluded.size, updated_at = excluded.updated_at, deleted = 0').bind(u.name, u.type, u.data.byteLength, t));
  for (const n of removes) q.push(env.DB.prepare('INSERT INTO site_files (name, updated_at, deleted) VALUES (?, ?, 1) ON CONFLICT(name) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at').bind(n, t));
  q.push(env.DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(t, s.email, s.name || '', message, `v${version}`));
  await env.DB.batch(q);
  for (const n of removes) await env.FILES.delete('f/' + n);
  return json({ version });
}

/* ---------------- Equipo (solo owners) ---------------- */
async function team(req, env, s, p) {
  if (!s.owner || s.sync) throw new HttpError(403, 'Solo los owners pueden gestionar el equipo.');
  const m = req.method, url = new URL(req.url), DB = env.DB;
  const body = m === 'POST' ? parse(await req.text()) || {} : null;
  if (p === '/api/team' && m === 'GET') {
    const [members, roles] = await Promise.all([
      DB.prepare('SELECT email, role_id, label, name, picture, added_at, last_login FROM panel_members ORDER BY added_at').all(),
      DB.prepare('SELECT id, name, perms FROM panel_roles ORDER BY created_at').all(),
    ]);
    return json({ owners: owners(env), sections: SECTIONS, members: members.results, roles: roles.results.map(r => ({ id: r.id, name: r.name, perms: normPerms(parse(r.perms)) })) });
  }
  if (p === '/api/team/audit' && m === 'GET') {
    return json({ items: (await DB.prepare('SELECT at, email, name, action, detail FROM panel_audit ORDER BY id DESC LIMIT 100').all()).results });
  }
  if (p === '/api/team/members' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 120) throw new HttpError(400, 'Ese email no es válido.');
    if (owners(env).includes(email)) throw new HttpError(400, 'Esa cuenta ya es owner.');
    const exists = await DB.prepare('SELECT email FROM panel_members WHERE email = ?').bind(email).first();
    const label = 'label' in body ? clean(body.label, 40) : undefined;
    // solo cambiar el nombre
    if (exists && label !== undefined && !body.role_id) {
      await DB.prepare('UPDATE panel_members SET label = ? WHERE email = ?').bind(label || null, email).run();
      return json({ ok: true });
    }
    const role = await DB.prepare('SELECT id, name FROM panel_roles WHERE id = ?').bind(String(body.role_id || '')).first();
    if (!role) throw new HttpError(400, 'Elige un rol.');
    if (exists) await DB.prepare('UPDATE panel_members SET role_id = ?' + (label !== undefined ? ', label = ?' : '') + ' WHERE email = ?').bind(...(label !== undefined ? [role.id, label || null, email] : [role.id, email])).run();
    else await DB.prepare('INSERT INTO panel_members (email, role_id, label, added_by, added_at) VALUES (?, ?, ?, ?, ?)').bind(email, role.id, label || null, s.email, now()).run();
    await audit(env, s, exists ? `Cambió el rol de ${email} a ${role.name}` : `Añadió a ${email}${label ? ' (' + label + ')' : ''} como ${role.name}`);
    return json({ ok: true });
  }
  if (p === '/api/team/members' && m === 'DELETE') {
    const email = String(url.searchParams.get('email') || '').toLowerCase();
    const r = await DB.prepare('DELETE FROM panel_members WHERE email = ?').bind(email).run();
    if (!r.meta.changes) throw new HttpError(404, 'Esa persona ya no estaba en el equipo.');
    await DB.prepare('DELETE FROM panel_sessions WHERE email = ?').bind(email).run();
    await audit(env, s, `Quitó a ${email} del equipo`);
    return json({ ok: true });
  }
  if (p === '/api/team/roles' && m === 'POST') {
    const name = clean(body.name, 40);
    if (!name) throw new HttpError(400, 'Ponle un nombre al rol.');
    if (/^owner$/i.test(name)) throw new HttpError(400, '«Owner» está reservado.');
    const id = body.id ? String(body.id) : 'r_' + randomToken().slice(0, 10);
    const dup = await DB.prepare('SELECT id FROM panel_roles WHERE lower(name) = lower(?) AND id != ?').bind(name, id).first();
    if (dup) throw new HttpError(400, `Ya hay un rol llamado ${name}.`);
    const perms = JSON.stringify(normPerms(body.perms));
    if (body.id) {
      const r = await DB.prepare('UPDATE panel_roles SET name = ?, perms = ?, updated_at = ? WHERE id = ?').bind(name, perms, now(), id).run();
      if (!r.meta.changes) throw new HttpError(404, 'Ese rol ya no existe.');
    } else await DB.prepare('INSERT INTO panel_roles (id, name, perms, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, perms, now(), now()).run();
    await audit(env, s, `${body.id ? 'Cambió' : 'Creó'} el rol ${name}`);
    return json({ ok: true, id });
  }
  if (p === '/api/team/roles' && m === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    const used = await DB.prepare('SELECT COUNT(*) AS n FROM panel_members WHERE role_id = ?').bind(id).first();
    if (used?.n) throw new HttpError(409, `Hay ${used.n} ${used.n === 1 ? 'persona' : 'personas'} con este rol. Cámbiales el rol antes de eliminarlo.`);
    const role = await DB.prepare('SELECT name FROM panel_roles WHERE id = ?').bind(id).first();
    if (!role) throw new HttpError(404, 'Ese rol ya no existe.');
    await DB.prepare('DELETE FROM panel_roles WHERE id = ?').bind(id).run();
    await audit(env, s, `Eliminó el rol ${role.name}`);
    return json({ ok: true });
  }
  throw new HttpError(404, 'No encontrado.');
}

/* ---------------- Chat del equipo ---------------- */
async function chat(req, env, s, url) {
  if (s.sync) throw new HttpError(403, 'No permitido.');   // todo el equipo tiene el chat
  const DB = env.DB;
  if (req.method === 'GET') {
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const rows = after
      ? (await DB.prepare('SELECT id, at, email, name, picture, text, deleted FROM chat_messages WHERE id > ? ORDER BY id LIMIT 200').bind(after).all()).results
      : (await DB.prepare('SELECT * FROM (SELECT id, at, email, name, picture, text, deleted FROM chat_messages ORDER BY id DESC LIMIT 150) ORDER BY id').all()).results;
    // borrados recientes (para quitarlos de la pantalla de quien ya los tenía)
    const gone = after ? (await DB.prepare('SELECT id FROM chat_messages WHERE deleted = 1 AND id <= ? AND id > ? - 300').bind(after, after).all()).results.map(r => r.id) : [];
    return json({ me: s.email, owner: !!s.owner, messages: rows.filter(r => !r.deleted).map(({ deleted, ...r }) => r), gone });
  }
  if (req.method === 'POST') {
    const b = parse(await req.text()) || {};
    const text = String(b.text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 1000);
    if (!text) throw new HttpError(400, 'Escribe algo.');
    const r = await DB.prepare('INSERT INTO chat_messages (at, email, name, picture, text) VALUES (?, ?, ?, ?, ?)').bind(now(), s.email, s.name || '', s.picture || '', text).run();
    return json({ id: r.meta.last_row_id });
  }
  if (req.method === 'DELETE') {
    const id = Number(url.searchParams.get('id')) || 0;
    const m = await DB.prepare('SELECT email FROM chat_messages WHERE id = ?').bind(id).first();
    if (!m) throw new HttpError(404, 'Ese mensaje ya no existe.');
    if (m.email !== s.email && !s.owner) throw new HttpError(403, 'Solo puedes borrar tus mensajes.');
    await DB.prepare('UPDATE chat_messages SET deleted = 1, text = \'\' WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  throw new HttpError(405, 'No permitido.');
}

/* ---------------- API ---------------- */
async function api(req, env, p) {
  const url = new URL(req.url);
  // Mismo origen siempre (la web y el panel están en el mismo dominio): se rechazan peticiones de otras webs
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin && !(env.DEV_LOGIN === '1' && isDevOrigin(origin))) throw new HttpError(403, 'Origen no permitido.');
  if (p === '/api/auth/config' && req.method === 'GET') return json({ clientId: env.GOOGLE_CLIENT_ID || '', dev: env.DEV_LOGIN === '1' });
  await ensureSchema(env);
  const area = a => (a === 'admin' ? 'admin' : 'team');
  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = parse(await req.text()) || {};
    return json(await startSession(env, await verifyGoogle(b.credential, env), area(b.area)));
  }
  // Solo para probar en el ordenador (wrangler dev con DEV_LOGIN=1): entrar sin Google
  if (p === '/api/auth/dev' && req.method === 'POST') {
    if (env.DEV_LOGIN !== '1') throw new HttpError(404, 'No encontrado.');   // DEV_LOGIN solo existe en .dev.vars (local)
    const b = parse(await req.text()) || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'Email no válido.');
    return json(await startSession(env, { email, name: clean(b.name || email.split('@')[0], 80), picture: '' }, area(b.area)));
  }
  const s = await session(req, env);
  if (p === '/api/auth/me' && req.method === 'GET') return json({ user: userOut(s), sections: SECTIONS });
  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (!s.sync) await env.DB.prepare('DELETE FROM panel_sessions WHERE hash = ?').bind(s.hash).run();
    return json({ ok: true });
  }
  if (p === '/api/data' && req.method === 'GET') {
    if (!s.sync && !anyCan(s, 'view')) throw new HttpError(403, 'Tu rol todavía no tiene secciones.');
    return json({ ...await readData(env), files: await fileList(env) });
  }
  if (p === '/api/publish' && req.method === 'POST') return publish(req, env, s);
  if (p === '/api/chat') return chat(req, env, s, url);
  if (p === '/api/team' || p.startsWith('/api/team/')) return team(req, env, s, p);
  throw new HttpError(404, 'No encontrado.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p.startsWith('/api/')) return await api(req, env, p);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = p.slice(1);
        if (BY_FILE[file]) { await ensureSchema(env); return await serveData(BY_FILE[file], req, env); }
        const a = p.match(/^\/assets\/([\w-][\w.-]{0,80})$/);
        if (a) return await serveFile(decodeURIComponent(a[1]), req, env);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, 'Error del servidor. Inténtalo otra vez.');
    }
  },
};
