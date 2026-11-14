/* Contratos de HORIZON RCRDS — el documento es SIEMPRE el PDF exportado del Google Doc del sello (idéntico, sin
   convertir nada). Un contrato puede tener varios firmantes (p. ej. DUO: Artista 1 y Artista 2): cada uno tiene su
   recuadro de firma en el PDF y su propio enlace (/sign/<token>).
   - El firmante ve el PDF tal cual (con las firmas que ya haya) y firma (dibujada o escrita).
   - Se guarda: nombre legal, email, firma, fecha, IP, navegador y la huella SHA-256 del PDF exacto que vio.
     Si la huella no coincide con la del PDF guardado, no se firma.
   - El contrato queda «Firmado» cuando han firmado todos.
   - El PDF firmado se genera en el navegador (pdf-lib): PDF original + cada firma en su recuadro + página de
     certificado. Nada del documento original cambia.
   - Si está configurado el correo (binding MAIL), llega un aviso al Gmail de Horizon en cada firma.
   Permiso: sección «contracts» de los roles (ver / editar). Los owners siempre. */

export class ContractError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const now = () => Date.now();
const token = () => { const u = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MAX_PDF = 20 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SIGNERS = 8;

export const CONTRACT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, email TEXT, template_id TEXT, html TEXT NOT NULL DEFAULT '', vars TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', token TEXT UNIQUE, notes TEXT, file TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, sent_at INTEGER, signed_at INTEGER, signer_name TEXT, signer_email TEXT, signature TEXT, sign_ip TEXT, sign_ua TEXT, doc_hash TEXT, countersigned_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS contract_signers (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, idx INTEGER NOT NULL, label TEXT, email TEXT, box TEXT, token TEXT UNIQUE, signed_at INTEGER, name TEXT, signer_email TEXT, signature TEXT, ip TEXT, ua TEXT)`,
  `CREATE INDEX IF NOT EXISTS contract_signers_c ON contract_signers (contract_id, idx)`,
];
// columnas del PDF (añadidas después: si ya existen, no pasa nada)
export const CONTRACT_COLUMNS = ['pdf TEXT', 'pdf_hash TEXT', 'pdf_pages INTEGER', 'pdf_size INTEGER', 'sign_box TEXT', 'doc_url TEXT', 'kind TEXT'];

function box(v) {
  const b = typeof v === 'string' ? parse(v) : v;
  if (!b) return null;
  const n = x => Math.min(1, Math.max(0, Number(x) || 0));
  return { page: Math.max(0, Math.floor(Number(b.page) || 0)), x: n(b.x), y: n(b.y), w: Math.max(0.03, n(b.w)), h: Math.max(0.02, n(b.h)) };
}
const signerOut = (r, full) => ({
  id: r.id, idx: r.idx, label: r.label || `Artista ${r.idx + 1}`, email: r.email || '', box: box(r.box), token: r.token || '',
  signed: !!r.signed_at, signed_at: r.signed_at || null, name: r.name || '', signer_email: r.signer_email || '', ip: r.ip || '', ua: r.ua || '',
  ...(full ? { signature: r.signature || '' } : {}),
});
const out = (c, signers, full) => ({
  id: c.id, title: c.title, artist: c.artist || '', email: c.email || '', status: c.status, notes: c.notes || '',
  pdf: !!c.pdf, pdf_hash: c.pdf_hash || '', pdf_pages: c.pdf_pages || 0, pdf_size: c.pdf_size || 0, file: !!c.file, doc_url: c.doc_url || '',
  kind: c.kind === 'template' ? 'template' : 'contract', template_id: c.template_id || '', vars: parse(c.vars) || {},
  created_at: c.created_at, updated_at: c.updated_at, sent_at: c.sent_at, signed_at: c.signed_at,
  signers: signers.map(r => signerOut(r, full)),
});

/* Firmantes de un contrato. Los contratos de antes (una sola firma en la tabla contracts) se pasan solos aquí. */
async function signersOf(env, c) {
  const DB = env.DB;
  let rows = (await DB.prepare('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY idx').bind(c.id).all()).results;
  if (!rows.length && (c.sign_box || c.token || c.signer_name)) {
    await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email, box, token, signed_at, name, signer_email, signature, ip, ua) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('s_' + crypto.randomUUID().slice(0, 10), c.id, 'Artista', c.email || '', c.sign_box || null, c.token || null, c.signer_name ? c.signed_at : null, c.signer_name || null, c.signer_email || null, c.signature || null, c.sign_ip || null, c.sign_ua || null).run();
    rows = (await DB.prepare('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY idx').bind(c.id).all()).results;
  }
  return rows;
}

function parseDoc(u) {
  const m = String(u).match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/);
  if (!m) return null;
  const t = String(u).match(/[?&#]tab=(t\.[\w]+)/);
  return { id: m[1], tab: t ? t[1] : '' };
}
async function pdfBody(req) {
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_PDF) throw new ContractError(400, 'El PDF no es válido o pesa más de 20 MB.');
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new ContractError(400, 'Sube un archivo PDF.');
  return buf;
}
const pdfResponse = (buf, name) => new Response(buf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store' } });

/* Panel (con sesión). can(act) = permiso «contracts» del rol; audit(texto) apunta en el historial. */
export async function contractsApi(req, env, s, url, can, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!can('view')) throw new ContractError(403, 'Tu rol no tiene Contratos.');
  const edit = () => { if (!can('edit') || s.sync) throw new ContractError(403, 'Tu rol solo puede ver los contratos.'); };

  if (p === '/api/contracts' && m === 'GET') {
    const rows = (await DB.prepare('SELECT * FROM contracts ORDER BY created_at DESC').all()).results;
    const sg = (await DB.prepare('SELECT * FROM contract_signers ORDER BY idx').all()).results;
    return { contracts: rows.map(c => out(c, sg.filter(r => r.contract_id === c.id), false)), canEdit: can('edit') && !s.sync };
  }
  if (p === '/api/contracts' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const title = clean(b.title, 160);
    if (!title) throw new ContractError(400, 'Ponle un título al contrato.');
    const email = clean(b.email, 160).toLowerCase();
    if (email && !EMAIL.test(email)) throw new ContractError(400, 'El email del artista no es válido.');
    if (b.id) {
      const c = await DB.prepare('SELECT status FROM contracts WHERE id = ?').bind(String(b.id)).first();
      if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
      if (c.status === 'signed') {   // firmado: solo las notas internas
        await DB.prepare('UPDATE contracts SET notes = ?, updated_at = ? WHERE id = ?').bind(clean(b.notes, 2000), now(), String(b.id)).run();
        return { ok: true, id: b.id };
      }
      await DB.prepare('UPDATE contracts SET title = ?, artist = ?, email = ?, notes = ?, updated_at = ? WHERE id = ?')
        .bind(title, clean(b.artist, 160), email, clean(b.notes, 2000), now(), String(b.id)).run();
      // datos de cada firmante (nombre del hueco y email)
      if (Array.isArray(b.signers)) for (const x of b.signers.slice(0, MAX_SIGNERS)) {
        const em = clean(x?.email, 160).toLowerCase();
        if (em && !EMAIL.test(em)) throw new ContractError(400, `El email de «${clean(x?.label, 60) || 'firmante'}» no es válido.`);
        await DB.prepare('UPDATE contract_signers SET label = ?, email = ? WHERE id = ? AND contract_id = ? AND signed_at IS NULL').bind(clean(x?.label, 60) || null, em || null, String(x?.id || ''), String(b.id)).run();
      }
      if (b.vars && typeof b.vars === 'object') { const v = {}; for (const [k, x] of Object.entries(b.vars).slice(0, 60)) v[clean(k, 60)] = clean(x, 500); await DB.prepare('UPDATE contracts SET vars = ? WHERE id = ?').bind(JSON.stringify(v), String(b.id)).run(); }
      await audit(`Editó los datos del contrato «${title}»`);
      return { ok: true, id: b.id };
    }
    const id = 'c_' + crypto.randomUUID().slice(0, 10);
    const kind = b.kind === 'template' ? 'template' : null;
    // contrato a partir de una plantilla: hereda sus firmantes (nombre del hueco y dónde firma)
    const tpl = b.template ? await DB.prepare(`SELECT * FROM contracts WHERE id = ? AND kind = 'template'`).bind(String(b.template)).first() : null;
    if (b.template && !tpl) throw new ContractError(404, 'Esa plantilla ya no existe.');
    const vars = {};
    if (b.vars && typeof b.vars === 'object') for (const [k, v] of Object.entries(b.vars).slice(0, 60)) vars[clean(k, 60)] = clean(v, 500);
    await DB.prepare('INSERT INTO contracts (id, title, artist, email, status, notes, created_by, created_at, updated_at, kind, template_id, vars, pdf_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, title, clean(b.artist, 160), email, 'draft', clean(b.notes, 2000), s.email, now(), now(), kind, tpl?.id || null, JSON.stringify(vars), tpl?.pdf_pages || null).run();
    const from = tpl ? await signersOf(env, tpl) : [];
    if (from.length) {
      await DB.batch(from.map((r, i) => DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email, box) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('s_' + crypto.randomUUID().slice(0, 10), id, i, r.label || null, i === 0 && email ? email : null, r.box || null)));
    } else {
      await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email) VALUES (?, ?, 0, ?, ?)').bind('s_' + crypto.randomUUID().slice(0, 10), id, 'Artista', kind ? null : email || null).run();
    }
    await audit(kind ? `Creó la plantilla «${title}»` : `Creó el contrato «${title}»${tpl ? ` desde la plantilla «${tpl.title}»` : ''}`);
    return { ok: true, id };
  }
  const mm = p.match(/^\/api\/contracts\/([\w-]+)(?:\/(pdf|box|signers|send|void|unvoid|file|doc|from-doc))?$/);
  if (!mm) throw new ContractError(404, 'No encontrado.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(mm[1]).first();
  if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
  const signed = c.status === 'signed';
  const sg = await signersOf(env, c);
  const anySigned = sg.some(r => r.signed_at);

  if (!mm[2] && m === 'GET') return { contract: out(c, sg, true) };
  if (!mm[2] && m === 'DELETE') {
    edit();
    if ((signed || anySigned) && !s.owner) throw new ContractError(403, 'Solo los owners pueden borrar un contrato firmado.');
    await DB.batch([DB.prepare('DELETE FROM contract_signers WHERE contract_id = ?').bind(c.id), DB.prepare('DELETE FROM contracts WHERE id = ?').bind(c.id)]);
    for (const k of [c.pdf, c.file]) if (k) await env.FILES.delete(k);
    await audit(`Eliminó el contrato «${c.title}»${signed ? ' (firmado)' : ''}`);
    return { ok: true };
  }
  if (mm[2] === 'pdf' && m === 'POST') {
    // el PDF exacto exportado de Google Docs. La huella SHA-256 la calcula el navegador del owner al subirlo.
    edit();
    if (signed || anySigned) throw new ContractError(409, 'Alguien ya ha firmado este contrato: el PDF no se puede cambiar.');
    const hash = String(url.searchParams.get('hash') || '');
    const pages = Math.max(1, Math.min(500, Number(url.searchParams.get('pages')) || 1));
    if (!HASH.test(hash)) throw new ContractError(400, 'Falta la huella del PDF.');
    const buf = await pdfBody(req);
    const key = `contracts/${c.id}-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    if (c.pdf && c.pdf !== key) await env.FILES.delete(c.pdf);
    await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, updated_at = ? WHERE id = ?').bind(key, hash, pages, buf.byteLength, now(), c.id).run();
    if (!(c.pdf_pages && c.pdf_pages === pages)) await DB.prepare('UPDATE contract_signers SET box = NULL WHERE contract_id = ?').bind(c.id).run();
    await audit(`Subió el PDF del contrato «${c.title}» (${pages} páginas)`);
    return { ok: true };
  }
  if (mm[2] === 'doc' && m === 'POST') {
    // pestaña del Google Doc de la que sale este contrato
    edit();
    const u = String((parse(await req.text()) || {}).url || '').trim();
    if (u && !parseDoc(u)) throw new ContractError(400, 'Pega el enlace de la pestaña del Google Doc (docs.google.com/document/d/…?tab=…).');
    await DB.prepare('UPDATE contracts SET doc_url = ?, updated_at = ? WHERE id = ?').bind(u || null, now(), c.id).run();
    return { ok: true };
  }
  if (mm[2] === 'from-doc' && m === 'POST') {
    // el PDF lo genera Google desde la pestaña del Doc (idéntico). El token de Google lo da el navegador del owner
    // en ese momento (no se guarda).
    edit();
    if (signed || anySigned) throw new ContractError(409, 'Alguien ya ha firmado este contrato: el PDF no se puede cambiar.');
    const d = parseDoc(c.doc_url || '');
    if (!d) throw new ContractError(400, 'Este contrato no está enlazado a ninguna pestaña del Google Doc.');
    const tk = String((parse(await req.text()) || {}).token || '');
    if (!/^[\w.\-~+/=]{20,4096}$/.test(tk)) throw new ContractError(400, 'Falta el permiso de Google.');
    const r = await fetch(`https://docs.google.com/document/d/${d.id}/export?format=pdf${d.tab ? '&tab=' + d.tab : ''}`, { headers: { Authorization: `Bearer ${tk}` } });
    if (r.status === 401 || r.status === 403) throw new ContractError(403, 'Google no ha dado permiso para leer ese Doc. Vuelve a conectar con la cuenta de Horizon.');
    if (!r.ok) throw new ContractError(502, `Google no ha podido generar el PDF (${r.status}).`);
    const buf = await r.arrayBuffer();
    if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new ContractError(502, 'Google no ha devuelto un PDF. Revisa el enlace de la pestaña.');
    if (buf.byteLength > MAX_PDF) throw new ContractError(400, 'El PDF pesa más de 20 MB.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
    const pages = Math.max(1, (new TextDecoder('latin1').decode(buf).match(/\/Type\s*\/Page[^s]/g) || []).length);
    const key = `contracts/${c.id}-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    if (c.pdf && c.pdf !== key) await env.FILES.delete(c.pdf);
    await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, updated_at = ? WHERE id = ?').bind(key, hash, pages, buf.byteLength, now(), c.id).run();
    if (!(c.pdf_pages && c.pdf_pages === pages)) await DB.prepare('UPDATE contract_signers SET box = NULL WHERE contract_id = ?').bind(c.id).run();
    await audit(`Generó el PDF de «${c.title}» desde el Google Doc (${pages} páginas)`);
    return { ok: true, pages, changedPages: !(c.pdf_pages && c.pdf_pages === pages) };
  }
  if (mm[2] === 'pdf' && m === 'GET') {
    if (!c.pdf) throw new ContractError(404, 'Este contrato aún no tiene PDF.');
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'No se encuentra el PDF.');
    return pdfResponse(f, `${c.id}.pdf`);
  }
  if (mm[2] === 'box' && m === 'POST') {
    edit();
    const body = parse(await req.text()) || {};
    const r = sg.find(x => x.id === String(body.signer || '')) || (sg.length === 1 ? sg[0] : null);
    if (!r) throw new ContractError(400, 'Elige de quién es la firma.');
    if (r.signed_at) throw new ContractError(409, 'Esa persona ya ha firmado.');
    const b = box(body.box || body);
    if (!b || b.page >= (c.pdf_pages || 1)) throw new ContractError(400, 'Lugar de firma no válido.');
    await DB.prepare('UPDATE contract_signers SET box = ? WHERE id = ?').bind(JSON.stringify(b), r.id).run();
    return { ok: true, box: b };
  }
  if (mm[2] === 'signers' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Este contrato ya está firmado.');
    const body = parse(await req.text()) || {};
    if (body.action === 'add') {
      if (sg.length >= MAX_SIGNERS) throw new ContractError(400, `Máximo ${MAX_SIGNERS} firmantes.`);
      const idx = sg.length ? Math.max(...sg.map(r => r.idx)) + 1 : 0;
      await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label) VALUES (?, ?, ?, ?)').bind('s_' + crypto.randomUUID().slice(0, 10), c.id, idx, clean(body.label, 60) || `Artista ${idx + 1}`).run();
      if (sg.length === 1 && sg[0].label === 'Artista') await DB.prepare('UPDATE contract_signers SET label = ? WHERE id = ?').bind('Artista 1', sg[0].id).run();
      return { ok: true };
    }
    if (body.action === 'remove') {
      const r = sg.find(x => x.id === String(body.signer || ''));
      if (!r) throw new ContractError(404, 'Ese firmante ya no existe.');
      if (r.signed_at) throw new ContractError(409, 'Esa persona ya ha firmado: no se puede quitar.');
      if (sg.length <= 1) throw new ContractError(400, 'Un contrato necesita al menos un firmante.');
      await DB.prepare('DELETE FROM contract_signers WHERE id = ?').bind(r.id).run();
      return { ok: true };
    }
    throw new ContractError(400, 'Acción no válida.');
  }
  if (c.kind === 'template' && ['send', 'void', 'unvoid', 'file'].includes(mm[2]) && m === 'POST') throw new ContractError(400, 'Una plantilla no se envía: crea un contrato con ella.');
  if (mm[2] === 'send' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Este contrato ya está firmado.');
    if (!c.pdf) throw new ContractError(400, 'Sube primero el PDF del contrato.');
    const missing = sg.filter(r => !r.box);
    if (missing.length) throw new ContractError(400, `Falta marcar dónde firma: ${missing.map(r => r.label || `Artista ${r.idx + 1}`).join(', ')}.`);
    for (const r of sg) if (!r.token) await DB.prepare('UPDATE contract_signers SET token = ? WHERE id = ?').bind(token(), r.id).run();
    await DB.prepare('UPDATE contracts SET status = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?').bind('sent', now(), now(), c.id).run();
    await audit(`Preparó los enlaces de firma de «${c.title}»`);
    return { ok: true };
  }
  if ((mm[2] === 'void' || mm[2] === 'unvoid') && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Un contrato firmado no se puede anular desde aquí.');
    const st = mm[2] === 'void' ? 'void' : (sg.some(r => r.token) ? 'sent' : 'draft');
    await DB.prepare('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?').bind(st, now(), c.id).run();
    await audit(`${mm[2] === 'void' ? 'Anuló' : 'Reactivó'} el contrato «${c.title}»`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'POST') {
    // archivo: PDF de un contrato que se firmó fuera de la web (antiguos)
    edit();
    const buf = await pdfBody(req);
    const key = `contracts/${c.id}-firmado.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    await DB.prepare(`UPDATE contracts SET file = ?, status = 'signed', signed_at = COALESCE(signed_at, ?), updated_at = ? WHERE id = ?`).bind(key, now(), now(), c.id).run();
    await audit(`Subió el PDF firmado de «${c.title}»`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'GET') {
    if (!c.file) throw new ContractError(404, 'Este contrato no tiene PDF firmado subido.');
    const f = await env.FILES.get(c.file, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'No se encuentra el PDF.');
    return pdfResponse(f, `${c.id}-firmado.pdf`);
  }
  throw new ContractError(404, 'No encontrado.');
}

/* Firma (pública, con el enlace privado de cada firmante). */
export async function signApi(req, env, url, mail) {
  const DB = env.DB;
  const mm = url.pathname.match(/^\/api\/public\/sign\/([\w-]{20,64})(\/pdf)?$/);
  if (!mm) throw new ContractError(404, 'Not found.');
  let me = await DB.prepare('SELECT * FROM contract_signers WHERE token = ?').bind(mm[1]).first();
  let c = me ? await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(me.contract_id).first() : await DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(mm[1]).first();
  if (!c || c.status === 'draft' || !c.pdf) throw new ContractError(404, 'This contract link is not valid.');
  if (c.status === 'void') throw new ContractError(410, 'This contract has been cancelled by HORIZON RCRDS.');
  let sg = await signersOf(env, c);
  if (!me) me = sg.find(r => r.token === mm[1]);
  if (!me) throw new ContractError(404, 'This contract link is not valid.');
  if (mm[2]) {
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'Contract file not found.');
    return pdfResponse(f, 'contract.pdf');
  }
  const view = () => ({
    title: c.title, status: c.status, pdf_hash: c.pdf_hash, email: me.email || '',
    me: { index: sg.findIndex(x => x.id === me.id), label: me.label || 'Artist', box: box(me.box), signed: !!me.signed_at },
    // firmas de todos (las que ya existen), para verlas en su sitio y crear el PDF firmado
    signers: sg.map(r => ({ label: r.label || '', box: box(r.box), signed: r.signed_at ? { at: r.signed_at, name: r.name, email: r.signer_email, signature: r.signature, ip: r.ip, ua: r.ua } : null })),
  });
  if (req.method === 'GET') return view();
  if (req.method !== 'POST') throw new ContractError(405, 'Not allowed.');
  if (me.signed_at) throw new ContractError(409, 'You have already signed this contract.');
  const b = parse(await req.text()) || {};
  const name = clean(b.name, 160), email = clean(b.email, 160).toLowerCase();
  if (name.length < 3) throw new ContractError(400, 'Please write your full legal name.');
  if (!EMAIL.test(email)) throw new ContractError(400, 'Please write a valid email.');
  if (!b.agree) throw new ContractError(400, 'Please confirm that you have read and agree to the contract.');
  let signature = '';
  if (typeof b.signature === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) && b.signature.length < 300000) signature = b.signature;
  else if (clean(b.typed, 120)) signature = 'typed:' + clean(b.typed, 120);
  else throw new ContractError(400, 'Please sign (draw your signature or type your name).');
  if (String(b.hash || '') !== c.pdf_hash) throw new ContractError(409, 'The contract file changed while you were reading it. Please reload the page.');
  const ip = req.headers.get('CF-Connecting-IP') || '', ua = clean(req.headers.get('User-Agent'), 300), at = now();
  const r = await DB.prepare('UPDATE contract_signers SET signed_at = ?, name = ?, signer_email = ?, signature = ?, ip = ?, ua = ? WHERE id = ? AND signed_at IS NULL')
    .bind(at, name, email, signature, ip, ua, me.id).run();
  if (!r.meta.changes) throw new ContractError(409, 'You have already signed this contract.');
  sg = await signersOf(env, c);
  const all = sg.every(x => x.signed_at);
  if (all) await DB.prepare(`UPDATE contracts SET status = 'signed', signed_at = ?, doc_hash = ?, updated_at = ? WHERE id = ?`).bind(at, c.pdf_hash, at, c.id).run();
  c = { ...c, status: all ? 'signed' : c.status };
  me = sg.find(x => x.id === me.id);
  await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(at, email, name, `Firmó el contrato «${c.title}»${sg.length > 1 ? ` (${me.label || 'firmante'})` : ''}`, `IP ${ip}`).run();
  if (mail) {
    try {
      const left = sg.filter(x => !x.signed_at).map(x => x.label || 'firmante');
      await mail(`${all ? 'Contrato firmado' : 'Nueva firma'}: ${c.title}`, `
        <p><b>${escHtml(name)}</b>${sg.length > 1 ? ` (${escHtml(me.label || '')})` : ''} ha firmado <b>${escHtml(c.title)}</b>.</p>
        <p>Email: ${escHtml(email)}<br>Fecha: ${new Date(at).toUTCString()}<br>IP: ${escHtml(ip)}<br>Huella del PDF (SHA-256): ${c.pdf_hash}</p>
        <p>${all ? '<b>Ya han firmado todos.</b>' : `Falta: ${escHtml(left.join(', '))}.`}</p>
        <p>Ver el contrato: <a href="${url.origin}/sign/${me.token}">${url.origin}/sign/${me.token}</a> · También está en el panel → Contratos.</p>`);
    } catch (e) { console.error('mail', e); }
  }
  return view();
}
