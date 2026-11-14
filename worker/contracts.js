/* Contratos de HORIZON RCRDS — el documento es SIEMPRE el PDF exportado del Google Doc del sello (idéntico, sin
   convertir nada). El panel guarda ese PDF, dónde va la firma del artista (página y recuadro) y el enlace de firma.
   - El artista ve el PDF tal cual (/sign/<token>) y firma (dibujada o escrita).
   - Se guarda: nombre legal, email, firma, fecha, IP, navegador y la huella SHA-256 del PDF exacto que vio.
     Si la huella no coincide con la del PDF guardado, no se firma.
   - El PDF firmado se genera en el navegador a partir del PDF original + la firma guardada (pdf-lib): la firma va en el
     recuadro elegido y se añade una página de certificado. Nada del documento original cambia.
   - Si está configurado el correo (binding MAIL), llega un aviso al Gmail de Horizon.
   Permiso: sección «contracts» de los roles (ver / editar). Los owners siempre. */

export class ContractError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const now = () => Date.now();
const token = () => { const u = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_PDF = 20 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

export const CONTRACT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, email TEXT, template_id TEXT, html TEXT NOT NULL DEFAULT '', vars TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', token TEXT UNIQUE, notes TEXT, file TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, sent_at INTEGER, signed_at INTEGER, signer_name TEXT, signer_email TEXT, signature TEXT, sign_ip TEXT, sign_ua TEXT, doc_hash TEXT, countersigned_by TEXT)`,
];
// columnas del PDF (añadidas después: si ya existen, no pasa nada)
export const CONTRACT_COLUMNS = ['pdf TEXT', 'pdf_hash TEXT', 'pdf_pages INTEGER', 'pdf_size INTEGER', 'sign_box TEXT'];

function box(v) {
  const b = typeof v === 'string' ? parse(v) : v;
  if (!b) return null;
  const n = x => Math.min(1, Math.max(0, Number(x) || 0));
  return { page: Math.max(0, Math.floor(Number(b.page) || 0)), x: n(b.x), y: n(b.y), w: Math.max(0.03, n(b.w)), h: Math.max(0.02, n(b.h)) };
}
const out = c => ({
  id: c.id, title: c.title, artist: c.artist || '', email: c.email || '', status: c.status, notes: c.notes || '', token: c.token || '',
  pdf: !!c.pdf, pdf_hash: c.pdf_hash || '', pdf_pages: c.pdf_pages || 0, pdf_size: c.pdf_size || 0, box: box(c.sign_box), file: !!c.file,
  created_at: c.created_at, updated_at: c.updated_at, sent_at: c.sent_at, signed_at: c.signed_at,
  signer_name: c.signer_name || '', signer_email: c.signer_email || '', sign_ip: c.sign_ip || '', sign_ua: c.sign_ua || '',
  signature: c.signature || '',
});

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
    return { contracts: rows.map(c => { const o = out(c); delete o.signature; return o; }), canEdit: can('edit') && !s.sync };
  }
  if (p === '/api/contracts' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const title = clean(b.title, 160);
    if (!title) throw new ContractError(400, 'Ponle un título al contrato.');
    const email = clean(b.email, 160).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new ContractError(400, 'El email del artista no es válido.');
    if (b.id) {
      const c = await DB.prepare('SELECT status FROM contracts WHERE id = ?').bind(String(b.id)).first();
      if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
      if (c.status === 'signed') {   // firmado: solo las notas internas
        await DB.prepare('UPDATE contracts SET notes = ?, updated_at = ? WHERE id = ?').bind(clean(b.notes, 2000), now(), String(b.id)).run();
        return { ok: true, id: b.id };
      }
      await DB.prepare('UPDATE contracts SET title = ?, artist = ?, email = ?, notes = ?, updated_at = ? WHERE id = ?')
        .bind(title, clean(b.artist, 160), email, clean(b.notes, 2000), now(), String(b.id)).run();
      await audit(`Editó los datos del contrato «${title}»`);
      return { ok: true, id: b.id };
    }
    const id = 'c_' + crypto.randomUUID().slice(0, 10);
    await DB.prepare('INSERT INTO contracts (id, title, artist, email, status, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, title, clean(b.artist, 160), email, 'draft', clean(b.notes, 2000), s.email, now(), now()).run();
    await audit(`Creó el contrato «${title}»`);
    return { ok: true, id };
  }
  const mm = p.match(/^\/api\/contracts\/([\w-]+)(?:\/(pdf|box|send|void|unvoid|file))?$/);
  if (!mm) throw new ContractError(404, 'No encontrado.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(mm[1]).first();
  if (!c) throw new ContractError(404, 'Ese contrato ya no existe.');
  const signed = c.status === 'signed';

  if (!mm[2] && m === 'GET') return { contract: out(c) };
  if (!mm[2] && m === 'DELETE') {
    edit();
    if (signed && !s.owner) throw new ContractError(403, 'Solo los owners pueden borrar un contrato firmado.');
    await DB.prepare('DELETE FROM contracts WHERE id = ?').bind(c.id).run();
    for (const k of [c.pdf, c.file]) if (k) await env.FILES.delete(k);
    await audit(`Eliminó el contrato «${c.title}»${signed ? ' (firmado)' : ''}`);
    return { ok: true };
  }
  if (mm[2] === 'pdf' && m === 'POST') {
    // el PDF exacto exportado de Google Docs. La huella SHA-256 la calcula el navegador del owner al subirlo.
    edit();
    if (signed) throw new ContractError(409, 'Este contrato ya está firmado: el PDF no se puede cambiar.');
    const hash = String(url.searchParams.get('hash') || '');
    const pages = Math.max(1, Math.min(500, Number(url.searchParams.get('pages')) || 1));
    if (!HASH.test(hash)) throw new ContractError(400, 'Falta la huella del PDF.');
    const buf = await pdfBody(req);
    const key = `contracts/${c.id}-${hash.slice(0, 12)}.pdf`;
    await env.FILES.put(key, buf, { metadata: { type: 'application/pdf', at: now() } });
    if (c.pdf && c.pdf !== key) await env.FILES.delete(c.pdf);
    const keepBox = c.pdf_pages && c.pdf_pages === pages;
    await DB.prepare('UPDATE contracts SET pdf = ?, pdf_hash = ?, pdf_pages = ?, pdf_size = ?, sign_box = ?, updated_at = ? WHERE id = ?')
      .bind(key, hash, pages, buf.byteLength, keepBox ? c.sign_box : null, now(), c.id).run();
    await audit(`Subió el PDF del contrato «${c.title}» (${pages} páginas)`);
    return { ok: true };
  }
  if (mm[2] === 'pdf' && m === 'GET') {
    if (!c.pdf) throw new ContractError(404, 'Este contrato aún no tiene PDF.');
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'No se encuentra el PDF.');
    return pdfResponse(f, `${c.id}.pdf`);
  }
  if (mm[2] === 'box' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Este contrato ya está firmado.');
    const b = box(await req.text());
    if (!b || b.page >= (c.pdf_pages || 1)) throw new ContractError(400, 'Lugar de firma no válido.');
    await DB.prepare('UPDATE contracts SET sign_box = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(b), now(), c.id).run();
    return { ok: true, box: b };
  }
  if (mm[2] === 'send' && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Este contrato ya está firmado.');
    if (!c.pdf) throw new ContractError(400, 'Sube primero el PDF del contrato.');
    if (!c.sign_box) throw new ContractError(400, 'Marca primero dónde firma el artista (haz clic en la página).');
    const tk = c.token || token();
    await DB.prepare('UPDATE contracts SET token = ?, status = ?, sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?').bind(tk, 'sent', now(), now(), c.id).run();
    await audit(`Preparó el enlace de firma de «${c.title}»`);
    return { ok: true, token: tk };
  }
  if ((mm[2] === 'void' || mm[2] === 'unvoid') && m === 'POST') {
    edit();
    if (signed) throw new ContractError(409, 'Un contrato firmado no se puede anular desde aquí.');
    const st = mm[2] === 'void' ? 'void' : (c.token ? 'sent' : 'draft');
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

/* Firma (pública, con el enlace privado). */
export async function signApi(req, env, url, mail) {
  const DB = env.DB;
  const mm = url.pathname.match(/^\/api\/public\/sign\/([\w-]{20,64})(\/pdf)?$/);
  if (!mm) throw new ContractError(404, 'Not found.');
  const c = await DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(mm[1]).first();
  if (!c || c.status === 'draft' || !c.pdf) throw new ContractError(404, 'This contract link is not valid.');
  if (c.status === 'void') throw new ContractError(410, 'This contract has been cancelled by HORIZON RCRDS.');
  if (mm[2]) {
    const f = await env.FILES.get(c.pdf, { type: 'arrayBuffer' });
    if (!f) throw new ContractError(404, 'Contract file not found.');
    return pdfResponse(f, 'contract.pdf');
  }
  const view = () => ({
    title: c.title, artist: c.artist || '', email: c.email || '', status: c.status, pdf_hash: c.pdf_hash, box: box(c.sign_box),
    signed: c.status === 'signed' ? { at: c.signed_at, name: c.signer_name, email: c.signer_email, signature: c.signature, hash: c.doc_hash, ip: c.sign_ip, ua: c.sign_ua } : null,
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
  if (String(b.hash || '') !== c.pdf_hash) throw new ContractError(409, 'The contract file changed while you were reading it. Please reload the page.');
  const ip = req.headers.get('CF-Connecting-IP') || '', ua = clean(req.headers.get('User-Agent'), 300), at = now();
  const r = await DB.prepare('UPDATE contracts SET status = ?, signed_at = ?, signer_name = ?, signer_email = ?, signature = ?, sign_ip = ?, sign_ua = ?, doc_hash = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind('signed', at, name, email, signature, ip, ua, c.pdf_hash, at, c.id, 'sent').run();
  if (!r.meta.changes) throw new ContractError(409, 'This contract is already signed.');
  await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(at, email, name, `Firmó el contrato «${c.title}»`, `IP ${ip}`).run();
  Object.assign(c, { status: 'signed', signed_at: at, signer_name: name, signer_email: email, signature, sign_ip: ip, sign_ua: ua, doc_hash: c.pdf_hash });
  if (mail) {
    try {
      await mail(`Contrato firmado: ${c.title}`, `
        <p><b>${escHtml(name)}</b> ha firmado <b>${escHtml(c.title)}</b>.</p>
        <p>Email: ${escHtml(email)}<br>Fecha: ${new Date(at).toUTCString()}<br>IP: ${escHtml(ip)}<br>Huella del PDF (SHA-256): ${c.pdf_hash}</p>
        <p>Ver y descargar el contrato firmado: <a href="${url.origin}/sign/${c.token}">${url.origin}/sign/${c.token}</a></p>
        <p>También está en el panel → Contratos.</p>`);
    } catch (e) { console.error('mail', e); }
  }
  return view();
}
