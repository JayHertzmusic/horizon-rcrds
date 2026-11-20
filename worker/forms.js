/* Formularios de la web (sustituyen a los de Google Forms).
   - Owners: crean, editan, ordenan y borran formularios; eligen quién ve las respuestas (roles o personas).
   - Cada formulario tiene "Link público" (se puede rellenar en /forms/<slug>) y "En la web" (sale como botón en la portada).
   - Las respuestas solo las ven los owners y quien tenga acceso a ese formulario. */

const TYPES = ['text', 'textarea', 'email', 'url', 'radio', 'checkbox', 'select', 'section'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;

export class FormError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const now = () => Date.now();
import { demoReplyMail } from './contract-mail.js';

export const FORM_SCHEMA = [
  // respuestas por correo a una respuesta del formulario (demos: aceptada / rechazada)
  `CREATE TABLE IF NOT EXISTS form_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, response_id INTEGER NOT NULL, form_id TEXT NOT NULL, kind TEXT NOT NULL,
     to_email TEXT, subject TEXT, body TEXT, at INTEGER NOT NULL, by TEXT, by_name TEXT)`,
  `CREATE INDEX IF NOT EXISTS form_replies_resp ON form_replies (response_id, id)`,
  `CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT, fields TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, on_site INTEGER NOT NULL DEFAULT 0, button TEXT, access TEXT NOT NULL DEFAULT '{}', created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS form_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, form_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS form_responses_form ON form_responses (form_id, id)`,
  // respuestas que la web copió a Google Forms (para no volver a meterlas cuando Google las devuelve)
  `CREATE TABLE IF NOT EXISTS gform_sent (hash TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gform_trash (google_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // respuestas borradas en la web que el script tiene que borrar también en su Google Form (cada 5 min)
  `CREATE TABLE IF NOT EXISTS gform_del (id INTEGER PRIMARY KEY AUTOINCREMENT, google_id TEXT NOT NULL, at INTEGER NOT NULL, answers TEXT NOT NULL, name TEXT, title TEXT, created_at INTEGER NOT NULL)`,
  // enlaces personales (formularios privados como el Release Form): un enlace = una persona, un envío, 30 días
  `CREATE TABLE IF NOT EXISTS form_links (hash TEXT PRIMARY KEY, form_id TEXT NOT NULL, note TEXT, created_by TEXT, created_at INTEGER, expires_at INTEGER, device TEXT, opened_at INTEGER, used_at INTEGER, response_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS form_links_form ON form_links (form_id, created_at)`,
  // «visto» de cada persona del team (cada uno tiene sus respuestas nuevas). email '*' = vista por todos (las de antes de esto)
  `CREATE TABLE IF NOT EXISTS form_seen (response_id INTEGER NOT NULL, email TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (response_id, email))`,
  `INSERT OR IGNORE INTO form_seen (response_id, email, at) SELECT id, '*', at FROM form_responses WHERE seen = 1`,
  `UPDATE form_responses SET seen = 0 WHERE seen = 1`,
];
// ¿la ha visto esta persona? (SQL; el ? es su correo)
const SEEN_SQL = `EXISTS (SELECT 1 FROM form_seen x WHERE x.response_id = r.id AND x.email IN ('*', ?))`;
// cómo se llama una respuesta en el historial: «#12 (Artista - Track)», como en la cabecera del panel
// borrar un formulario entero: sus respuestas, quién las vio y sus enlaces personales (antes se quedaban sueltos en la base)
const dropForm = (DB, id) => DB.batch([
  DB.prepare('DELETE FROM form_seen WHERE response_id IN (SELECT id FROM form_responses WHERE form_id = ?)').bind(id),
  DB.prepare('DELETE FROM form_responses WHERE form_id = ?').bind(id),
  DB.prepare('DELETE FROM form_links WHERE form_id = ?').bind(id),
  DB.prepare('DELETE FROM forms WHERE id = ?').bind(id),
]);
// plantillas de respuesta (demos). {artist} y {track} se cambian por los de cada respuesta.
const REPLY_DEFAULTS = {
  accept: { subject: 'Your demo “{track}” — HORIZON RCRDS',
    body: 'Hi {artist},\n\nThank you for sending us “{track}”. We listened to it and we love it — we would like to release it on HORIZON RCRDS.\n\nWe will get back to you very soon with the next steps.\n\nBest,\nHORIZON RCRDS' },
  reject: { subject: 'Your demo “{track}” — HORIZON RCRDS',
    body: 'Hi {artist},\n\nThank you for sending us “{track}” and for thinking of HORIZON RCRDS. We listened to it carefully, but it is not the right fit for the label at the moment.\n\nPlease keep sending us your music — we would love to hear what you make next.\n\nBest,\nHORIZON RCRDS' },
};
async function replyTemplates(env, fid) {
  const saved = parse((await env.DB.prepare('SELECT value FROM panel_settings WHERE key = ?').bind('reply_tpl_' + fid).first())?.value) || {};
  const out = {};
  for (const k of ['accept', 'reject']) out[k] = { subject: saved[k]?.subject || REPLY_DEFAULTS[k].subject, body: saved[k]?.body || REPLY_DEFAULTS[k].body };
  return out;
}
const emailOf = (f, d) => {
  const qs = (parse(f.fields) || []).filter(x => x.type !== 'section');
  const x = qs.find(q => q.type === 'email' && /@/.test(String(d[q.id] || ''))) || qs.find(q => /e-?mail/i.test(q.label) && /@/.test(String(d[q.id] || '')));
  const e = x ? String(d[x.id]).trim() : '';
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e) ? e : '';
};

async function respName(DB, f, rid) {
  const r = await DB.prepare('SELECT data, (SELECT COUNT(*) FROM form_responses WHERE form_id = ? AND id <= ?) AS n FROM form_responses WHERE id = ?').bind(f.id, rid, rid).first();
  if (!r) return `#${rid}`;
  const d = parse(r.data) || {}, qs = (parse(f.fields) || []).filter(x => x.type !== 'section');
  const val = x => (Array.isArray(d[x.id]) ? d[x.id].join(', ') : String(d[x.id] || '')).trim();
  const who = qs.find(x => /artist|team/i.test(x.label) && val(x)) || qs.find(x => /name/i.test(x.label) && val(x));
  const what = qs.find(x => /track|song|title/i.test(x.label) && x !== who && val(x));
  const label = [who && val(who), what && val(what)].filter(Boolean).join(' - ').slice(0, 120);
  return `#${r.n}${label ? ` (${label})` : ''}`;
}
// quién del team ha visto cada respuesta: nombre del team, foto y color (como en el panel)
async function seenBy(DB, ids) {
  if (!ids.length) return {};
  const rows = (await DB.prepare(`SELECT x.response_id AS rid, x.email, x.at,
      COALESCE(m.label, (SELECT ps.name FROM panel_sessions ps WHERE ps.email = x.email AND length(ps.name) > 0 ORDER BY ps.created_at DESC LIMIT 1), m.name) AS name,
      COALESCE(CASE WHEN p.avatar IS NOT NULL THEN '/api/public/avatar/' || p.avatar END, m.picture, (SELECT ps.picture FROM panel_sessions ps WHERE ps.email = x.email AND length(ps.picture) > 0 ORDER BY ps.created_at DESC LIMIT 1)) AS picture,
      COALESCE(p.color, m.color) AS color
    FROM form_seen x LEFT JOIN panel_members m ON m.email = x.email LEFT JOIN panel_profiles p ON p.email = x.email
    WHERE x.email <> '*' AND x.at > 0 AND x.response_id IN (SELECT value FROM json_each(?)) ORDER BY x.at`).bind(JSON.stringify(ids)).all()).results;
  const out = {};
  for (const r of rows) (out[r.rid] = out[r.rid] || []).push({ email: r.email, name: r.name || r.email.split('@')[0], picture: r.picture || '', color: r.color || '', at: r.at });
  return out;
}
const LINK_DAYS = 30;
const sha = async v => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map(b => b.toString(16).padStart(2, '0')).join('');
// código de los enlaces personales: corto (10 letras, sin las que se confunden: 0 O 1 l I), unos 3·10¹⁷ posibles
const SHORT = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const shortToken = () => [...crypto.getRandomValues(new Uint8Array(10))].map(b => SHORT[b % SHORT.length]).join('');
const linkToken = () => { const u = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
// estado de un enlace personal para mostrarlo en el panel
const linkState = l => l.revoked ? 'revoked' : l.used_at ? 'sent' : l.expires_at < now() ? 'expired' : l.opened_at ? 'opened' : 'unused';
// grp = collab (los enlaces de un mismo release con 2-3 artistas), grp_pos 1 = artista principal, gsent = ya copiada a Google
export const FORM_LINK_COLUMNS = ['token TEXT', 'revoked INTEGER NOT NULL DEFAULT 0', 'grp TEXT', 'grp_pos INTEGER', 'grp_n INTEGER', 'gsent INTEGER'];

/* Varios artistas en un release: un enlace por artista, agrupados (grp). Cada uno rellena el formulario completo. */
// demos: qué pregunta es el nombre del artista y cuál el email (para pedir el email de cada artista de una colaboración)
const multiOf = f => {
  if (!/demo/i.test(f.slug || '')) return null;
  const qs = (parse(f.fields) || []).filter(x => x.type !== 'section');
  const artist = qs.find(x => x.type === 'text' && /artist/i.test(x.label || '')), email = qs.find(x => x.type === 'email');
  return artist && email ? { artist: artist.id, email: email.id } : null;
};
// enlaces personales de un release (uno por artista; con varios, agrupados y el primero es el principal)
async function makeLinks(DB, f, names, by, origin) {
  const t = now(), grp = names.length > 1 ? linkToken().slice(0, 16) : null, made = [], hashes = [];
  for (let i = 0; i < names.length; i++) {
    const tok = shortToken(), hash = await sha(tok);
    await DB.prepare('INSERT INTO form_links (hash, form_id, note, created_by, created_at, expires_at, token, grp, grp_pos, grp_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(hash, f.id, names[i], by, t, t + LINK_DAYS * 864e5, tok, grp, grp ? i + 1 : null, grp ? names.length : null).run();
    made.push({ note: names[i], url: `${origin}/r/${tok}` }); hashes.push(hash);   // enlace corto: horizonrcrds.com/r/<código>
  }
  return { links: made, hashes, expires_at: t + LINK_DAYS * 864e5 };
}
// enlace corto /r/<código> → a qué formulario va (null si no existe)
export async function shortLinkForm(env, k) {
  if (!/^[\w-]{10,64}$/.test(k)) return null;
  const r = await env.DB.prepare('SELECT f.slug FROM form_links l JOIN forms f ON f.id = l.form_id WHERE l.hash = ?').bind(await sha(k)).first();
  return r?.slug || null;
}
const siteOrigin = url => /(^|\.)horizonrcrds\.com$/.test(url.hostname) ? 'https://horizonrcrds.com' : url.origin;

/* ---------- Conexión con Google Forms (script de Apps Script en la cuenta de Horizon) ----------
   - Google → web: cada respuesta de un Google Form llega aquí y se guarda en su formulario de la web.
   - Web → Google: cada respuesta de la web se copia a su Google Form (copia de seguridad).
   Las preguntas se emparejan por su texto. Clave compartida: secreto GFORM_SECRET. */
const normQ = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const answerKey = v => Array.isArray(v) ? v.map(x => String(x).trim()).sort().join('|') : String(v ?? '').trim();
async function respHash(formId, data) {
  // (las preguntas sin contestar no cuentan: Google no las devuelve)
  const body = formId + '\n' + Object.keys(data).filter(k => answerKey(data[k]) !== '').sort().map(k => k + '=' + answerKey(data[k])).join('\n');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// firma de las preguntas (para saber si cambiaron desde la última sincronización)
async function structSig(description, fields) {
  const norm = (Array.isArray(fields) ? fields : []).map(x => [['email', 'url'].includes(x.type) ? 'text' : x.type, normQ(x.label), String(x.help || '').trim(), !!x.required, (x.options || []).map(o => String(o).trim()), !!x.other]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([String(description || '').trim(), norm]))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// preguntas de Google sobre las de la web: se conservan los ids (y email/link) de las que ya existían
function mergeFields(web, google) {
  const left = [...web], used = new Set(web.map(x => x.id));
  let n = web.length + 1;
  const out = (Array.isArray(google) ? google : []).map(gq => {
    const k = left.findIndex(w => normQ(w.label) === normQ(gq.label) && (w.type === 'section') === (gq.type === 'section'));
    const old = k >= 0 ? left.splice(k, 1)[0] : null;
    let id = old?.id;
    // pregunta nueva: un id que no se repite nunca (uno de una pregunta borrada mezclaría sus respuestas antiguas)
    if (!id) { do { id = 'q' + Date.now().toString(36) + (n++).toString(36); } while (used.has(id)); used.add(id); }
    const type = old && ['email', 'url'].includes(old.type) && gq.type === 'text' ? old.type : gq.type;
    return { ...gq, id, type, ...(old?.important ? { important: true } : {}) };   // (la nota en rojo es solo de la web: se conserva)
  });
  return normFields(out);
}
// enlazar un formulario de la web con su Google Form (números de las preguntas y firmas de ambos lados)
async function linkGoogle(DB, f, g) {
  const fields = (parse(f.fields) || []).filter(x => x.type !== 'section'), byQ = new Map(fields.map(x => [normQ(x.label), x]));
  const map = {}, missing = [];
  for (const it of Array.isArray(g.fields) ? g.fields : []) {
    if (it.type === 'section') continue;
    const x = byQ.get(normQ(it.label));
    if (x && /^\d+$/.test(String(it.entry || ''))) map[x.id] = String(it.entry); else missing.push(String(it.label).slice(0, 80));
  }
  const url2 = String(g.responseUrl || '');
  const google = { id: String(g.googleId || '').slice(0, 100), url: /^https:\/\/docs\.google\.com\/forms\/(u\/\d+\/)?d\/e\/[\w-]+\/formResponse$/.test(url2) ? url2 : '', map,
    gsig: await structSig(g.description, g.fields), wsig: await structSig(f.description, parse(f.fields) || []) };
  await DB.prepare('UPDATE forms SET google = ? WHERE id = ?').bind(JSON.stringify(google), f.id).run();
  return { matched: Object.keys(map).length, notInWeb: missing, notInGoogle: fields.filter(x => !map[x.id]).map(x => x.label.slice(0, 80)) };
}
const okSecret = (env, s) => !!env.GFORM_SECRET && typeof s === 'string' && s.length === env.GFORM_SECRET.length && s === env.GFORM_SECRET;

export async function gformHook(req, env, url) {
  const DB = env.DB, b = parse(await req.text()) || {};
  if (!okSecret(env, b.secret)) throw new FormError(403, 'Not allowed.');
  if (url.pathname === '/api/hooks/gform/setup') {
    // el script manda cada Google Form con sus preguntas; se enlazan sin cambiar nada (punto de partida)
    const report = [];
    for (const g of (Array.isArray(b.forms) ? b.forms : []).slice(0, 30)) {
      const f = await DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(String(g.slug || '')).first();
      if (!f) { report.push({ slug: g.slug, error: 'no web form with that link' }); continue; }
      report.push({ slug: g.slug, ...await linkGoogle(DB, f, g) });
    }
    // desde ahora, los formularios nuevos de la web se crean también en Google (los de antes, no: así no hay duplicados)
    await DB.prepare("INSERT INTO panel_settings (key, value) VALUES ('gform_setup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now())).run();
    return { ok: true, report };
  }
  if (url.pathname === '/api/hooks/gform/sync') {
    // cada 5 min: el script manda cómo están los Google Forms; la web aplica los cambios de Google y devuelve
    // lo que el script tiene que hacer en Google (cambios hechos en la web, formularios nuevos o borrados)
    const reported = new Map((Array.isArray(b.forms) ? b.forms : []).map(g => [String(g.googleId || ''), g]));
    const ops = [], log = [];
    const since = Number((await DB.prepare("SELECT value FROM panel_settings WHERE key = 'gform_setup_at'").first())?.value) || Infinity;
    for (const f of (await DB.prepare('SELECT * FROM forms ORDER BY position').all()).results) {
      const g = parse(f.google), web = parse(f.fields) || [];
      if (!g?.id) { if ((f.created_at || 0) > since) ops.push({ op: 'upsert', slug: f.slug, googleId: null, title: f.title, description: f.description || '', fields: web }); continue; }
      const r = reported.get(g.id);
      if (!r) continue;
      if (r.trashed) {   // en la papelera de Google → se borra también aquí
        const n = (await DB.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').bind(f.id).first()).n;
        await dropForm(DB, f.id);
        await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(now(), 'google', 'Google Forms', `Deleted the form “${f.title}” (${n} responses): it was deleted in Google Forms`, '').run();
        log.push(`deleted ${f.slug}`); continue;
      }
      const wNow = await structSig(f.description, web), gNow = await structSig(r.description, r.fields);
      // la web manda; cada pregunta lleva su número de Google («entry») para que el script la cambie aunque tenga otro título (si no, la borraría y se perderían sus respuestas en Google)
      if (g.wsig !== wNow) ops.push({ op: 'upsert', slug: f.slug, googleId: g.id, title: f.title, description: f.description || '', fields: web.map(x => g.map?.[x.id] ? { ...x, entry: String(g.map[x.id]) } : x) });
      else if (g.gsig !== gNow) {   // cambió en Google → se aplica aquí
        const merged = mergeFields(web, r.fields);
        await DB.prepare('UPDATE forms SET fields = ?, description = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(merged), clean(r.description, 4000), now(), f.id).run();
        await linkGoogle(DB, { ...f, fields: JSON.stringify(merged), description: clean(r.description, 4000) }, r);
        await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(now(), 'google', 'Google Forms', `Updated the questions of “${f.title}” from Google Forms`, '').run();
        log.push(`updated ${f.slug}`);
      } else await linkGoogle(DB, f, r);   // mismos datos: solo se refrescan los números de las preguntas
    }
    // formularios borrados en la web → a la papelera de Google
    for (const t of (await DB.prepare('SELECT google_id FROM gform_trash').all()).results) ops.push({ op: 'trash', googleId: t.google_id });
    // respuestas borradas en la web → el script busca la misma en el Google Form (por lo que contesta) y la borra
    // las que el script no consigue borrar tras ~1 hora (12 vueltas) dejan de pedirse y se apuntan en History para hacerlo a mano;
    // las que menos se han intentado van primero (antes, 20 atascadas bloqueaban para siempre las nuevas)
    for (const x of (await DB.prepare('SELECT id, name, title FROM gform_del WHERE tries >= 12').all().catch(() => ({ results: [] }))).results) {
      await DB.prepare('DELETE FROM gform_del WHERE id = ?').bind(x.id).run();
      await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(now(), 'google', 'Google Forms', `Could not delete the response ${x.name || ''} in the Google Form “${x.title || ''}” automatically: delete it there by hand`, '').run();
    }
    const delRows = (await DB.prepare('SELECT id, google_id, at, answers FROM gform_del ORDER BY tries, id LIMIT 10').all()).results;
    if (delRows.length) await DB.prepare(`UPDATE gform_del SET tries = tries + 1 WHERE id IN (${delRows.map(() => '?').join(',')})`).bind(...delRows.map(x => x.id)).run();
    const deletes = delRows.map(x => ({ id: x.id, googleId: x.google_id, at: x.at, answers: parse(x.answers) || {} }));
    // demos borradas en su Google Form → también fuera de la web
    let pr;
    try { pr = await pruneDeletedDemos(env); } catch (e) { pr = ['prune: ' + e.message]; }
    log.push(...pr);
    await DB.prepare("INSERT INTO panel_settings (key, value) VALUES ('gform_prune', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ at: now(), log: pr })).run();
    return { ok: true, ops, log, deletes };
  }
  if (url.pathname === '/api/hooks/gform/ack') {
    // el script ya aplicó los cambios: se guarda cómo quedaron los Google Forms
    for (const g of (Array.isArray(b.done) ? b.done : []).slice(0, 30)) {
      const f = await DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(String(g.slug || '')).first();
      if (f) await linkGoogle(DB, f, g);
    }
    for (const id of (Array.isArray(b.trashed) ? b.trashed : []).slice(0, 30)) await DB.prepare('DELETE FROM gform_trash WHERE google_id = ?').bind(String(id)).run();
    for (const x of (Array.isArray(b.deletedResp) ? b.deletedResp : []).slice(0, 30)) {
      const q = await DB.prepare('SELECT name, title FROM gform_del WHERE id = ?').bind(Number(x?.id) || 0).first();
      if (!q) continue;
      await DB.prepare('DELETE FROM gform_del WHERE id = ?').bind(Number(x.id)).run();
      await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(now(), 'google', 'Google Forms',
        x.found ? `Deleted the response ${q.name || ''} in the Google Form “${q.title || ''}” too` : `Could not find the response ${q.name || ''} in the Google Form “${q.title || ''}” (already deleted there?)`, '').run();
    }
    return { ok: true };
  }
  if (url.pathname === '/api/hooks/gform/response') {
    const gid = String(b.googleId || '');
    const f = gid ? (await DB.prepare('SELECT id, fields, google FROM forms WHERE google IS NOT NULL').all()).results.find(r => (parse(r.google) || {}).id === gid) : null;
    if (!f) throw new FormError(404, 'That Google Form is not connected.');
    const fields = (parse(f.fields) || []).filter(x => x.type !== 'section'), byQ = new Map(fields.map(x => [normQ(x.label), x]));
    const data = {};
    for (const a of Array.isArray(b.answers) ? b.answers : []) {
      const x = byQ.get(normQ(a.title));
      if (!x) continue;
      data[x.id] = Array.isArray(a.value) ? a.value.map(v => clean(v, 300)) : clean(a.value, x.type === 'textarea' ? 8000 : 1000);
    }
    const hash = await respHash(f.id, data);
    // la mandó la web hace poco: ya está guardada
    const sent = await DB.prepare('SELECT at FROM gform_sent WHERE hash = ?').bind(hash).first();
    if (sent && now() - sent.at < 30 * 60e3) return { ok: true, duplicate: true };
    // también es la misma si coincide con una respuesta de la web de hace poco en todo lo que trae
    // (Google a veces se queda solo con una parte, p. ej. la primera página de un formulario de varias páginas)
    const recent = (await DB.prepare("SELECT data FROM form_responses WHERE form_id = ? AND ip <> 'google' AND at > ? ORDER BY id DESC LIMIT 20").bind(f.id, now() - 30 * 60e3).all()).results.map(x => parse(x.data) || {});
    const same = (a, b) => JSON.stringify(Array.isArray(a) ? [...a].sort() : String(a ?? '').trim()) === JSON.stringify(Array.isArray(b) ? [...b].sort() : String(b ?? '').trim());
    const keys = Object.keys(data).filter(k => Array.isArray(data[k]) ? data[k].length : data[k]);
    // (con al menos 2 respuestas iguales: una sola coincidencia, p. ej. la misma opción elegida, no basta para tirarla)
    if (keys.length >= 2 && recent.some(w => keys.every(k => same(data[k], w[k])))) return { ok: true, duplicate: true };
    const at = Number(b.at) > 0 && Number(b.at) < now() + 60e3 ? Number(b.at) : now();
    await DB.prepare('INSERT INTO form_responses (form_id, at, data, ip) VALUES (?, ?, ?, ?)').bind(f.id, at, JSON.stringify(data), 'google').run();
    return { ok: true };
  }
  throw new FormError(404, 'Not found.');
}
/* Demos borradas en su Google Form → se borran también de la web (cada sincronización, ~5 min).
   Se leen las respuestas del Google Form (con el script de Horizon) y se emparejan por lo que contestan.
   Seguro: solo se borra una respuesta que ya se vio en Google (o anterior a esto), con más de 1 h, y nunca muchas a la vez. */
const PRUNE_DRY = false;
const PRUNE_FROM = Date.UTC(2026, 10, 20, 12);   // las de antes ya estaban en Google (no hay registro de cuándo se vieron)
const pv = v => (Array.isArray(v) ? v.map(String).sort().join(' | ') : String(v ?? '')).replace(/\s+/g, ' ').trim().toLowerCase();
function looksSame(got, mine) {   // como el script: al menos 2 respuestas iguales y la mayoría de las que se pueden comparar
  let eq = 0, cmp = 0;
  for (const k in mine) { const a = got[k], b = mine[k]; if (!a || !b) continue; cmp++; if (a === b) eq++; }
  return cmp >= 2 && eq >= Math.max(2, Math.ceil(cmp * 0.6));
}
async function pruneDeletedDemos(env) {
  const DB = env.DB, out = [];
  const forms = (await DB.prepare('SELECT id, slug, title, fields, google FROM forms WHERE google IS NOT NULL').all()).results.filter(f => /demo/i.test(f.slug) && parse(f.google)?.id);
  if (!forms.length) return out;
  // el script de Google (cuenta de Horizon) lista las respuestas del Google Form: «orphans» sin filas = todas, con sus 4 primeras respuestas
  if (!env.GSCRIPT_URL || !env.GFORM_SECRET) return out;
  for (const f of forms) {
    const gid = parse(f.google).id, fields = (parse(f.fields) || []).filter(x => x.type !== 'section');
    const r = await fetch(env.GSCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.GFORM_SECRET, action: 'orphans', googleId: gid, rows: [] }), redirect: 'follow' });
    const j = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j?.orphans)) throw new Error(`Google script ${r.status} ${j?.error || ''}`.trim());
    const got = j.orphans.map(x => {
      const o = {};
      for (const part of String(x.sample || '').split(' | ')) { const i = part.indexOf(': '); if (i > 0) o[normQ(part.slice(0, i))] = pv(part.slice(i + 2)); }
      return o;
    });
    const rows = (await DB.prepare('SELECT id, at, data, gseen FROM form_responses WHERE form_id = ?').bind(f.id).all()).results;
    if (!rows.length) continue;
    const seen = [], gone = [];
    for (const r of rows) {
      const d = parse(r.data) || {}, mine = {};
      for (const x of fields) if (d[x.id] != null) mine[normQ(x.label)] = pv(String(d[x.id]).slice(0, 60));
      if (got.some(g => looksSame(g, mine))) seen.push(r.id);
      else if ((r.gseen || r.at < PRUNE_FROM) && now() - r.at > 3600e3) gone.push(r);
    }
    if (seen.length) await DB.prepare(`UPDATE form_responses SET gseen = ? WHERE id IN (${seen.map(() => '?').join(',')})`).bind(now(), ...seen).run();
    // si casi nada coincide, algo no cuadra (Google no respondió bien, preguntas cambiadas…): no se borra nada
    if (!gone.length) { out.push(`prune ${f.slug}: ok (${seen.length}/${rows.length} found, ${got.length} in Google)`); continue; }
    if (!got.length || gone.length > 3 || seen.length < rows.length * 0.5) { out.push(`prune ${f.slug}: skipped (${gone.length} missing, ${seen.length}/${rows.length} found)`); continue; }
    if (PRUNE_DRY) { out.push(`prune ${f.slug}: would delete ${gone.map(r => r.id).join(', ')} (${seen.length}/${rows.length} found, ${got.length} in Google)`); continue; }
    for (const r of gone) {
      const name = await respName(DB, f, r.id);
      await DB.batch([DB.prepare('DELETE FROM form_responses WHERE id = ? AND form_id = ?').bind(r.id, f.id), DB.prepare('DELETE FROM form_seen WHERE response_id = ?').bind(r.id), DB.prepare('DELETE FROM form_replies WHERE response_id = ?').bind(r.id)]);
      await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(now(), 'google', 'Google Forms', `Deleted the response ${name} from the form “${f.title}”: it was deleted in the Google Form`, '').run();
      out.push(`prune ${f.slug}: deleted ${r.id}`);
    }
  }
  return out;
}
// copia de una respuesta de la web en su Google Form
async function toGoogle(env, f, data) {
  const g = parse(f.google);
  if (!g?.url || !g.map || !/^https:\/\/docs\.google\.com\/forms\//.test(g.url)) return;   // (solo a Google Forms)
  const body = new URLSearchParams(), defs = new Map((parse(f.fields) || []).map(x => [x.id, x]));
  for (const [fid, entry] of Object.entries(g.map)) {
    const v = data[fid], x = defs.get(fid), opts = x?.options || [];
    // «Other» con texto propio: Google lo quiere como «__other_option__» + el texto aparte (si no, rechaza la respuesta entera)
    const add = o => {
      if (x?.other && ['radio', 'checkbox'].includes(x.type) && !opts.includes(o)) { body.append('entry.' + entry, '__other_option__'); body.append(`entry.${entry}.other_option_response`, o); }
      else body.append('entry.' + entry, o);
    };
    if (Array.isArray(v)) v.forEach(add);
    else if (v) add(v);
  }
  const hash = await respHash(f.id, data);
  await env.DB.batch([env.DB.prepare('DELETE FROM gform_sent WHERE at < ?').bind(now() - 86400e3), env.DB.prepare('INSERT OR REPLACE INTO gform_sent (hash, at) VALUES (?, ?)').bind(hash, now())]);
  // formularios de Google con varias páginas: hay que decir que se pasó por todas (si no, solo guarda la primera)
  const pages = (parse(f.fields) || []).filter(x => x.type === 'section').length;
  const post = b => fetch(g.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b, redirect: 'manual' });
  let r;
  if (pages) {
    const withPages = new URLSearchParams(body);
    withPages.append('pageHistory', Array.from({ length: pages + 1 }, (_, i) => i).join(','));
    r = await post(withPages);
    if (r.status >= 400) r = await post(body);   // (si alguna sección no es una página nueva, Google no lo acepta: se manda sin)
  } else r = await post(body);
  if (r.status >= 400) console.error('google form copy', f.id, r.status);
}

function normFields(list) {
  if (!Array.isArray(list)) throw new FormError(400, 'The questions are not valid.');
  const ids = new Set();
  return list.slice(0, 80).map((f, i) => {
    const type = TYPES.includes(f?.type) ? f.type : 'text';
    let id = clean(f?.id, 40).replace(/[^\w-]/g, '') || `q${i + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    const out = { id, type, label: clean(f?.label, 300) || (type === 'section' ? 'Section' : 'Question'), help: clean(f?.help, 600) };
    if (type !== 'section') out.required = !!f?.required;
    if (type !== 'section' && out.help && f?.important) out.important = true;   // nota en rojo en el formulario
    if (['radio', 'checkbox', 'select'].includes(type)) {
      out.options = (Array.isArray(f?.options) ? f.options : []).map(o => clean(o, 200)).filter(Boolean).slice(0, 40);
      out.other = !!f?.other && type !== 'select';
    }
    return out;
  });
}
const access = f => { const a = parse(f.access) || {}; return { roles: Array.isArray(a.roles) ? a.roles : [], emails: Array.isArray(a.emails) ? a.emails : [] }; };
// nivel del rol en un formulario: '' | 'view' | 'edit' (roles antiguos sin lista: el nivel de «Forms» en todos)
export function formLevel(s, f) {
  if (s.owner) return 'edit';
  const m = s.role?.forms, base = s.perms?.forms?.edit ? 'edit' : s.perms?.forms?.view ? 'view' : '';
  if (Array.isArray(m)) return m.includes(f.id) ? base : '';
  if (m && typeof m === 'object') return m[f.id] === 'edit' ? 'edit' : m[f.id] === 'view' ? 'view' : '';
  return base;
}
export const canSeeForm = (s, f) => !!s.owner || !!formLevel(s, f) || access(f).roles.includes(s.role?.id) || access(f).emails.includes(s.email);
// respuestas sin ver de esta persona, solo de los formularios que puede ver (aviso rojo del panel; también va en /api/live)
export async function formsUnseen(env, s) {
  const DB = env.DB;
  const [fs, rs] = await Promise.all([
    DB.prepare('SELECT id, access FROM forms').all(),
    DB.prepare(`SELECT r.form_id, COUNT(*) AS n FROM form_responses r WHERE NOT ${SEEN_SQL} GROUP BY r.form_id`).bind(s.email || '').all(),
  ]);
  const forms = fs.results.filter(f => canSeeForm(s, f)).map(f => f.id), rows = rs.results.filter(r => forms.includes(r.form_id));
  return { total: rows.reduce((a, r) => a + r.n, 0), forms: Object.fromEntries(rows.map(r => [r.form_id, r.n])) };
}
export async function formsCount(env, s) {
  if (s.owner) return (await env.DB.prepare('SELECT COUNT(*) AS n FROM forms').first())?.n || 0;
  const rows = (await env.DB.prepare('SELECT id, access FROM forms').all()).results;
  return rows.filter(f => canSeeForm(s, f)).length;
}

async function getForm(env, id) {
  const f = await env.DB.prepare('SELECT * FROM forms WHERE id = ?').bind(id).first();
  if (!f) throw new FormError(404, 'That form no longer exists.');
  return f;
}
function csvCell(v) {
  let s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  // una respuesta que empieza por «=», «@»… Excel/Sheets la ejecutaría como fórmula: se guarda como texto
  if (/^[=@\t\r]|^[+-][^\d\s.]/.test(s)) s = "'" + s;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Panel (con sesión). audit(action) apunta en el historial. */
export async function formsApi(req, env, s, url, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  const ownerOnly = (act = 'edit') => { if (s.sync || !(s.owner || s.perms?.forms?.[act])) throw new FormError(403, 'You do not have permission to change forms.'); };

  // respuestas sin ver (para el aviso del panel), solo de los formularios que esta persona puede ver
  if (p === '/api/forms/unseen' && m === 'GET') return formsUnseen(env, s);
  if (p === '/api/forms' && m === 'GET') {
    const forms = (await DB.prepare('SELECT * FROM forms ORDER BY position, created_at').all()).results.filter(f => canSeeForm(s, f));
    // un rol limitado a algunos formularios no crea nuevos (no los vería)
    const counts = (await DB.prepare(`SELECT r.form_id, COUNT(*) AS total, SUM(CASE WHEN ${SEEN_SQL} THEN 0 ELSE 1 END) AS unseen FROM form_responses r GROUP BY r.form_id`).bind(s.email || '').all()).results;
    return {
      owner: !!s.owner,
      forms: forms.map(f => {
        const c = counts.find(x => x.form_id === f.id) || {};
        return { id: f.id, level: formLevel(s, f) || 'view', slug: f.slug, title: f.title, description: f.description || '', fields: parse(f.fields) || [], public: !!f.public, on_site: !!f.on_site, button: f.button || '', invite: !!f.invite,
          access: s.owner ? access(f) : undefined, total: c.total || 0, unseen: c.unseen || 0, updated_at: f.updated_at };
      }),
    };
  }
  if (p === '/api/forms' && m === 'POST') {
    const b = parse(await req.text()) || {};
    // crear: solo owners; cambiar: quien tenga «Edit» en ese formulario
    if (s.sync) throw new FormError(403, 'Not allowed.');
    if (!s.owner) {
      const cur = b.id ? await DB.prepare('SELECT id, access, public, on_site, button FROM forms WHERE id = ?').bind(String(b.id)).first() : null;
      if (!cur || formLevel(s, cur) !== 'edit') throw new FormError(403, 'Your role can’t edit this form.');
      // abrir / cerrar, salir en la web oficial y el texto de su botón: solo los owners
      Object.assign(b, { public: !!cur.public, on_site: !!cur.on_site, button: cur.button || '' });
    }
    const title = clean(b.title, 140);
    if (!title) throw new FormError(400, 'Give it a title.');
    const slug = clean(b.slug, 60).toLowerCase();
    if (!SLUG.test(slug)) throw new FormError(400, 'The link can only have lowercase letters, numbers and hyphens (e.g. demo-submission).');
    const id = b.id ? String(b.id) : 'f_' + crypto.randomUUID().slice(0, 8);
    const dup = await DB.prepare('SELECT id FROM forms WHERE slug = ? AND id != ?').bind(slug, id).first();
    if (dup) throw new FormError(400, `There is already a form with the link /forms/${slug}.`);
    const fields = JSON.stringify(normFields(b.fields));
    const prev = b.id ? await DB.prepare('SELECT access FROM forms WHERE id = ?').bind(String(b.id)).first() : null;
    const acc = !s.owner ? (prev?.access || '{}') : JSON.stringify({
      roles: (Array.isArray(b.access?.roles) ? b.access.roles : []).map(String).slice(0, 50),
      emails: (Array.isArray(b.access?.emails) ? b.access.emails : []).map(e => String(e).toLowerCase()).slice(0, 100),
    });
    const vals = [slug, title, clean(b.description, 4000), fields, b.public ? 1 : 0, b.on_site ? 1 : 0, clean(b.button, 60), acc, now()];
    if (b.id) {
      const r = await DB.prepare('UPDATE forms SET slug = ?, title = ?, description = ?, fields = ?, public = ?, on_site = ?, button = ?, access = ?, updated_at = ? WHERE id = ?').bind(...vals, id).run();
      if (!r.meta.changes) throw new FormError(404, 'That form no longer exists.');
    } else {
      const pos = (await DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM forms').first()).p;
      await DB.prepare('INSERT INTO forms (slug, title, description, fields, public, on_site, button, access, updated_at, id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...vals, id, pos, now()).run();
    }
    await audit(`${b.id ? 'Changed' : 'Created'} the form “${title}”`);
    return { ok: true, id };
  }
  if (p === '/api/forms/order' && m === 'POST') {
    if (!s.owner || s.sync) throw new FormError(403, 'Only owners can change the order.');
    const ids = (parse(await req.text()) || {}).ids;
    if (!Array.isArray(ids)) throw new FormError(400, 'Invalid order.');
    await DB.batch(ids.slice(0, 200).map((id, i) => DB.prepare('UPDATE forms SET position = ? WHERE id = ?').bind(i + 1, String(id))));
    return { ok: true };
  }
  const mm = p.match(/^\/api\/forms\/([\w-]+)(?:\/(responses|csv|seen|links|replies|reply))?(?:\/(\d+))?$/);
  if (!mm) throw new FormError(404, 'Not found.');
  const f = await getForm(env, mm[1]);
  if (!canSeeForm(s, f)) throw new FormError(403, 'You don’t have access to this form.');
  if (mm[2] === 'links') {
    // enlaces personales: se crea uno nuevo (POST) o se ven los últimos (GET)
    if (!f.invite) throw new FormError(400, 'This form doesn’t use personal links.');
    const canEdit = !s.sync && formLevel(s, f) === 'edit';
    if (m === 'POST') {
      // crear, alargar, anular o borrar enlaces: solo quien puede editar este formulario (con «View» solo se miran)
      if (!canEdit) throw new FormError(403, 'Your role can only view this form’s links.');
      const b = parse(await req.text()) || {};
      // varios a la vez: anular o borrar (hasta 200)
      if (Array.isArray(b.ids) && (b.action === 'delete' || b.action === 'revoke')) {
        const ids = b.ids.map(String).filter(x => /^[a-f0-9]{16}$/.test(x)).slice(0, 200);
        if (!ids.length) throw new FormError(400, 'Choose at least one link.');
        const q = ids.map(() => '?').join(','), where = `form_id = ? AND substr(hash, 1, 16) IN (${q})`;
        const r = b.action === 'delete' ? await DB.prepare(`DELETE FROM form_links WHERE ${where}`).bind(f.id, ...ids).run()
          : await DB.prepare(`UPDATE form_links SET revoked = 1 WHERE ${where} AND used_at IS NULL`).bind(f.id, ...ids).run();
        const n = r.meta.changes || 0;
        await audit(`${b.action === 'delete' ? 'Deleted' : 'Cancelled'} ${n} personal link${n === 1 ? '' : 's'} of “${f.title}”`);
        return { ok: true, done: n };
      }
      if (b.action) {
        // un enlace concreto: alargar 30 días, dejar que se abra en otro dispositivo, anular o borrar
        const id = String(b.id || '');
        if (!/^[a-f0-9]{16}$/.test(id)) throw new FormError(400, 'Invalid link.');
        const l = await DB.prepare("SELECT * FROM form_links WHERE form_id = ? AND substr(hash, 1, 16) = ?").bind(f.id, id).first();
        if (!l) throw new FormError(404, 'That link no longer exists.');
        const who = l.note ? ` (${l.note})` : '';
        if (b.action === 'extend') { await DB.prepare('UPDATE form_links SET expires_at = ?, revoked = 0 WHERE hash = ?').bind(Math.max(now(), l.expires_at) + LINK_DAYS * 864e5, l.hash).run(); await audit(`Extended a personal link of “${f.title}”${who} by 30 days`); }
        else if (b.action === 'reset') { if (l.used_at) throw new FormError(409, 'That link was already used to send the form.'); await DB.prepare('UPDATE form_links SET device = NULL, opened_at = NULL WHERE hash = ?').bind(l.hash).run(); await audit(`Let a personal link of “${f.title}”${who} be opened on a new device`); }
        else if (b.action === 'revoke') { await DB.prepare('UPDATE form_links SET revoked = 1 WHERE hash = ?').bind(l.hash).run(); await audit(`Cancelled a personal link of “${f.title}”${who}`); }
        else if (b.action === 'delete') { await DB.prepare('DELETE FROM form_links WHERE hash = ?').bind(l.hash).run(); await audit(`Deleted a personal link of “${f.title}”${who}`); }
        else throw new FormError(400, 'Invalid action.');
        return { ok: true };
      }
      if (!clean(b.note, 120)) throw new FormError(400, 'Write the artist name first.');   // cada enlace lleva siempre el nombre de para quién es
      // collab: un enlace por artista (el primero es el principal), todos del mismo release
      const list = Array.isArray(b.collab) ? b.collab : [];
      if (list.length > 2) throw new FormError(400, 'A release can have up to 3 artists.');
      const others = list.map(x => clean(x, 120)).filter(Boolean);
      if (others.length !== list.length) throw new FormError(400, 'Write the name of every artist.');
      const names = [clean(b.note, 120), ...others], r = await makeLinks(DB, f, names, s.email, siteOrigin(url));
      await audit(names.length > 1 ? `Created links for “${f.title}” (${names.join(' & ')})` : `Created a personal link for “${f.title}” (${names[0]})`);
      return { ok: true, url: r.links[0].url, links: r.links, expires_at: r.expires_at };
    }
    // quién lo creó, con su nombre del team (el mismo que sale en el panel), no el correo
    const rows = (await DB.prepare(`SELECT l.*, COALESCE(m.label, (SELECT ps.name FROM panel_sessions ps WHERE ps.email = l.created_by AND length(ps.name) > 0 ORDER BY ps.created_at DESC LIMIT 1), m.name) AS by_name
      FROM form_links l LEFT JOIN panel_members m ON m.email = l.created_by WHERE l.form_id = ? ORDER BY l.created_at DESC LIMIT 500`).bind(f.id).all()).results;
    const origin = /(^|\.)horizonrcrds\.com$/.test(url.hostname) ? 'https://horizonrcrds.com' : url.origin;
    return { links: rows.map(l => ({ id: l.hash.slice(0, 16), note: l.note || '', by: l.created_by, by_name: l.by_name || String(l.created_by || '').split('@')[0], created_at: l.created_at, expires_at: l.expires_at, opened_at: l.opened_at, used_at: l.used_at, response_id: l.response_id || null,
      grp: l.grp || null, grp_pos: l.grp_pos || null, grp_n: l.grp_n || null,
      // el enlace (con su clave) solo lo ve quien puede editar: con él se puede enviar el formulario
      state: linkState(l), url: l.token && canEdit ? `${origin}/r/${l.token}` : '' })), canEdit };
  }
  // plantillas para contestar (aceptar / rechazar). Verlas: quien ve el formulario; cambiarlas y enviar: quien lo puede editar.
  if (mm[2] === 'replies' && m === 'GET') return { templates: await replyTemplates(env, f.id) };
  if (mm[2] === 'replies' && m === 'POST') {
    if (s.sync || formLevel(s, f) !== 'edit') throw new FormError(403, 'Your role can’t change the reply templates.');
    const b = parse(await req.text()) || {}, cur = await replyTemplates(env, f.id), out = {};
    for (const k of ['accept', 'reject']) out[k] = { subject: clean(b[k]?.subject, 200) || cur[k].subject, body: clean(b[k]?.body, 5000) || cur[k].body };
    await DB.prepare('INSERT OR REPLACE INTO panel_settings (key, value) VALUES (?, ?)').bind('reply_tpl_' + f.id, JSON.stringify(out)).run();
    await audit(`Changed the reply templates of “${f.title}”`);
    return { ok: true, templates: out };
  }
  if (mm[2] === 'reply' && mm[3] && m === 'POST') {
    if (s.sync || formLevel(s, f) !== 'edit') throw new FormError(403, 'Your role can’t reply to responses here.');
    const rid = Number(mm[3]), b = parse(await req.text()) || {};
    const kind = b.kind === 'accept' ? 'accept' : b.kind === 'reject' ? 'reject' : '';
    if (!kind) throw new FormError(400, 'Accept or reject?');
    const row = await DB.prepare('SELECT data FROM form_responses WHERE id = ? AND form_id = ?').bind(rid, f.id).first();
    if (!row) throw new FormError(404, 'That response no longer exists.');
    const rd = parse(row.data) || {}, main = emailOf(f, rd);
    if (!main) throw new FormError(400, 'This response has no valid email address.');
    // varios artistas: el correo les llega a todos
    const to = [main, ...(Array.isArray(rd._artists) ? rd._artists.map(x => String(x.email || '').trim()).filter(e => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e)) : [])].filter((e, i, a) => a.findIndex(x => x.toLowerCase() === e.toLowerCase()) === i);
    const subject = clean(b.subject, 200);
    let body = clean(b.body, 5000);
    if (!subject || !body) throw new FormError(400, 'Write the subject and the message.');
    // los artistas para los enlaces del Release Form: separados por comas (así un dúo como «Chase & Status» es un solo artista)
    const names = kind === 'accept' && b.links ? clean(b.links_for, 300).split(/\s*[,\n]\s*/).map(x => x.trim()).filter(Boolean).slice(0, 3) : [];
    const rf = names.length ? await DB.prepare("SELECT * FROM forms WHERE slug = 'release-form'").first() : null;
    if (kind === 'accept' && b.links && !names.length) throw new FormError(400, 'Write the artist name(s) for the Release Form links.');
    if (names.length && !rf) throw new FormError(404, 'The Release Form was not found.');
    // se reserva la contestación ANTES de enviar: dos clics o dos personas a la vez no mandan dos correos
    const who = clean(s.name, 120) || String(s.email || '').split('@')[0];
    const claim = await DB.prepare(`INSERT INTO form_replies (response_id, form_id, kind, to_email, subject, body, at, by, by_name)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM form_replies WHERE response_id = ?)`)
      .bind(rid, f.id, kind, to.join(', '), subject, body, now(), s.email || '', who, rid).run();
    if (!claim.meta.changes) throw new FormError(409, 'This demo was already answered.');
    const replyId = claim.meta.last_row_id;
    // aceptar con los enlaces del Release Form (uno por artista), antes de la despedida
    let made = null, hashes = [];
    try {
      if (names.length) {
        const r = await makeLinks(DB, rf, names, s.email, siteOrigin(url));
        made = r.links; hashes = r.hashes;
        const block = `${made.length > 1 ? 'Release Form — each artist fills in their own link:' : 'Release Form — please fill it in here:'}\n${made.map(x => made.length > 1 ? `${x.note}: ${x.url}` : x.url).join('\n')}\n(The link is personal, works once and for 30 days.)`;
        const k = body.search(/\n\s*(best|cheers|thanks|thank you|regards|kind regards)\b[^\n]*\n?[^\n]*$/i);
        body = k >= 0 ? `${body.slice(0, k).trimEnd()}\n\n${block}\n\n${body.slice(k).trimStart()}` : `${body}\n\n${block}`;
      }
      await demoReplyMail(env, to, subject, body);
    } catch (e) {
      // no salió: se deshace todo (la contestación reservada y los enlaces creados), así se puede volver a intentar limpio
      await DB.batch([DB.prepare('DELETE FROM form_replies WHERE id = ?').bind(replyId), ...hashes.map(h => DB.prepare('DELETE FROM form_links WHERE hash = ?').bind(h))]).catch(() => {});
      throw new FormError(502, e.message);
    }
    if (made) await DB.prepare('UPDATE form_replies SET body = ? WHERE id = ?').bind(body, replyId).run();
    await audit(`${kind === 'accept' ? 'Accepted' : 'Rejected'} the response ${await respName(DB, f, rid)} in “${f.title}” (email sent to ${to.join(', ')}${made ? `, with ${made.length} Release Form link${made.length > 1 ? 's' : ''}` : ''})`);
    return { ok: true, reply: { kind, at: now(), by_name: who }, links: made };
  }
  if (!mm[2] && m === 'DELETE') {
    if (!s.owner || s.sync) throw new FormError(403, 'Only owners can delete a form.');
    const n = (await DB.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').bind(f.id).first()).n;
    await dropForm(DB, f.id);
    const gid = (parse(f.google) || {}).id;
    if (gid) await DB.prepare('INSERT OR REPLACE INTO gform_trash (google_id, at) VALUES (?, ?)').bind(gid, now()).run();   // también a la papelera de Google
    await audit(`Deleted the form “${f.title}” (${n} responses)`);
    return { ok: true };
  }
  if (mm[2] === 'responses' && m === 'GET') {
    // Release Form y Demo Submission: la más nueva arriba. El resto: #1 arriba y cada nueva debajo.
    const asc = f.slug !== 'release-form' && !/demo/i.test(f.slug);
    const from = Number(url.searchParams.get('from') || url.searchParams.get('before')) || (asc ? 0 : 9e15);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    // cada respuesta lleva su número (#1 = la primera que llegó), como las filas de Google; se puede buscar por él
    const num = /^#?\d{1,6}$/.test(q) ? Number(q.replace('#', '')) : -1;
    // demos: filtrar por estado (pending = sin contestar; accept / reject = la última contestación)
    const st = url.searchParams.get('status'), stSql = st === 'pending' ? ' AND rk IS NULL' : st === 'accept' ? " AND rk = 'accept'" : st === 'reject' ? " AND rk = 'reject'" : '';
    const base = `WITH t AS (SELECT id, at, data, ROW_NUMBER() OVER (ORDER BY id) AS n, (SELECT x.kind FROM form_replies x WHERE x.response_id = form_responses.id ORDER BY x.id DESC LIMIT 1) AS rk FROM form_responses WHERE form_id = ?) SELECT r.*, ${SEEN_SQL} AS seen FROM t r WHERE id ${asc ? '>' : '<'} ?${stSql}`;
    const tail = ` ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT 101`;
    const rows = (q
      ? await DB.prepare(base + " AND (data LIKE ? ESCAPE '\\' OR n = ?)" + tail).bind(f.id, s.email || '', from, like, num).all()
      : await DB.prepare(base + tail).bind(f.id, s.email || '', from).all()).results;
    const list = rows.slice(0, 100), by = await seenBy(DB, list.map(r => r.id));
    const rep = {};
    if (list.length) for (const x of (await DB.prepare(`SELECT response_id, kind, at, by_name FROM form_replies WHERE response_id IN (${list.map(() => '?').join(',')}) ORDER BY id`).bind(...list.map(r => r.id)).all()).results) rep[x.response_id] = { kind: x.kind, at: x.at, by_name: x.by_name };
    // contadores de las pestañas (solo los formularios de demos las tienen, y solo hacen falta en la primera página)
    const cnt = { pending: 0, accept: 0, reject: 0 };
    if (/demo/i.test(f.slug) && !url.searchParams.get('from') && !url.searchParams.get('before')) for (const c of (await DB.prepare('SELECT rk, COUNT(*) AS n FROM (SELECT (SELECT x.kind FROM form_replies x WHERE x.response_id = r.id ORDER BY x.id DESC LIMIT 1) AS rk FROM form_responses r WHERE r.form_id = ?) GROUP BY rk').bind(f.id).all()).results) cnt[c.rk || 'pending'] = c.n;
    // collab: de qué grupo es cada respuesta, su puesto (1 = principal) y quién es el principal
    const col = {};
    if (list.length) {
      const ls = (await DB.prepare(`SELECT response_id, grp, grp_pos, grp_n, note FROM form_links WHERE grp IS NOT NULL AND response_id IN (${list.map(() => '?').join(',')})`).bind(...list.map(r => r.id)).all()).results;
      const grps = [...new Set(ls.map(x => x.grp))];
      const mates = grps.length ? (await DB.prepare(`SELECT grp, grp_pos, note FROM form_links WHERE grp IN (${grps.map(() => '?').join(',')}) ORDER BY grp_pos`).bind(...grps).all()).results : [];
      for (const x of ls) col[x.response_id] = { grp: x.grp, pos: x.grp_pos, n: x.grp_n, main: mates.find(m => m.grp === x.grp && m.grp_pos === 1)?.note || '',
        with: mates.filter(m => m.grp === x.grp && m.grp_pos !== x.grp_pos).map(m => m.note) };
    }
    return { responses: list.map(r => ({ id: r.id, n: r.n, at: r.at, seen: !!r.seen, seen_by: by[r.id] || [], data: parse(r.data) || {}, reply: rep[r.id] || null, collab: col[r.id] || null })), more: rows.length > 100, asc, counts: cnt };
  }
  if (mm[2] === 'responses' && mm[3] && m === 'POST') {
    // visto / nuevo solo para quien lo pulsa (el resto del team lo sigue viendo como estaba)
    const body = parse(await req.text()) || {}, seen = !!body.seen, rid = Number(mm[3]), me = s.email || '';
    if (!me || s.sync) throw new FormError(403, 'Not allowed.');
    if (!seen && !s.owner) throw new FormError(403, 'Only owners can mark a response as new.');   // el resto del team: visto al abrirla
    if (!await DB.prepare('SELECT 1 FROM form_responses WHERE id = ? AND form_id = ?').bind(rid, f.id).first()) throw new FormError(404, 'That response no longer exists.');
    if (seen) {
      const ins = await DB.prepare('INSERT OR IGNORE INTO form_seen (response_id, email, at) VALUES (?, ?, ?)').bind(rid, me, now()).run();
      if (ins.meta.changes) await audit(body.opened ? `Opened the response ${await respName(DB, f, rid)} in “${f.title}”` : `Marked the response ${await respName(DB, f, rid)} in “${f.title}” as seen`);   // queda constancia en el historial (solo la primera vez)
    }
    else if (await DB.prepare("SELECT 1 FROM form_seen WHERE response_id = ? AND email = '*'").bind(rid).first()) {
      // era «vista por todos» (de antes): sigue vista para los demás del team, nueva solo para ti
      const team = new Set([...String(env.OWNER_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean), ...(await DB.prepare('SELECT email FROM panel_members').all()).results.map(x => x.email)]);
      team.delete(me);
      await DB.batch([DB.prepare("DELETE FROM form_seen WHERE response_id = ? AND email IN ('*', ?)").bind(rid, me), ...[...team].map(e => DB.prepare('INSERT OR IGNORE INTO form_seen (response_id, email, at) VALUES (?, ?, ?)').bind(rid, e, 0))]);
    } else await DB.prepare('DELETE FROM form_seen WHERE response_id = ? AND email = ?').bind(rid, me).run();
    if (!seen) await audit(`Marked the response ${await respName(DB, f, rid)} in “${f.title}” as new`);
    return { ok: true, seen, seen_by: (await seenBy(DB, [rid]))[rid] || [] };
  }
  if (mm[2] === 'seen' && m === 'POST') {
    if (!s.email || s.sync || !s.owner) throw new FormError(403, 'Only owners can mark everything as seen.');
    const all = await DB.prepare('INSERT OR IGNORE INTO form_seen (response_id, email, at) SELECT id, ?, ? FROM form_responses WHERE form_id = ?').bind(s.email, now(), f.id).run();
    if (all.meta.changes) await audit(`Marked ${all.meta.changes} response${all.meta.changes > 1 ? 's' : ''} in “${f.title}” as seen`);
    return { ok: true };
  }
  if (mm[2] === 'responses' && mm[3] && m === 'DELETE') {
    if (s.sync || formLevel(s, f) !== 'edit') throw new FormError(403, 'Your role can’t delete responses here.');
    const name = await respName(DB, f, Number(mm[3]));   // «#n (Artista - Track)», antes de borrarla
    const row = await DB.prepare('SELECT at, data FROM form_responses WHERE id = ? AND form_id = ?').bind(Number(mm[3]), f.id).first();
    const r = await DB.prepare('DELETE FROM form_responses WHERE id = ? AND form_id = ?').bind(Number(mm[3]), f.id).run();
    if (!r.meta.changes) throw new FormError(404, 'That response no longer exists.');
    // también en su Google Form (lo borra el script en la siguiente sincronización, como mucho 5 min)
    const gid = (parse(f.google) || {}).id;
    if (gid && row) {
      const d = parse(row.data) || {}, answers = {};
      for (const x of parse(f.fields) || []) if (x.type !== 'section' && d[x.id] != null && d[x.id] !== '' && !(Array.isArray(d[x.id]) && !d[x.id].length)) answers[x.label] = d[x.id];
      await DB.prepare('INSERT INTO gform_del (google_id, at, answers, name, title, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(gid, row.at, JSON.stringify(answers), name, f.title, now()).run();
    }
    await DB.batch([DB.prepare('DELETE FROM form_seen WHERE response_id = ?').bind(Number(mm[3])), DB.prepare('DELETE FROM form_replies WHERE response_id = ?').bind(Number(mm[3]))]);
    await audit(`Deleted the response ${name} from the form “${f.title}”`);
    return { ok: true };
  }
  if (mm[2] === 'csv' && m === 'GET') {
    const fields = (parse(f.fields) || []).filter(x => x.type !== 'section');
    const rows = (await DB.prepare('SELECT at, data FROM form_responses WHERE form_id = ? ORDER BY id').bind(f.id).all()).results;
    // «#» = el mismo número que en el panel (#1 = la primera que llegó)
    const lines = [['#', 'Date (UTC)', ...fields.map(x => x.label)].map(csvCell).join(',')];
    rows.forEach((r, i) => { const d = parse(r.data) || {}; lines.push([i + 1, new Date(r.at).toISOString().replace('T', ' ').slice(0, 16), ...fields.map(x => d[x.id])].map(csvCell).join(',')); });
    await audit(`Downloaded the responses of “${f.title}”`);
    return new Response('﻿' + lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.slug}.csv"`, 'Cache-Control': 'no-store' } });
  }
  throw new FormError(404, 'Not found.');
}

/* Público (sin sesión): ver un formulario abierto, enviarlo, y la lista de los que salen en la web. */
export async function publicFormsApi(req, env, url) {
  const DB = env.DB, p = url.pathname;
  if (p === '/api/public/site-forms' && req.method === 'GET') {
    const rows = (await DB.prepare('SELECT slug, title, button FROM forms WHERE public = 1 AND on_site = 1 ORDER BY position').all()).results;
    return { forms: rows.map(r => ({ slug: r.slug, title: r.title, button: r.button || r.title })) };
  }
  const mm = p.match(/^\/api\/public\/forms\/([a-z0-9-]+)$/);
  if (!mm) throw new FormError(404, 'Not found.');
  const f = await DB.prepare('SELECT * FROM forms WHERE slug = ?').bind(mm[1]).first();
  // «Closed» en el panel: nadie lo puede enviar, tampoco con enlace personal (antes los enlaces seguían funcionando)
  if (!f || !f.public) throw new FormError(404, 'This form is not available right now.');
  const fields = parse(f.fields) || [];
  const b = req.method === 'POST' ? parse(await req.text()) || {} : {};
  // formulario privado: solo con un enlace personal, en el primer dispositivo que lo abre, una vez y durante 30 días
  let link = null;
  if (f.invite) {
    const k = String(url.searchParams.get('k') || b.k || ''), dev = String(req.headers.get('X-Form-Device') || '');
    if (!/^[\w-]{10,64}$/.test(k)) throw new FormError(403, 'This form is private. Ask HORIZON RCRDS for your personal link.');
    link = await DB.prepare('SELECT * FROM form_links WHERE hash = ? AND form_id = ?').bind(await sha(k), f.id).first();
    if (!link) throw new FormError(404, 'This link is not valid. Ask HORIZON RCRDS for a new one.');
    if (link.revoked) throw new FormError(410, 'This link has been cancelled. Ask HORIZON RCRDS for a new one.');
    if (link.used_at) throw new FormError(410, 'This link has already been used to send the form. Ask HORIZON RCRDS if you need a new one.');
    if (link.expires_at < now()) throw new FormError(410, 'This link has expired. Ask HORIZON RCRDS for a new one.');
    if (!/^[\w-]{20,80}$/.test(dev)) throw new FormError(400, 'Please open the link again.');
    const dh = await sha(dev + ':' + link.hash);
    if (link.device && link.device !== dh) throw new FormError(403, 'This link is personal and has already been opened on another device. Open it on the device where you opened it first, or ask HORIZON RCRDS for a new one.');
    if (!link.device) {
      const r = await DB.prepare('UPDATE form_links SET device = ?, opened_at = ? WHERE hash = ? AND device IS NULL').bind(dh, now(), link.hash).run();
      if (!r.meta.changes) throw new FormError(403, 'This link is personal and has already been opened on another device.');
    }
  }
  if (req.method === 'GET') {
    let collab = null;
    if (link?.grp) {
      const mates = (await DB.prepare('SELECT note, grp_pos FROM form_links WHERE grp = ? ORDER BY grp_pos').bind(link.grp).all()).results;
      collab = { pos: link.grp_pos, n: link.grp_n, main: mates.find(x => x.grp_pos === 1)?.note || '', with: mates.filter(x => x.grp_pos !== link.grp_pos).map(x => x.note) };
    }
    return { title: f.title, description: f.description || '', fields, invite: !!f.invite, note: link?.note || '', collab, multi: multiOf(f) };
  }
  if (req.method !== 'POST') throw new FormError(405, 'Not allowed.');
  if (b._hp) return { ok: true };   // campo trampa para bots: se ignora en silencio
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + f.id)))].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('') : '';
  if (ipHash) {
    const recent = (await DB.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE ip = ? AND at > ?').bind(ipHash, now() - 3600e3).first()).n;
    if (recent >= 8) throw new FormError(429, 'Too many answers in a row. Please try again later.');
  }
  const data = {};
  for (const x of fields) {
    if (x.type === 'section') continue;
    let v = b.answers?.[x.id];
    if (x.type === 'checkbox') {
      v = (Array.isArray(v) ? v : []).map(o => clean(o, 300)).filter(o => (x.options || []).includes(o) || (x.other && o));
    } else {
      v = clean(v, x.type === 'textarea' ? 8000 : 1000);
      if (v && ['radio', 'select'].includes(x.type) && !(x.options || []).includes(v) && !x.other) v = '';
      if (v && x.type === 'email' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) throw new FormError(400, `“${x.label.trim()}”: please enter a valid email.`);
      if (v && x.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) throw new FormError(400, `“${x.label.trim()}”: please paste a link starting with https://`);
    }
    if (x.required && (!v || (Array.isArray(v) && !v.length))) throw new FormError(400, `Please answer “${x.label.trim()}”.`);
    data[x.id] = v;
  }
  // demos en «Collaboration»: los demás artistas llegan ya separados (nombre + email, ambos obligatorios). Así un nombre
  // con «&» («Chase & Status») sigue siendo un solo artista. El nombre del artista guarda a todos («A & B») para el panel y Google.
  const multi = multiOf(f), co = Array.isArray(b.answers?._artists) ? b.answers._artists.slice(0, 2) : [];
  if (multi && co.length) {
    data._artists = co.map((x, i) => {
      const who = i ? 'third' : 'second', name = clean(x?.name, 120), e = clean(x?.email, 200);
      if (!name) throw new FormError(400, `Please enter the ${who} artist’s name.`);
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw new FormError(400, `Please enter a valid email for the ${who} artist.`);
      return { name, email: e };
    });
    data[multi.artist] = clean([data[multi.artist], ...data._artists.map(x => x.name)].filter(Boolean).join(' & '), 1000);
  }
  // el enlace se gasta ANTES de guardar: dos envíos a la vez (doble clic, dos pestañas) no crean dos respuestas
  if (link && !(await DB.prepare('UPDATE form_links SET used_at = ? WHERE hash = ? AND used_at IS NULL').bind(now(), link.hash).run()).meta.changes)
    throw new FormError(410, 'This link has already been used to send the form. Ask HORIZON RCRDS if you need a new one.');
  let ins;
  try { ins = await DB.prepare('INSERT INTO form_responses (form_id, at, data, ip) VALUES (?, ?, ?, ?)').bind(f.id, now(), JSON.stringify(data), ipHash).run(); }
  catch (e) { if (link) await DB.prepare('UPDATE form_links SET used_at = NULL WHERE hash = ?').bind(link.hash).run(); throw e; }   // no se guardó: el enlace sigue valiendo
  if (link) await DB.prepare('UPDATE form_links SET response_id = ? WHERE hash = ?').bind(ins.meta.last_row_id || null, link.hash).run();
  try { await toGoogle(env, f, data); } catch (e) { console.error('google form copy', e); }   // copia en Google Forms (si está conectado)
  return { ok: true };
}
