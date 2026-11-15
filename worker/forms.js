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

export const FORM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT, fields TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, on_site INTEGER NOT NULL DEFAULT 0, button TEXT, access TEXT NOT NULL DEFAULT '{}', created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS form_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, form_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS form_responses_form ON form_responses (form_id, id)`,
];

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
  const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Panel (con sesión). audit(action) apunta en el historial. */
export async function formsApi(req, env, s, url, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  const ownerOnly = (act = 'edit') => { if (s.sync || !(s.owner || s.perms?.forms?.[act])) throw new FormError(403, 'You do not have permission to change forms.'); };

  // respuestas sin ver (para el aviso del panel), solo de los formularios que esta persona puede ver
  if (p === '/api/forms/unseen' && m === 'GET') {
    const forms = (await DB.prepare('SELECT id, access FROM forms').all()).results.filter(f => canSeeForm(s, f)).map(f => f.id);
    const rows = (await DB.prepare('SELECT form_id, COUNT(*) AS n FROM form_responses WHERE seen = 0 GROUP BY form_id').all()).results.filter(r => forms.includes(r.form_id));
    return { total: rows.reduce((a, r) => a + r.n, 0), forms: Object.fromEntries(rows.map(r => [r.form_id, r.n])) };
  }
  if (p === '/api/forms' && m === 'GET') {
    const forms = (await DB.prepare('SELECT * FROM forms ORDER BY position, created_at').all()).results.filter(f => canSeeForm(s, f));
    // un rol limitado a algunos formularios no crea nuevos (no los vería)
    const counts = (await DB.prepare('SELECT form_id, COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen FROM form_responses GROUP BY form_id').all()).results;
    return {
      owner: !!s.owner,
      forms: forms.map(f => {
        const c = counts.find(x => x.form_id === f.id) || {};
        return { id: f.id, level: formLevel(s, f) || 'view', slug: f.slug, title: f.title, description: f.description || '', fields: parse(f.fields) || [], public: !!f.public, on_site: !!f.on_site, button: f.button || '',
          access: s.owner ? access(f) : undefined, total: c.total || 0, unseen: c.unseen || 0, updated_at: f.updated_at };
      }),
    };
  }
  if (p === '/api/forms' && m === 'POST') {
    const b = parse(await req.text()) || {};
    // crear: solo owners; cambiar: quien tenga «Edit» en ese formulario
    if (s.sync) throw new FormError(403, 'Not allowed.');
    if (!s.owner) {
      const cur = b.id ? await DB.prepare('SELECT id, access FROM forms WHERE id = ?').bind(String(b.id)).first() : null;
      if (!cur || formLevel(s, cur) !== 'edit') throw new FormError(403, 'Your role can’t edit this form.');
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
  const mm = p.match(/^\/api\/forms\/([\w-]+)(?:\/(responses|csv|seen))?(?:\/(\d+))?$/);
  if (!mm) throw new FormError(404, 'Not found.');
  const f = await getForm(env, mm[1]);
  if (!canSeeForm(s, f)) throw new FormError(403, 'You don’t have access to this form.');
  if (!mm[2] && m === 'DELETE') {
    if (!s.owner || s.sync) throw new FormError(403, 'Only owners can delete a form.');
    const n = (await DB.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').bind(f.id).first()).n;
    await DB.batch([DB.prepare('DELETE FROM form_responses WHERE form_id = ?').bind(f.id), DB.prepare('DELETE FROM forms WHERE id = ?').bind(f.id)]);
    await audit(`Deleted the form “${f.title}” (${n} responses)`);
    return { ok: true };
  }
  if (mm[2] === 'responses' && m === 'GET') {
    // Release Form: la más nueva arriba. El resto: #1 arriba y cada nueva debajo.
    const asc = f.slug !== 'release-form';
    const from = Number(url.searchParams.get('from') || url.searchParams.get('before')) || (asc ? 0 : 9e15);
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    // cada respuesta lleva su número (#1 = la primera que llegó), como las filas de Google; se puede buscar por él
    const num = /^#?\d{1,6}$/.test(q) ? Number(q.replace('#', '')) : -1;
    const base = `WITH t AS (SELECT id, at, data, seen, ROW_NUMBER() OVER (ORDER BY id) AS n FROM form_responses WHERE form_id = ?) SELECT * FROM t WHERE id ${asc ? '>' : '<'} ?`;
    const tail = ` ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT 101`;
    const rows = (q
      ? await DB.prepare(base + " AND (data LIKE ? ESCAPE '\\' OR n = ?)" + tail).bind(f.id, from, like, num).all()
      : await DB.prepare(base + tail).bind(f.id, from).all()).results;
    return { responses: rows.slice(0, 100).map(r => ({ id: r.id, n: r.n, at: r.at, seen: !!r.seen, data: parse(r.data) || {} })), more: rows.length > 100, asc };
  }
  if (mm[2] === 'responses' && mm[3] && m === 'POST') {
    const seen = (parse(await req.text()) || {}).seen ? 1 : 0;
    const r = await DB.prepare('UPDATE form_responses SET seen = ? WHERE id = ? AND form_id = ?').bind(seen, Number(mm[3]), f.id).run();
    if (!r.meta.changes) throw new FormError(404, 'That response no longer exists.');
    return { ok: true, seen: !!seen };
  }
  if (mm[2] === 'seen' && m === 'POST') {
    await DB.prepare('UPDATE form_responses SET seen = 1 WHERE form_id = ? AND seen = 0').bind(f.id).run();
    return { ok: true };
  }
  if (mm[2] === 'responses' && mm[3] && m === 'DELETE') {
    if (s.sync || formLevel(s, f) !== 'edit') throw new FormError(403, 'Your role can’t delete responses here.');
    const r = await DB.prepare('DELETE FROM form_responses WHERE id = ? AND form_id = ?').bind(Number(mm[3]), f.id).run();
    if (!r.meta.changes) throw new FormError(404, 'That response no longer exists.');
    await audit(`Deleted a response from the form “${f.title}”`);
    return { ok: true };
  }
  if (mm[2] === 'csv' && m === 'GET') {
    const fields = (parse(f.fields) || []).filter(x => x.type !== 'section');
    const rows = (await DB.prepare('SELECT at, data FROM form_responses WHERE form_id = ? ORDER BY id').bind(f.id).all()).results;
    const lines = [['Fecha', ...fields.map(x => x.label)].map(csvCell).join(',')];
    for (const r of rows) { const d = parse(r.data) || {}; lines.push([new Date(r.at).toISOString().replace('T', ' ').slice(0, 16), ...fields.map(x => d[x.id])].map(csvCell).join(',')); }
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
  if (!f || !f.public) throw new FormError(404, 'This form is not available right now.');
  const fields = parse(f.fields) || [];
  if (req.method === 'GET') return { title: f.title, description: f.description || '', fields };
  if (req.method !== 'POST') throw new FormError(405, 'Not allowed.');
  const b = parse(await req.text()) || {};
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
  await DB.prepare('INSERT INTO form_responses (form_id, at, data, ip) VALUES (?, ?, ?, ?)').bind(f.id, now(), JSON.stringify(data), ipHash).run();
  return { ok: true };
}
