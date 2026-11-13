/* Contratos de HORIZON RCRDS.
   - Plantillas: el texto de cada tipo de contrato (se pega desde Google Docs y se edita en el panel). Los huecos
     {{artista}}, {{tema}}… se rellenan al crear un contrato.
   - Contratos: texto ya rellenado para un artista. Se envía un enlace privado (/sign/<token>) y el artista firma.
   - Al firmar se guarda: nombre legal, email, firma (dibujada o escrita), fecha, IP, navegador y una huella
     SHA-256 del texto exacto firmado. Si está configurado el correo (binding MAIL), llega un aviso al Gmail de Horizon.
   - Archivo: PDF de contratos firmados fuera (antiguos), guardados en KV.
   Permiso: sección «contracts» de los roles (ver / editar). Los owners siempre. */

export class ContractError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const now = () => Date.now();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const token = () => { const u = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const CONTRACT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contract_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, email TEXT, template_id TEXT, html TEXT NOT NULL DEFAULT '', vars TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', token TEXT UNIQUE, notes TEXT, file TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, sent_at INTEGER, signed_at INTEGER, signer_name TEXT, signer_email TEXT, signature TEXT, sign_ip TEXT, sign_ua TEXT, doc_hash TEXT, countersigned_by TEXT)`,
];

/* Limpieza del HTML de los contratos: solo etiquetas de texto, sin atributos (salvo class="c" = centrado). */
const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'br', 'hr', 'table', 'tbody', 'tr', 'td', 'th', 'blockquote']);
export function sanitize(html) {
  let s = String(html || '').slice(0, 400000);
  s = s.replace(/<(script|style|iframe|object|embed|svg|math|template|noscript)[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return '';
    const close = m.startsWith('</');
    if (close) return t === 'br' || t === 'hr' ? '' : `</${t}>`;
    const center = /class\s*=\s*["'][^"']*\bc\b/i.test(attrs) || /text-align\s*:\s*center/i.test(attrs);
    return `<${t}${center && ['p', 'h1', 'h2', 'h3', 'h4'].includes(t) ? ' class="c"' : ''}>`;
  });
  return s.replace(/<(?![a-zA-Z/])/g, '&lt;');
}
const fill = (html, vars) => html.replace(/\{\{\s*([\wáéíóúñ]+)\s*\}\}/gi, (m, k) => (vars[k] !== undefined && vars[k] !== '' ? escHtml(vars[k]) : m));
export const placeholders = html => [...new Set([...String(html).matchAll(/\{\{\s*([\wáéíóúñ]+)\s*\}\}/gi)].map(m => m[1]))];

const out = (c, withHtml) => ({
  id: c.id, title: c.title, artist: c.artist || '', email: c.email || '', template_id: c.template_id || '', status: c.status, notes: c.notes || '',
  vars: parse(c.vars) || {}, token: c.token || '', file: !!c.file, created_at: c.created_at, updated_at: c.updated_at, sent_at: c.sent_at, signed_at: c.signed_at,
  signer_name: c.signer_name || '', signer_email: c.signer_email || '', doc_hash: c.doc_hash || '', sign_ip: c.sign_ip || '', sign_ua: c.sign_ua || '',
  ...(withHtml ? { html: c.html, signature: c.signature || '' } : {}),
});

/* Panel (con sesión). can(act) = permiso «contracts» del rol; audit(texto) apunta en el historial. */
export async function contractsApi(req, env, s, url, can, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!can('view')) throw new ContractError(403, 'Tu rol no tiene Contratos.');
  const edit = () => { if (!can('edit') || s.sync) throw new ContractError(403, 'Tu rol solo puede ver los contratos.'); };

  /* Plantillas */
  if (p === '/api/contracts/templates' && m === 'GET') {
    const rows = (await DB.prepare('SELECT * FROM contract_templates ORDER BY position, created_at').all()).results;
    return { templates: rows.map(t => ({ id: t.id, name: t.name, html: t.html, fields: placeholders(t.html), updated_at: t.updated_at })) };
  }
  if (p === '/api/contracts/templates' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const name = clean(b.name, 120);
    if (!name) throw new ContractError(400, 'Ponle un nombre a la plantilla.');
    const html = sanitize(b.html);
    if (b.id) {
      const r = await DB.prepare('UPDATE contract_templates SET name = ?, html = ?, updated_at = ? WHERE id = ?').bind(name, html, now(), String(b.id)).run();
      if (!r.meta.changes) throw new ContractError(404, 'Esa plantilla ya no existe.');
      await audit(`Cambió la plantilla de contrato «${name}»`);
      return { ok: true, id: b.id };
    }
    const id = 't_' + crypto.randomUUID().slice(0, 8);
    const pos = (await DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM contract_templates').first()).p;
    await DB.prepare('INSERT INTO contract_templates (id, name, html, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, html, pos, now(), now()).run();
    await audit(`Creó la plantilla de contrato «${name}»`);
    return { ok: true, id };
  }
  let mm = p.match(/^\/api\/contracts\/templates\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    edit();
    const t = await DB.prepare('SELECT name FROM contract_templates WHERE id = ?').bind(mm[1]).first();
    if (!t) throw new ContractError(404, 'Esa plantilla ya no existe.');
    await DB.prepare('DELETE FROM contract_templates WHERE id = ?').bind(mm[1]).run();
    await audit(`Eliminó la plantilla de contrato «${t.name}»`);
    return { ok: true };
  }

  /* Contratos */
  if (p === '/api/contracts' && m === 'GET') {
    const rows = (await DB.prepare('SELECT * FROM contracts ORDER BY created_at DESC').all()).results;
    return { contracts: rows.map(c => out(c, false)), canEdit: can('edit') && !s.sync };
  }
  if (p === '/api/contracts' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const title = clean(b.title, 160);
    if (!title) throw new ContractError(400, 'Ponle un título al contrato.');
    const vars = {};
    for (const [k, v] of Object.entries(b.vars || {})) if (/^[\wáéíóúñ]{1,40}$/i.test(k)) vars[k] = clean(v, 500);
    const email = clean(b.email, 160).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new ContractError(400, 'El email del artista no es válido.');
    if (b.id) {
      const c = await DB.prepare('SELECT status FROM contracts WHERE id = ?').bind(String(b.id)).first();
      if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
      if (c.status === 'signed') throw new ContractError(409, 'Este contrato ya está firmado: no se puede cambiar.');
      await DB.prepare('UPDATE contracts SET title = ?, artist = ?, email = ?, html = ?, vars = ?, notes = ?, updated_at = ? WHERE id = ?')
        .bind(title, clean(b.artist, 160), email, sanitize(b.html), JSON.stringify(vars), clean(b.notes, 2000), now(), String(b.id)).run();
      await audit(`Editó el contrato «${title}»`);
      return { ok: true, id: b.id };
    }
    let html = sanitize(b.html);
    if (b.template_id) {
      const t = await DB.prepare('SELECT html FROM contract_templates WHERE id = ?').bind(String(b.template_id)).first();
      if (!t) throw new ContractError(404, 'Esa plantilla ya no existe.');
      html = fill(t.html, vars);
    }
    const id = 'c_' + crypto.randomUUID().slice(0, 10);
    await DB.prepare('INSERT INTO contracts (id, title, artist, email, template_id, html, vars, status, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, title, clean(b.artist, 160), email, b.template_id ? String(b.template_id) : null, html, JSON.stringify(vars), 'draft', clean(b.notes, 2000), s.email, now(), now()).run();
    await audit(`Creó el contrato «${title}»`);
    return { ok: true, id };
  }
  mm = p.match(/^\/api\/contracts\/([\w-]+)(?:\/(send|void|file|unvoid))?$/);
  if (!mm) throw new ContractError(404, 'No encontrado.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(mm[1]).first();
  if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
  if (!mm[2] && m === 'GET') return { contract: out(c, true) };
  if (!mm[2] && m === 'DELETE') {
    edit();
    if (c.status === 'signed' && !s.owner) throw new ContractError(403, 'Solo los owners pueden borrar un contrato firmado.');
    await DB.prepare('DELETE FROM contracts WHERE id = ?').bind(c.id).run();
    if (c.file) await env.FILES.delete(c.file);
    await audit(`Eliminó el contrato «${c.title}»${c.status === 'signed' ? ' (firmado)' : ''}`);
    return { ok: true };
  }
  if (mm[2] === 'send' && m === 'POST') {
    edit();
    if (c.status === 'signed') throw new ContractError(409, 'Este contrato ya está firmado.');
    if (!c.html.trim()) throw new ContractError(400, 'El contrato está vacío.');
    const missing = placeholders(c.html);
    if (missing.length) throw new ContractError(400, `Faltan datos por rellenar: ${missing.map(x => `{{${x}}}`).join(', ')}`);
    const tk = c.token || token();
    await DB.prepare('UPDATE contracts SET token = ?, status = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?').bind(tk, 'sent', now(), now(), c.id).run();
    await audit(`Preparó el enlace de firma de «${c.title}»`);
    return { ok: true, token: tk };
  }
  if ((mm[2] === 'void' || mm[2] === 'unvoid') && m === 'POST') {
    edit();
    if (c.status === 'signed') throw new ContractError(409, 'Un contrato firmado no se puede anular desde aquí.');
    const st = mm[2] === 'void' ? 'void' : (c.token ? 'sent' : 'draft');
    await DB.prepare('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?').bind(st, now(), c.id).run();
    await audit(`${mm[2] === 'void' ? 'Anuló' : 'Reactivó'} el contrato «${c.title}»`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'POST') {
    // subir el PDF de un contrato ya firmado (fuera de la web)
    edit();
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 20 * 1024 * 1024) throw new ContractError(400, 'El PDF no es válido o pesa más de 20 MB.');
    if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new ContractError(400, 'Sube un archivo PDF.');
    const key = `contracts/${c.id}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    await DB.prepare('UPDATE contracts SET file = ?, status = CASE WHEN status = \'signed\' THEN status ELSE \'signed\' END, signed_at = COALESCE(signed_at, ?), updated_at = ? WHERE id = ?').bind(key, now(), now(), c.id).run();
    await audit(`Subió el PDF firmado de «${c.title}»`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'GET') {
    if (!c.file) throw new ContractError(404, 'Este contrato no tiene PDF.');
    const f = await env.FILES.get(c.file, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'No se encuentra el PDF.');
    return new Response(f, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${c.id}.pdf"`, 'Cache-Control': 'no-store' } });
  }
  throw new ContractError(404, 'No encontrado.');
}

/* Firma (pública, con el enlace privado). */
export async function signApi(req, env, url, mail) {
  const DB = env.DB;
  const mm = url.pathname.match(/^\/api\/public\/sign\/([\w-]{20,64})$/);
  if (!mm) throw new ContractError(404, 'Not found.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(mm[1]).first();
  if (!c || c.status === 'draft') throw new ContractError(404, 'This contract link is not valid.');
  if (c.status === 'void') throw new ContractError(410, 'This contract has been cancelled by HORIZON RCRDS.');
  const view = () => ({
    title: c.title, artist: c.artist || '', email: c.email || '', html: c.html, status: c.status,
    signed: c.status === 'signed' ? { at: c.signed_at, name: c.signer_name, email: c.signer_email, signature: c.signature, hash: c.doc_hash, ip: c.sign_ip } : null,
  });
  if (req.method === 'GET') return view();
  if (req.method !== 'POST') throw new ContractError(405, 'Not allowed.');
  if (c.status === 'signed') throw new ContractError(409, 'This contract is already signed.');
  const b = parse(await req.text()) || {};
  const name = clean(b.name, 160), email = clean(b.email, 160).toLowerCase();
  if (name.length < 3) throw new ContractError(400, 'Please write your full legal name.');
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new ContractError(400, 'Please write a valid email.');
  if (!b.agree) throw new ContractError(400, 'Please confirm that you have read and agree to the contract.');
  let signature = '';
  if (typeof b.signature === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) && b.signature.length < 300000) signature = b.signature;
  else if (clean(b.typed, 120)) signature = 'typed:' + clean(b.typed, 120);
  else throw new ContractError(400, 'Please sign (draw your signature or type your name).');
  if (String(b.hash || '') !== await sha256(c.html)) throw new ContractError(409, 'The contract changed while you were reading it. Please reload the page.');
  const ip = req.headers.get('CF-Connecting-IP') || '', ua = clean(req.headers.get('User-Agent'), 300), at = now(), hash = await sha256(c.html);
  const r = await DB.prepare('UPDATE contracts SET status = ?, signed_at = ?, signer_name = ?, signer_email = ?, signature = ?, sign_ip = ?, sign_ua = ?, doc_hash = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind('signed', at, name, email, signature, ip, ua, hash, at, c.id, 'sent').run();
  if (!r.meta.changes) throw new ContractError(409, 'This contract is already signed.');
  await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(at, email, name, `Firmó el contrato «${c.title}»`, `IP ${ip}`).run();
  Object.assign(c, { status: 'signed', signed_at: at, signer_name: name, signer_email: email, signature, sign_ip: ip, doc_hash: hash });
  if (mail) {
    try {
      await mail(`Contrato firmado: ${c.title}`, `
        <p><b>${escHtml(name)}</b> ha firmado <b>${escHtml(c.title)}</b>.</p>
        <p>Email: ${escHtml(email)}<br>Fecha: ${new Date(at).toUTCString()}<br>IP: ${escHtml(ip)}<br>Huella del texto (SHA-256): ${hash}</p>
        <p>Copia firmada: <a href="${url.origin}/sign/${c.token}">${url.origin}/sign/${c.token}</a></p>
        <p>También está en el panel → Contratos.</p>`);
    } catch (e) { console.error('mail', e); }
  }
  return view();
}
export const hashOf = sha256;
