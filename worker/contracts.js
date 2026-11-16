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

import { inviteMail, doneMail, mailName } from './contract-mail.js';
import { horizonToken, docFromTemplate, saveToDrive } from './gdocs.js';

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
  `CREATE TABLE IF NOT EXISTS sign_codes (signer_id TEXT PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sign_sessions (hash TEXT PRIMARY KEY, signer_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contract_events (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id TEXT NOT NULL, signer_id TEXT, at INTEGER NOT NULL, event TEXT NOT NULL, ip TEXT, ua TEXT)`,
  `CREATE INDEX IF NOT EXISTS contract_events_c ON contract_events (contract_id, id)`,
  // un solo guardado en Drive a la vez por release (si no, dos paneles abiertos crean dos carpetas iguales)
  `CREATE TABLE IF NOT EXISTS drive_locks (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
];
// columnas del PDF (añadidas después: si ya existen, no pasa nada)
export const CONTRACT_COLUMNS = ['pdf TEXT', 'pdf_hash TEXT', 'pdf_pages INTEGER', 'pdf_size INTEGER', 'sign_box TEXT', 'doc_url TEXT', 'kind TEXT',
  // PDF firmado final (lo genera el servidor cuando firman todos), release al que pertenece, Drive y correo final
  'signed_pdf TEXT', 'signed_hash TEXT', 'release_cat TEXT', 'release_name TEXT', 'drive_id TEXT', 'drive_url TEXT', 'done_mail_at INTEGER', 'finish_error TEXT',
  // PDF que se hace después de crear el contrato: 'making' mientras Google lo genera; 'error: …' si falló
  'pdf_state TEXT'];
// por firmante: cuándo se le envió el correo, si falló, e intentos fallidos de entrar con su email
export const SIGNER_COLUMNS = ['emailed_at INTEGER', 'email_error TEXT', 'fails INTEGER NOT NULL DEFAULT 0'];

function box(v) {
  const b = typeof v === 'string' ? parse(v) : v;
  if (!b) return null;
  const n = x => Math.min(1, Math.max(0, Number(x) || 0));
  return { page: Math.max(0, Math.floor(Number(b.page) || 0)), x: n(b.x), y: n(b.y), w: Math.max(0.03, n(b.w)), h: Math.max(0.02, n(b.h)), ...(b.manual ? { manual: 1 } : {}) };
}
const signerOut = (r, full) => ({
  id: r.id, idx: r.idx, label: r.label || `Artist ${r.idx + 1}`, email: r.email || '', box: box(r.box), token: r.token || '',
  signed: !!r.signed_at, signed_at: r.signed_at || null, name: r.name || '', signer_email: r.signer_email || '', ip: r.ip || '', ua: r.ua || '',
  emailed_at: r.emailed_at || null, email_error: r.email_error || '',
  ...(full ? { signature: r.signature || '' } : {}),
});
const out = (c, signers, full) => ({
  id: c.id, title: c.title, artist: c.artist || '', email: c.email || '', status: c.status, notes: c.notes || '',
  pdf: !!c.pdf, pdf_state: c.pdf ? '' : c.pdf_state || '', pdf_hash: c.pdf_hash || '', pdf_pages: c.pdf_pages || 0, pdf_size: c.pdf_size || 0, file: !!c.file, doc_url: c.doc_url || '',
  kind: c.kind === 'template' ? 'template' : c.kind === 'draft' ? 'draft' : 'contract', template_id: c.template_id || '', vars: parse(c.vars) || {},
  created_at: c.created_at, updated_at: c.updated_at, sent_at: c.sent_at, signed_at: c.signed_at,
  signed_pdf: !!c.signed_pdf, signed_hash: c.signed_hash || '', release_cat: c.release_cat || '', release_name: c.release_name || '',
  drive_url: c.drive_url || '', done_mail_at: c.done_mail_at || null, finish_error: c.finish_error || '',
  signers: signers.map(r => signerOut(r, full)),
});

/* Firmantes de un contrato. Los contratos de antes (una sola firma en la tabla contracts) se pasan solos aquí. */
async function signersOf(env, c) {
  const DB = env.DB;
  let rows = (await DB.prepare('SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY idx').bind(c.id).all()).results;
  if (!rows.length && (c.sign_box || c.token || c.signer_name)) {
    await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email, box, token, signed_at, name, signer_email, signature, ip, ua) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('s_' + crypto.randomUUID().slice(0, 10), c.id, 'Artist', c.email || '', c.sign_box || null, c.token || null, c.signer_name ? c.signed_at : null, c.signer_name || null, c.signer_email || null, c.signature || null, c.sign_ip || null, c.sign_ua || null).run();
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
  if (!buf.byteLength || buf.byteLength > MAX_PDF) throw new ContractError(400, 'The PDF is not valid or is larger than 20 MB.');
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new ContractError(400, 'Upload a PDF file.');
  return buf;
}
const pdfResponse = (buf, name) => new Response(buf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store' } });
const sha256 = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
export const signedName = c => `${String(c.title || 'Contract').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Contract'} (signed).pdf`;
const signerLink = (origin, r) => `${origin}/sign/${r.token}`;
const isDraftRow = c => c?.kind === 'draft';

// el PDF de una pestaña del Google Doc, tal cual lo exporta Google
async function exportDocPdf(env, docUrl, tk) {
  const d = parseDoc(docUrl || '');
  if (!d) throw new ContractError(400, 'This contract is not linked to a Google Doc tab.');
  if (!tk) { try { tk = await horizonToken(env); } catch (e) { throw new ContractError(502, e.message); } }
  if (!/^[\w.\-~+/=]{20,4096}$/.test(tk)) throw new ContractError(400, 'Google permission missing.');
  const r = await fetch(`https://docs.google.com/document/d/${d.id}/export?format=pdf${d.tab ? '&tab=' + d.tab : ''}`, { headers: { Authorization: `Bearer ${tk}` } });
  if (r.status === 401 || r.status === 403) throw new ContractError(403, 'Google did not allow reading that Doc. Connect again with the Horizon account.');
  if (!r.ok) throw new ContractError(502, `Google could not generate the PDF (${r.status}).`);
  const buf = await r.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new ContractError(502, 'Google did not return a PDF. Check the tab link.');
  if (buf.byteLength > MAX_PDF) throw new ContractError(400, 'The PDF is larger than 20 MB.');
  return buf;
}
const pdfPages = buf => Math.max(1, (new TextDecoder('latin1').decode(buf).match(/\/Type\s*\/Page[^s]/g) || []).length);

// correo con su enlace a cada firmante de la lista (se apunta si se envió o el error)
async function sendInvites(env, c, sg, list, origin) {
  const DB = env.DB, errors = [];
  for (const r of sg) if (!r.token) { r.token = token(); await DB.prepare('UPDATE contract_signers SET token = ? WHERE id = ?').bind(r.token, r.id).run(); }
  await DB.prepare('UPDATE contracts SET status = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?').bind('sent', now(), now(), c.id).run();
  for (const r of list) {
    const x = sg.find(y => y.id === r.id) || r;
    try { await inviteMail(env, c, x, signerLink(origin, x)); await DB.prepare('UPDATE contract_signers SET emailed_at = ?, email_error = NULL WHERE id = ?').bind(now(), x.id).run(); }
    catch (e) { errors.push(e.message); await DB.prepare('UPDATE contract_signers SET email_error = ? WHERE id = ?').bind(e.message.slice(0, 300), x.id).run(); }
  }
  return errors;
}

// nombre legal del firmante, sacado de los datos del contrato (no lo escribe el artista)
function legalName(c, me, sg) {
  const v = parse(c.vars) || {}, get = re => { const k = Object.keys(v).find(n => re.test(n)); return k ? String(v[k] || '').trim() : ''; };
  const norm = x => String(x || '').trim().toLowerCase();
  if (sg.length > 1) return get(new RegExp(`^artist ${me.idx + 1} legal name$`, 'i')) || me.label || '';
  for (let k = 1; k <= 8; k++) if (norm(get(new RegExp(`^artist ${k} name$`, 'i'))) === norm(me.label) && me.label) return get(new RegExp(`^artist ${k} legal name$`, 'i')) || me.label;
  return get(/^legal name$/i) || me.label || '';
}

/* Cuando han firmado todos: cada firmante recibe un correo con su enlace, donde descarga el contrato firmado.
   (El PDF firmado se crea en el navegador: el plan gratis de Cloudflare no da CPU para hacerlo aquí.)
   Si el correo falla queda apuntado (finish_error) y se puede repetir desde el panel. */
export async function finalize(env, id, origin) {
  const DB = env.DB;
  const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(id).first();
  if (!c || c.status !== 'signed' || c.done_mail_at) return { ok: !!c?.done_mail_at };
  const sg = await signersOf(env, c);
  if (!sg.length || sg.some(r => !r.signed_at)) return { ok: false };
  const errors = [];
  for (const r of sg) {
    const to = r.email || r.signer_email;
    if (!to || !r.token) continue;
    try { await doneMail(env, c, { ...r, email: to }, signerLink(origin, r)); }
    catch (e) { errors.push(`${r.label || to}: ${e.message}`); }
  }
  if (errors.length) await DB.prepare('UPDATE contracts SET finish_error = ? WHERE id = ?').bind(`Signed copy not emailed — ${errors.join(' · ')}`.slice(0, 600), c.id).run();
  else await DB.prepare('UPDATE contracts SET done_mail_at = ?, finish_error = NULL WHERE id = ?').bind(now(), c.id).run();
  return { ok: !errors.length };
}

/* Cada 30 min: si el PDF de un contrato firmado se borró del Drive (o está en la papelera), se olvida su enlace,
   así el panel lo vuelve a guardar en su carpeta. Solo los firmados en los últimos 6 meses. */
export async function checkDriveFiles(env) {
  const all = (await env.DB.prepare("SELECT id, drive_id FROM contracts WHERE status = 'signed' AND drive_id IS NOT NULL AND signed_at > ? ORDER BY id").bind(now() - 180 * 864e5).all()).results;
  if (!all.length) return;
  // plan gratis: máximo 50 llamadas por ejecución → 15 contratos por turno, rotando (cada uno se revisa varias veces al día)
  const per = 15, start = (Math.floor(now() / 1800e3) * per) % all.length;
  const rows = all.length <= per ? all : [...all.slice(start), ...all.slice(0, start)].slice(0, per);
  const tok = await horizonToken(env);
  for (const r of rows) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${r.drive_id}?fields=trashed&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await res.json().catch(() => ({}));
    if (res.status === 404 || j.trashed) await env.DB.prepare('UPDATE contracts SET drive_id = NULL, drive_url = NULL WHERE id = ?').bind(r.id).run();
  }
}

/* Panel (con sesión). can(act) = permiso «contracts» del rol; audit(texto) apunta en el historial. */
export async function contractsApi(req, env, s, url, can, audit, ctx) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!can('view')) throw new ContractError(403, 'Your role has no Contracts access.');
  const edit = () => { if (!can('edit') || s.sync) throw new ContractError(403, 'Your role can only view contracts.'); };

  if (p === '/api/contracts' && m === 'GET') {
    const rows = (await DB.prepare('SELECT * FROM contracts ORDER BY created_at DESC').all()).results;
    const sg = (await DB.prepare('SELECT * FROM contract_signers ORDER BY idx').all()).results;
    const cats = (await DB.prepare('SELECT cat FROM calendar WHERE cat IS NOT NULL').all().catch(() => ({ results: [] }))).results.map(r => r.cat);
    return { contracts: rows.map(c => out(c, sg.filter(r => r.contract_id === c.id), false)), cats, canEdit: can('edit') && !s.sync };
  }
  // lo que hacen los artistas con sus enlaces (todos los contratos): Contracts → Activity (no va al historial del equipo)
  if (p === '/api/contracts/activity' && m === 'GET') {
    const events = (await DB.prepare('SELECT e.at, e.event, e.ip, e.ua, e.contract_id, c.title, c.artist, c.release_name, c.kind, s.label, s.email FROM contract_events e LEFT JOIN contracts c ON c.id = e.contract_id LEFT JOIN contract_signers s ON s.id = e.signer_id ORDER BY e.id DESC LIMIT 300').all()).results;
    return { events };
  }
  // carpeta de Drive donde están las carpetas de cada año
  if (p === '/api/contracts/settings') {
    if (m === 'POST') {
      edit();
      if (!s.owner) throw new ContractError(403, 'Only owners can change the Drive folder.');
      const b = parse(await req.text()) || {};
      const id = String(b.drive_folder || '').trim();
      if (id && !/^[\w-]{10,100}$/.test(id)) throw new ContractError(400, 'That Drive folder link is not valid.');
      await DB.prepare("INSERT INTO panel_settings (key, value) VALUES ('contracts_drive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(id).run();
      await audit(id ? 'Set the Drive folder for signed contracts' : 'Removed the Drive folder for signed contracts');
    }
    const r = await DB.prepare("SELECT value FROM panel_settings WHERE key = 'contracts_drive'").first();
    // la carpeta solo la ven los owners; los demás solo saben si está puesta
    return { drive_folder: s.owner ? r?.value || '' : '', ready: !!r?.value };
  }
  // contrato nuevo desde una plantilla: copia del Google Doc (en el Drive de Horizon) con los datos puestos
  if (p === '/api/contracts/make-doc' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const tpl = await DB.prepare(`SELECT doc_url FROM contracts WHERE id = ? AND kind = 'template'`).bind(String(b.template || '')).first();
    if (!tpl?.doc_url) throw new ContractError(404, 'That template has no Google Doc.');
    const values = {};
    if (b.values && typeof b.values === 'object') for (const [k, v] of Object.entries(b.values).slice(0, 60)) values[clean(k, 60)] = clean(v, 500);
    try { return { doc_url: await docFromTemplate(env, tpl.doc_url, values, clean(b.title, 160) || 'Contract') }; }
    catch (e) { throw new ContractError(502, e.message); }
  }
  // contrato(s) nuevo(s) desde una plantilla, todo en una llamada: copia del Doc con los datos → PDF → contrato(s) con
  // quién firma. Con varios «copies», un contrato por artista con el mismo PDF. Un draft usa el PDF de la plantilla tal cual.
  if (p === '/api/contracts/make' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const tpl = await DB.prepare(`SELECT * FROM contracts WHERE id = ? AND kind = 'template'`).bind(String(b.template || '')).first();
    if (!tpl) throw new ContractError(404, 'That template no longer exists.');
    const draft = /draft/i.test(tpl.title);
    const values = {};
    if (b.values && typeof b.values === 'object') for (const [k, v] of Object.entries(b.values).slice(0, 60)) values[clean(k, 60)] = clean(v, 500);
    const copies = (Array.isArray(b.copies) ? b.copies : []).slice(0, MAX_SIGNERS);
    if (!copies.length) throw new ContractError(400, 'Who is the contract for?');
    for (const cp of copies) for (const x of (cp.signers || [])) { const em = clean(x?.email, 160); if (em && !EMAIL.test(em)) throw new ContractError(400, `The email “${em}” is not valid.`); }
    if (draft && !EMAIL.test(clean(copies[0].signers?.[0]?.email, 160))) throw new ContractError(400, 'Write the email the draft is sent to.');
    const from = await signersOf(env, tpl), t = now(), ids = [];
    // fila de cada contrato y sus firmantes; el PDF se pone después (put)
    const insert = async (cp, f) => {
      const id = 'c_' + crypto.randomUUID().slice(0, 10);
      const title = clean(cp.title, 160) || (draft ? 'Contract Draft' : tpl.title), people = Array.isArray(cp.signers) ? cp.signers : [];
      const rows = draft ? [{ label: clean(cp.artist, 60) || 'Artist', email: clean(people[0]?.email, 160).toLowerCase(), box: null }]
        : (from.length ? from : [{ label: 'Artist', box: null }]).map((r, i) => ({ label: clean(people[i]?.label, 60) || r.label || `Artist ${i + 1}`, email: clean(people[i]?.email, 160).toLowerCase() || null, box: f.keepBoxes ? r.box : null }));
      await DB.batch([
        DB.prepare('INSERT INTO contracts (id, title, artist, email, status, notes, created_by, created_at, updated_at, kind, template_id, vars, release_cat, release_name, doc_url, pdf, pdf_hash, pdf_pages, pdf_size, pdf_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, title, clean(cp.artist ?? b.artist, 160), rows[0].email || '', 'draft', '', s.email, t, t, draft ? 'draft' : null, tpl.id, f.vars, draft ? null : clean(b.release_cat, 40) || null, draft ? null : clean(b.release_name, 160) || null, f.docUrl, null, null, f.pages, null, f.state),
        ...rows.map((r, i) => DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email, box) VALUES (?, ?, ?, ?, ?, ?)').bind('s_' + crypto.randomUUID().slice(0, 10), id, i, r.label, r.email || null, r.box || null)),
      ]);
      ids.push(id);
      await audit(`Created the ${draft ? 'draft' : 'contract'} “${title}” from the template “${tpl.title}”`);
      return id;
    };
    // el mismo PDF para todos los contratos de esta llamada
    const put = async (list, buf) => {
      const hash = await sha256(buf), pages = draft ? (tpl.pdf_pages || pdfPages(buf)) : pdfPages(buf), at = now();
      for (const id of list) {
        const key = `contracts/${id}-${hash.slice(0, 12)}.pdf`;
        await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at } });
        await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, pdf_state = NULL, updated_at = ? WHERE id = ?').bind(key, hash, pages, buf.byteLength, at, id).run();
        // otro número de páginas que la plantilla: los recuadros de firma se vuelven a colocar
        if (!(tpl.pdf_pages && tpl.pdf_pages === pages)) await DB.prepare('UPDATE contract_signers SET box = NULL WHERE contract_id = ?').bind(id).run();
      }
      return !!tpl.pdf_pages && tpl.pdf_pages === pages;
    };
    if (draft) {
      const buf = tpl.pdf ? await env.FILES.get(tpl.pdf, { type: 'arrayBuffer' }) : null;
      if (!buf) throw new ContractError(400, 'The draft template has no PDF.');
      for (const cp of copies) await insert(cp, { vars: '{}', docUrl: null, pages: tpl.pdf_pages || null, keepBoxes: false, state: null });
      await put(ids, buf);
    } else {
      if (!tpl.doc_url) throw new ContractError(400, 'That template has no Google Doc.');
      let docUrl;
      try { docUrl = await docFromTemplate(env, tpl.doc_url, values, clean(copies[0].title || b.title, 160) || 'Contract'); }
      catch (e) { throw new ContractError(502, e.message); }
      // más rápido: el contrato se abre ya y Google hace el PDF mientras tanto (unos 2 s); el panel lo carga cuando está
      for (const cp of copies) await insert(cp, { vars: JSON.stringify(values), docUrl, pages: tpl.pdf_pages || null, keepBoxes: true, state: 'making' });
      const list = [...ids];
      const job = exportDocPdf(env, docUrl).then(buf => put(list, buf)).catch(async e => {
        console.error('contract pdf', e.message);
        for (const id of list) await DB.prepare("UPDATE contracts SET pdf_state = ?, updated_at = ? WHERE id = ? AND pdf IS NULL").bind(clean('error: ' + e.message, 300), now(), id).run().catch(() => {});
      });
      if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
      return { ok: true, ids, draft: false, pending: true };
    }
    // un draft se envía en el momento (solo para mirarlo)
    let error = '';
    if (draft && b.send) for (const id of ids) {
      const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(id).first(), sg = await signersOf(env, c);
      const errs = await sendInvites(env, c, sg, sg, url.origin);
      error = error || errs[0] || '';
      await audit(`Sent the draft “${c.title}” to review (${sg.map(r => r.email).join(', ')})${errs.length ? ' — email failed' : ''}`);
    }
    return { ok: !error, ids, draft, error };
  }
  if (p === '/api/contracts' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const title = clean(b.title, 160);
    if (!title) throw new ContractError(400, 'Give the contract a title.');
    const email = clean(b.email, 160).toLowerCase();
    if (email && !EMAIL.test(email)) throw new ContractError(400, 'The artist email is not valid.');
    if (b.id) {
      const c = await DB.prepare('SELECT status FROM contracts WHERE id = ?').bind(String(b.id)).first();
      if (!c) throw new ContractError(404, 'That contract no longer exists.');
      if (c.status === 'signed') {   // firmado: solo las notas internas y a qué release pertenece
        await DB.prepare('UPDATE contracts SET notes = ?, updated_at = ? WHERE id = ?').bind(clean(b.notes, 2000), now(), String(b.id)).run();
        if ('release_cat' in b) await DB.prepare('UPDATE contracts SET release_cat = ?, release_name = ? WHERE id = ?').bind(clean(b.release_cat, 40) || null, clean(b.release_name, 160) || null, String(b.id)).run();
        return { ok: true, id: b.id };
      }
      await DB.prepare('UPDATE contracts SET title = ?, artist = ?, email = ?, notes = ?, updated_at = ? WHERE id = ?')
        .bind(title, clean(b.artist, 160), email, clean(b.notes, 2000), now(), String(b.id)).run();
      if ('release_cat' in b || 'release_name' in b) await DB.prepare('UPDATE contracts SET release_cat = ?, release_name = ? WHERE id = ?').bind(clean(b.release_cat, 40) || null, clean(b.release_name, 160) || null, String(b.id)).run();
      // datos de cada firmante (nombre del hueco y email)
      if (Array.isArray(b.signers)) for (const x of b.signers.slice(0, MAX_SIGNERS)) {
        const em = clean(x?.email, 160).toLowerCase();
        if (em && !EMAIL.test(em)) throw new ContractError(400, `The email of “${clean(x?.label, 60) || 'signer'}” is not valid.`);
        await DB.prepare('UPDATE contract_signers SET label = ?, email = ? WHERE id = ? AND contract_id = ? AND signed_at IS NULL').bind(clean(x?.label, 60) || null, em || null, String(x?.id || ''), String(b.id)).run();
      }
      if (b.vars && typeof b.vars === 'object') { const v = {}; for (const [k, x] of Object.entries(b.vars).slice(0, 60)) v[clean(k, 60)] = clean(x, 500); await DB.prepare('UPDATE contracts SET vars = ? WHERE id = ?').bind(JSON.stringify(v), String(b.id)).run(); }
      await audit(`Edited the details of contract “${title}”`);
      return { ok: true, id: b.id };
    }
    const id = 'c_' + crypto.randomUUID().slice(0, 10);
    const kind = b.kind === 'template' ? 'template' : null;
    // contrato a partir de una plantilla: hereda sus firmantes (nombre del hueco y dónde firma)
    const tpl = b.template ? await DB.prepare(`SELECT * FROM contracts WHERE id = ? AND kind = 'template'`).bind(String(b.template)).first() : null;
    if (b.template && !tpl) throw new ContractError(404, 'That template no longer exists.');
    const vars = {};
    if (b.vars && typeof b.vars === 'object') for (const [k, v] of Object.entries(b.vars).slice(0, 60)) vars[clean(k, 60)] = clean(v, 500);
    await DB.prepare('INSERT INTO contracts (id, title, artist, email, status, notes, created_by, created_at, updated_at, kind, template_id, vars, pdf_pages, release_cat, release_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, title, clean(b.artist, 160), email, 'draft', clean(b.notes, 2000), s.email, now(), now(), kind, tpl?.id || null, JSON.stringify(vars), tpl?.pdf_pages || null, clean(b.release_cat, 40) || null, clean(b.release_name, 160) || null).run();
    const from = tpl ? await signersOf(env, tpl) : [];
    if (from.length) {
      await DB.batch(from.map((r, i) => DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email, box) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('s_' + crypto.randomUUID().slice(0, 10), id, i, r.label || null, i === 0 && email ? email : null, r.box || null)));
    } else {
      await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label, email) VALUES (?, ?, 0, ?, ?)').bind('s_' + crypto.randomUUID().slice(0, 10), id, 'Artist', kind ? null : email || null).run();
    }
    await audit(kind ? `Created the template “${title}”` : `Created the contract “${title}”${tpl ? ` from the template “${tpl.title}”` : ''}`);
    return { ok: true, id };
  }
  const mm = p.match(/^\/api\/contracts\/([\w-]+)(?:\/(pdf|box|signers|send|void|unvoid|file|doc|from-doc|signed|finish|drive|drive-save))?$/);
  if (!mm) throw new ContractError(404, 'Not found.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(mm[1]).first();
  if (!c) throw new ContractError(404, 'That contract no longer exists.');
  const signed = c.status === 'signed';
  const sg = await signersOf(env, c);
  const anySigned = sg.some(r => r.signed_at);

  if (!mm[2] && m === 'GET') {
    const events = (await DB.prepare('SELECT e.at, e.event, e.ip, e.ua, s.label, s.email FROM contract_events e LEFT JOIN contract_signers s ON s.id = e.signer_id WHERE e.contract_id = ? ORDER BY e.id DESC LIMIT 200').bind(c.id).all()).results;
    return { contract: out(c, sg, true), events };
  }
  if (!mm[2] && m === 'DELETE') {
    edit();
    if ((signed || anySigned) && !s.owner) throw new ContractError(403, 'Only owners can delete a signed contract.');
    // (lo que hicieron los artistas se queda en Activity como «Deleted contract»; la fecha del calendario deja de apuntar a él)
    await DB.batch([DB.prepare('DELETE FROM contract_signers WHERE contract_id = ?').bind(c.id), DB.prepare('DELETE FROM contracts WHERE id = ?').bind(c.id),
      DB.prepare('UPDATE calendar SET contract_id = NULL WHERE contract_id = ?').bind(c.id)]);
    for (const k of [c.pdf, c.file, c.signed_pdf]) if (k) await env.FILES.delete(k);
    await audit(`Deleted the contract “${c.title}”${signed ? ' (signed)' : ''}`);
    return { ok: true };
  }
  if (mm[2] === 'pdf' && m === 'POST') {
    // el PDF exacto exportado de Google Docs. La huella SHA-256 la calcula el navegador del owner al subirlo.
    edit();
    if (signed || anySigned) throw new ContractError(409, 'Someone already signed this contract: the PDF can’t be changed.');
    const hash = String(url.searchParams.get('hash') || '');
    const pages = Math.max(1, Math.min(500, Number(url.searchParams.get('pages')) || 1));
    if (!HASH.test(hash)) throw new ContractError(400, 'PDF fingerprint missing.');
    const buf = await pdfBody(req);
    const key = `contracts/${c.id}-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    if (c.pdf && c.pdf !== key) await env.FILES.delete(c.pdf);
    await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, updated_at = ? WHERE id = ?').bind(key, hash, pages, buf.byteLength, now(), c.id).run();
    if (!(c.pdf_pages && c.pdf_pages === pages)) await DB.prepare('UPDATE contract_signers SET box = NULL WHERE contract_id = ?').bind(c.id).run();
    await audit(`Uploaded the PDF of contract “${c.title}” (${pages} pages)`);
    return { ok: true };
  }
  if (mm[2] === 'doc' && m === 'POST') {
    // pestaña del Google Doc de la que sale este contrato
    edit();
    const u = String((parse(await req.text()) || {}).url || '').trim();
    if (u && !parseDoc(u)) throw new ContractError(400, 'Paste the Google Doc tab link (docs.google.com/document/d/…?tab=…).');
    await DB.prepare('UPDATE contracts SET doc_url = ?, updated_at = ? WHERE id = ?').bind(u || null, now(), c.id).run();
    return { ok: true };
  }
  if (mm[2] === 'from-doc' && m === 'POST') {
    // el PDF lo genera Google desde la pestaña del Doc (idéntico). El token de Google lo da el navegador del owner
    // en ese momento (no se guarda).
    edit();
    if (signed || anySigned) throw new ContractError(409, 'Someone already signed this contract: the PDF can’t be changed.');
    const buf = await exportDocPdf(env, c.doc_url, String((parse(await req.text()) || {}).token || ''));
    const hash = await sha256(buf), pages = pdfPages(buf);
    const key = `contracts/${c.id}-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    if (c.pdf && c.pdf !== key) await env.FILES.delete(c.pdf);
    await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, pdf_state = NULL, updated_at = ? WHERE id = ?').bind(key, hash, pages, buf.byteLength, now(), c.id).run();
    if (!(c.pdf_pages && c.pdf_pages === pages)) await DB.prepare('UPDATE contract_signers SET box = NULL WHERE contract_id = ?').bind(c.id).run();
    await audit(`Generated the PDF of “${c.title}” from the Google Doc (${pages} pages)`);
    return { ok: true, pages, changedPages: !(c.pdf_pages && c.pdf_pages === pages) };
  }
  if (mm[2] === 'pdf' && m === 'GET') {
    if (!c.pdf) throw new ContractError(404, 'This contract has no PDF yet.');
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'PDF not found.');
    return pdfResponse(f, `${c.id}.pdf`);
  }
  if (mm[2] === 'box' && m === 'POST') {
    edit();
    const body = parse(await req.text()) || {};
    const r = sg.find(x => x.id === String(body.signer || '')) || (sg.length === 1 ? sg[0] : null);
    if (!r) throw new ContractError(400, 'Choose whose signature it is.');
    if (r.signed_at) throw new ContractError(409, 'That person has already signed.');
    const b = box(body.box || body);
    if (!b || b.page >= (c.pdf_pages || 1)) throw new ContractError(400, 'Invalid signature position.');
    await DB.prepare('UPDATE contract_signers SET box = ? WHERE id = ?').bind(JSON.stringify(b), r.id).run();
    return { ok: true, box: b };
  }
  if (mm[2] === 'signers' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'This contract is already signed.');
    const body = parse(await req.text()) || {};
    if (body.action === 'add') {
      if (sg.length >= MAX_SIGNERS) throw new ContractError(400, `Maximum ${MAX_SIGNERS} signers.`);
      const idx = sg.length ? Math.max(...sg.map(r => r.idx)) + 1 : 0;
      await DB.prepare('INSERT INTO contract_signers (id, contract_id, idx, label) VALUES (?, ?, ?, ?)').bind('s_' + crypto.randomUUID().slice(0, 10), c.id, idx, clean(body.label, 60) || `Artist ${idx + 1}`).run();
      if (sg.length === 1 && sg[0].label === 'Artist') await DB.prepare('UPDATE contract_signers SET label = ? WHERE id = ?').bind('Artist 1', sg[0].id).run();
      await audit(`Added a signer to “${c.title}”`);
      return { ok: true };
    }
    if (body.action === 'remove') {
      const r = sg.find(x => x.id === String(body.signer || ''));
      if (!r) throw new ContractError(404, 'That signer no longer exists.');
      if (r.signed_at) throw new ContractError(409, 'That person has already signed: they can’t be removed.');
      if (sg.length <= 1) throw new ContractError(400, 'A contract needs at least one signer.');
      await DB.prepare('DELETE FROM contract_signers WHERE id = ?').bind(r.id).run();
      await audit(`Removed the signer “${r.label || r.email || 'Artist'}” from “${c.title}”`);
      // si los que quedan ya habían firmado todos, el contrato queda firmado (antes se quedaba esperando a nadie)
      const rest = sg.filter(x => x.id !== r.id);
      if (c.status === 'sent' && rest.every(x => x.signed_at)) {
        const at = Math.max(...rest.map(x => x.signed_at));
        await DB.prepare(`UPDATE contracts SET status = 'signed', signed_at = ?, doc_hash = ?, updated_at = ? WHERE id = ?`).bind(at, c.pdf_hash, now(), c.id).run();
        const job = finalize(env, c.id, url.origin).catch(e => console.error('finalize', e));
        if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
        return { ok: true, signed: true };
      }
      return { ok: true };
    }
    throw new ContractError(400, 'Invalid action.');
  }
  if (c.kind === 'template' && ['send', 'void', 'unvoid', 'file'].includes(mm[2]) && m === 'POST') throw new ContractError(400, 'A template isn’t sent: create a contract from it.');
  if (mm[2] === 'send' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'This contract is already signed.');
    if (!c.pdf) throw new ContractError(400, 'Upload the contract PDF first.');
    if (c.status === 'void') throw new ContractError(409, 'This contract is voided.');
    const missing = isDraftRow(c) ? [] : sg.filter(r => !r.box);
    if (missing.length) throw new ContractError(400, `Signature spot not set for: ${missing.map(r => r.label || `Artist ${r.idx + 1}`).join(', ')}.`);
    const noMail = sg.filter(r => !r.signed_at && !EMAIL.test(r.email || ''));
    if (noMail.length) throw new ContractError(400, `Write the email of: ${noMail.map(r => r.label || `Artist ${r.idx + 1}`).join(', ')}.`);
    const body = parse(await req.text()) || {};
    // a quién: uno concreto (reenviar) o todos los que aún no lo han recibido
    const to = body.signer ? sg.filter(r => r.id === String(body.signer) && !r.signed_at) : sg.filter(r => !r.signed_at && !r.emailed_at);
    const errors = await sendInvites(env, c, sg, to, url.origin);
    const sent = to.length - errors.length;
    await audit(`Sent “${c.title}” to sign${to.length ? ` (${to.map(r => r.email).join(', ')})` : ''}${errors.length ? ' — email failed' : ''}`);
    return { ok: !errors.length, sent, error: errors[0] || '' };
  }
  if ((mm[2] === 'void' || mm[2] === 'unvoid') && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'A signed contract can’t be voided from here.');
    const st = mm[2] === 'void' ? 'void' : (sg.some(r => r.token) ? 'sent' : 'draft');
    await DB.prepare('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?').bind(st, now(), c.id).run();
    await audit(`${mm[2] === 'void' ? 'Voided' : 'Reactivated'} the contract “${c.title}”`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'POST') {
    // archivo: PDF de un contrato que se firmó fuera de la web (antiguos)
    edit();
    const buf = await pdfBody(req);
    const key = `contracts/${c.id}-firmado.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    await DB.prepare(`UPDATE contracts SET file = ?, status = 'signed', signed_at = COALESCE(signed_at, ?), updated_at = ? WHERE id = ?`).bind(key, now(), now(), c.id).run();
    await audit(`Uploaded the signed PDF of “${c.title}”`);
    return { ok: true };
  }
  if (mm[2] === 'signed' && m === 'POST') {
    // PDF firmado oficial: lo crea el panel (original + firmas + certificado) y se guarda una vez
    edit();
    if (!signed || sg.some(r => !r.signed_at)) throw new ContractError(409, 'Not everyone has signed yet.');
    if (c.signed_pdf) return { ok: true };
    const buf = await pdfBody(req);
    const hash = await sha256(buf);
    const key = `contracts/${c.id}-signed-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    await DB.prepare('UPDATE contracts SET signed_pdf = ?, signed_hash = ? WHERE id = ?').bind(key, hash, c.id).run();
    return { ok: true };
  }
  if (mm[2] === 'signed' && m === 'GET') {
    if (!c.signed_pdf) throw new ContractError(404, 'The signed PDF is not ready yet.');
    const f = await env.FILES.get(c.signed_pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'PDF not found.');
    return pdfResponse(f, signedName(c).replace(/[^\w\- .()]+/g, ''));
  }
  if (mm[2] === 'finish' && m === 'POST') {
    edit();
    if (!signed || c.file) throw new ContractError(400, 'This contract is not signed online by everyone yet.');
    const r = await finalize(env, c.id, url.origin);
    const after = await DB.prepare('SELECT finish_error FROM contracts WHERE id = ?').bind(c.id).first();
    return { ok: r.ok, error: after?.finish_error || '' };
  }
  if (mm[2] === 'drive-save' && m === 'POST') {
    // guardar el contrato firmado en el Drive de Horizon (lo hace el servidor)
    edit();
    if (!signed) throw new ContractError(400, 'Only signed contracts go to Drive.');
    const root = (await DB.prepare("SELECT value FROM panel_settings WHERE key = 'contracts_drive'").first())?.value;
    if (!root) throw new ContractError(400, 'Paste the Drive folder link first (Contracts → Signed).');
    const b = parse(await req.text()) || {};
    if (c.drive_url && !b.again) return { ok: true, drive_url: c.drive_url, already: true };   // ya está en Drive: no se guarda otra vez
    const key = c.signed_pdf || c.file;
    if (!key) throw new ContractError(409, 'The signed PDF is not ready yet. Open the contract once and try again.');
    // año de salida: el del calendario (fecha de este contrato, de su número de release o de su artista y track)
    const cal = (await DB.prepare('SELECT date, cat, artist, title, contract_id FROM calendar').all().catch(() => ({ results: [] }))).results;
    const num = v => { const x = String(v || '').match(/(\d+)\s*$/); return x ? Number(x[1]) : null; };
    const nrm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
    const mine = cal.find(x => x.contract_id === c.id) || (num(c.release_cat) !== null ? cal.find(x => num(x.cat) === num(c.release_cat)) : null)
      || (c.release_name ? cal.find(x => nrm(x.title) === nrm(c.release_name) && nrm(String(x.artist || '').split(/\s*(?:,|&|\band\b)\s*/i)[0]) === nrm(String(c.artist || '').split(/\s*(?:,|&|\band\b)\s*/i)[0])) : null);
    // guardado automático: solo cuando el release ya tiene su fecha en el calendario (si no, se espera)
    if (b.auto && !mine) return { ok: false, waiting: true };
    const lockKey = num(c.release_cat) !== null ? `rel:${num(c.release_cat)}` : `c:${c.id}`, t0 = now();
    const lock = await DB.prepare('INSERT INTO drive_locks (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at WHERE drive_locks.at < ?').bind(lockKey, t0, t0 - 120e3).run();
    if (!lock.meta.changes) throw new ContractError(409, 'Already saving it in Drive. Try again in a moment.');
    try {
      // otro panel pudo guardarlo justo antes
      const fresh = await DB.prepare('SELECT drive_url FROM contracts WHERE id = ?').bind(c.id).first();
      if (fresh?.drive_url && !b.again) return { ok: true, drive_url: fresh.drive_url, already: true };
      const buf = await env.FILES.get(key, { type: 'arrayBuffer' });
      if (!buf) throw new ContractError(404, 'PDF not found.');
      const known = cal.filter(x => num(x.cat) !== null).map(x => ({ n: num(x.cat), year: Number(x.date.slice(0, 4)) }));
      let r;
      try { r = await saveToDrive(env, root, c, new Uint8Array(buf), { year: mine ? Number(mine.date.slice(0, 4)) : null, known }); } catch (e) { throw new ContractError(502, e.message); }
      await DB.prepare('UPDATE contracts SET drive_id = ?, drive_url = ? WHERE id = ?').bind(r.id, `https://drive.google.com/file/d/${r.id}/view`, c.id).run();
      await audit(`Saved the signed “${c.title}” in Google Drive (${r.path})`);
      return { ok: true, drive_url: `https://drive.google.com/file/d/${r.id}/view` };
    } finally { await DB.prepare('DELETE FROM drive_locks WHERE key = ? AND at = ?').bind(lockKey, t0).run(); }
  }
  if (mm[2] === 'drive' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const fid = String(b.id || '');
    if (!/^[\w-]{10,100}$/.test(fid)) throw new ContractError(400, 'Invalid Drive file.');
    await DB.prepare('UPDATE contracts SET drive_id = ?, drive_url = ? WHERE id = ?').bind(fid, `https://drive.google.com/file/d/${fid}/view`, c.id).run();
    await audit(`Saved the signed “${c.title}” in Google Drive${b.path ? ` (${clean(b.path, 200)})` : ''}`);
    return { ok: true };
  }
  if (mm[2] === 'file' && m === 'GET') {
    if (!c.file) throw new ContractError(404, 'This contract has no uploaded signed PDF.');
    const f = await env.FILES.get(c.file, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'PDF not found.');
    return pdfResponse(f, `${c.id}-firmado.pdf`);
  }
  throw new ContractError(404, 'Not found.');
}

/* Firma (pública, con el enlace privado de cada firmante). Para entrar hay que escribir el email al que se envió
   el contrato (cabecera X-Signer-Email en cada petición); tras 10 intentos fallidos el enlace se bloquea. */
const MAX_FAILS = 10;
export async function signApi(req, env, url, mail, ctx) {
  const DB = env.DB;
  const mm = url.pathname.match(/^\/api\/public\/sign\/([\w-]{20,64})(?:\/(pdf|signed|open|event))?$/);
  if (!mm) throw new ContractError(404, 'Not found.');
  let me = await DB.prepare('SELECT * FROM contract_signers WHERE token = ?').bind(mm[1]).first();
  let c = me ? await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(me.contract_id).first() : await DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(mm[1]).first();
  if (!c || c.status === 'draft' || !c.pdf) throw new ContractError(404, 'This contract link is not valid.');
  if (c.status === 'void') throw new ContractError(410, 'This contract has been cancelled by HORIZON RCRDS.');
  let sg = await signersOf(env, c);
  if (!me) me = sg.find(r => r.token === mm[1]);
  if (!me) throw new ContractError(404, 'This contract link is not valid.');
  const ip = req.headers.get('CF-Connecting-IP') || '', ua = clean(req.headers.get('User-Agent'), 300);
  const log = (event, extra = '') => DB.prepare('INSERT INTO contract_events (contract_id, signer_id, at, event, ip, ua) VALUES (?, ?, ?, ?, ?, ?)').bind(c.id, me.id, now(), event + (extra ? ' ' + extra : ''), ip, ua).run();

  // Acceso: el enlace es único y solo se abre escribiendo el email al que se envió. Tras 10 intentos fallidos, se bloquea.
  const need = String(me.email || '').toLowerCase();
  if (need) {
    if ((me.fails || 0) >= MAX_FAILS) throw new ContractError(429, 'This link has been locked after too many attempts. Please contact HORIZON RCRDS to get a new one.');
    if (mm[2] === 'open' && req.method === 'POST') {
      const email = clean((parse(await req.text()) || {}).email, 160).toLowerCase();
      if (email !== need) {
        await DB.prepare('UPDATE contract_signers SET fails = COALESCE(fails, 0) + 1 WHERE id = ?').bind(me.id).run();
        throw new ContractError(403, 'That email does not match this contract. Use the email address where you received it.');
      }
      const sess = token(), t = now();
      await DB.batch([
        DB.prepare('DELETE FROM sign_sessions WHERE expires_at < ?').bind(t),
        DB.prepare('INSERT INTO sign_sessions (hash, signer_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(new TextEncoder().encode(sess)), me.id, t + 12 * 3600e3),
        DB.prepare('UPDATE contract_signers SET fails = 0 WHERE id = ?').bind(me.id),
      ]);
      await log('opened');
      return { ok: true, session: sess };
    }
    const sess = String(req.headers.get('X-Sign-Session') || '');
    const ok = sess && await DB.prepare('SELECT 1 FROM sign_sessions WHERE hash = ? AND signer_id = ? AND expires_at > ?').bind(await sha256(new TextEncoder().encode(sess)), me.id, now()).first();
    if (!ok) { if (mm[2] || req.method !== 'GET') throw new ContractError(401, 'Please open the contract again with your email.'); return { gate: true }; }
  }
  const draft = isDraftRow(c);
  if (draft && (mm[2] === 'signed' || req.method === 'POST' && mm[2] !== 'event')) throw new ContractError(403, 'This is a draft: it is only for review.');
  if (mm[2] === 'event' && req.method === 'POST') {
    // lo que hace el artista en la página (leído hasta el final, descargado…)
    const ev = String((parse(await req.text()) || {}).event || '');
    if (ev === 'read to the end') await log(ev);
    return { ok: true };
  }
  if (mm[2] === 'pdf') {
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'Contract file not found.');
    return pdfResponse(f, 'contract.pdf');
  }
  if (mm[2] === 'signed') {
    const f = c.signed_pdf ? await env.FILES.get(c.signed_pdf, { type: 'arrayBuffer' }) : null;
    if (!f || sg.some(r => !r.signed_at)) throw new ContractError(404, 'The signed contract is not ready yet. Please try again in a moment.');
    await log('downloaded the signed PDF');
    return pdfResponse(f, signedName(c).replace(/[^\w\- .()]+/g, ''));
  }
  const view = () => ({
    title: mailName(c), status: c.status, draft, pdf_hash: c.pdf_hash, email: me.email || '', signed_pdf: !!c.signed_pdf,
    me: { index: sg.findIndex(x => x.id === me.id), label: me.label || 'Artist', name: legalName(c, me, sg), box: box(me.box), signed: !!me.signed_at },
    // firmas de todos (las que ya existen), para verlas en su sitio y crear el PDF firmado
    signers: sg.map(r => ({ label: r.label || '', box: box(r.box), signed: r.signed_at ? { at: r.signed_at, name: r.name, email: r.signer_email, signature: r.signature, ip: r.ip, ua: r.ua } : null })),
  });
  if (req.method === 'GET') return view();
  if (req.method !== 'POST') throw new ContractError(405, 'Not allowed.');
  if (me.signed_at) throw new ContractError(409, 'You have already signed this contract.');
  const b = parse(await req.text()) || {};
  // firma a nombre del nombre legal que pusimos en el contrato (el artista no lo escribe)
  const name = clean(legalName(c, me, sg), 160) || clean(b.name, 160), email = need || clean(b.email, 160).toLowerCase();
  if (name.length < 2) throw new ContractError(400, 'This contract has no legal name for you. Please contact HORIZON RCRDS.');
  if (!EMAIL.test(email)) throw new ContractError(400, 'Please write a valid email.');
  if (!b.agree) throw new ContractError(400, 'Please confirm that you have read and agree to the contract.');
  let signature = '';
  if (typeof b.signature === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.signature) && b.signature.length < 300000) signature = b.signature;
  else if (clean(b.typed, 120)) signature = 'typed:' + clean(b.typed, 120);
  else throw new ContractError(400, 'Please sign (draw your signature or type your name).');
  if (String(b.hash || '') !== c.pdf_hash) throw new ContractError(409, 'The contract file changed while you were reading it. Please reload the page.');
  const at = now();
  const r = await DB.prepare('UPDATE contract_signers SET signed_at = ?, name = ?, signer_email = ?, signature = ?, ip = ?, ua = ? WHERE id = ? AND signed_at IS NULL')
    .bind(at, name, email, signature, ip, ua, me.id).run();
  if (!r.meta.changes) throw new ContractError(409, 'You have already signed this contract.');
  sg = await signersOf(env, c);
  const all = sg.every(x => x.signed_at);
  if (all) await DB.prepare(`UPDATE contracts SET status = 'signed', signed_at = ?, doc_hash = ?, updated_at = ? WHERE id = ?`).bind(at, c.pdf_hash, at, c.id).run();
  c = { ...c, status: all ? 'signed' : c.status };
  me = sg.find(x => x.id === me.id);
  await log('signed', `as ${name}`);
  // todos han firmado: correo a cada firmante con su enlace para descargar (a la cuenta de Horizon no le llega nada)
  const after = async () => { if (all) { try { await finalize(env, c.id, url.origin); } catch (e) { console.error('finalize', e); } } };
  if (ctx?.waitUntil) ctx.waitUntil(after()); else await after();
  return view();
}
