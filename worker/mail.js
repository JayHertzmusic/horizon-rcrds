/* Mail: el Gmail de Horizon dentro del panel (Gmail API, gratis).
   - El permiso de Google sale del script de Apps Script de Horizon (el mismo token que Contracts, con el permiso de Gmail).
   - Lo ven los owners y la persona a la que un owner le dé acceso (panel_members.mail = 1), las dos con la bandeja completa.
   - Los correos salen como contact@horizonrcrds.com cuando ese «Enviar como» está listo en Gmail; si no, como el Gmail.
   - Carpetas (Inbox, Starred, Important, Sent, Drafts, Spam, Trash, All mail), etiquetas propias, pestañas de Gmail
     (Primary/Promotions/Social/Updates), acciones en lote, firma de Gmail y plantillas (guardadas en el panel).
   - El servidor casi no procesa nada (plan gratis = poca CPU): el navegador descodifica los correos y monta el mensaje. */
import { horizonToken, dropHorizonToken } from './gdocs.js';

export class MailError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const MAIL_FROM_ADDR = 'contact@horizonrcrds.com';
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
// carpeta → etiquetas de Gmail (o búsqueda)
const BOXES = {
  inbox: { labels: ['INBOX'] }, starred: { labels: ['STARRED'] }, important: { labels: ['IMPORTANT'] }, sent: { labels: ['SENT'] },
  drafts: { labels: ['DRAFT'] }, spam: { labels: ['SPAM'], st: true }, trash: { labels: ['TRASH'], st: true }, all: { q: '-in:trash -in:spam' },
};
const CATS = { primary: 'CATEGORY_PERSONAL', promotions: 'CATEGORY_PROMOTIONS', social: 'CATEGORY_SOCIAL', updates: 'CATEGORY_UPDATES', forums: 'CATEGORY_FORUMS' };
const ID = /^[\w-]{1,80}$/;

async function gmail(env, path, init = {}, retry = true) {
  let tok;
  try { tok = await horizonToken(env); } catch (e) { throw new MailError(503, e.message); }
  const r = await fetch(path.startsWith('http') ? path : G + path, { ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) } });
  if (r.ok) return r.status === 204 ? {} : r.json().catch(() => ({}));
  const j = await r.json().catch(() => ({}));
  const msg = j.error?.message || `Error ${r.status}`;
  // token antiguo (sin el permiso de Gmail) o caducado: se pide uno nuevo una vez
  if (retry && (r.status === 401 || (r.status === 403 && /insufficient|scope/i.test(msg)))) { await dropHorizonToken(env); return gmail(env, path, init, false); }
  if (/has not been used|is disabled|not been enabled/i.test(msg)) throw new MailError(503, 'The Gmail API is not enabled in the Horizon script (Services → + → Gmail API).');
  if (r.status === 403 && /insufficient|scope/i.test(msg)) throw new MailError(503, 'The Horizon script has no Gmail permission yet. Run _gmailScope in the script and deploy a new version.');
  if (r.status === 404) throw new MailError(404, 'That email no longer exists.');
  throw new MailError(502, `Gmail: ${msg}`);
}
const post = (env, path, body) => gmail(env, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
// varias lecturas en UNA sola petición a Google (batch): el plan gratis solo deja 6 conexiones a la vez,
// así que pedir 20 correos uno a uno iba en tandas y tardaba. Devuelve un resultado (o null) por ruta, en orden.
async function gmailBatch(env, paths, retry = true) {
  if (!paths.length) return [];
  let tok;
  try { tok = await horizonToken(env); } catch (e) { throw new MailError(503, e.message); }
  const b = 'hzb' + crypto.randomUUID().replace(/-/g, '');
  const body = paths.map((p, i) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <q${i}>\r\n\r\nGET /gmail/v1/users/me${p}\r\n\r\n`).join('') + `--${b}--`;
  const r = await fetch('https://gmail.googleapis.com/batch/gmail/v1', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/mixed; boundary=${b}` }, body });
  if (r.status === 401 && retry) { await dropHorizonToken(env); return gmailBatch(env, paths, false); }
  if (!r.ok) return Promise.all(paths.map(p => gmail(env, p).catch(() => null)));   // (si el batch falla, uno a uno)
  const rb = (r.headers.get('Content-Type') || '').match(/boundary="?([^";]+)"?/)?.[1];
  const text = await r.text(), out = paths.map(() => null), gone = new Set();
  for (const part of rb ? text.split('--' + rb) : []) {
    const id = part.match(/Content-ID:\s*<response-q(\d+)>/i)?.[1];
    if (id == null) continue;
    const st = Number(part.match(/HTTP\/1\.1\s+(\d{3})/)?.[1] || 0), a = part.indexOf('{'), z = part.lastIndexOf('}');
    if (st === 200 && a >= 0) { try { out[+id] = JSON.parse(part.slice(a, z + 1)); continue; } catch { /* abajo */ } }
    if ((st === 401 || st === 403) && retry) { await dropHorizonToken(env); return gmailBatch(env, paths, false); }
    if (st === 404) gone.add(+id);
  }
  // lo que Google no contestó bien en el batch (p. ej. demasiadas a la vez), uno a uno
  const redo = out.map((x, i) => x == null && !gone.has(i) ? i : -1).filter(i => i >= 0);
  if (redo.length) await Promise.all(redo.map(async i => { out[i] = await gmail(env, paths[i]).catch(() => null); }));
  return out;
}
const hdr = (m, name) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === name)?.value || '';

// remitente (contact@ si Gmail ya lo tiene verificado como «Enviar como»; si no, el propio Gmail) y su firma de Gmail
let sendAsCache = null;
async function senders(env) {
  if (sendAsCache && sendAsCache.at > Date.now() - 10 * 60e3) return sendAsCache;
  const j = await gmail(env, '/settings/sendAs');
  const list = j.sendAs || [], primary = list.find(x => x.isPrimary) || {};
  const c = list.find(x => x.sendAsEmail?.toLowerCase() === MAIL_FROM_ADDR);
  const ready = c && (c.verificationStatus === 'accepted' || c.isPrimary);
  const from = ready ? c : primary;
  sendAsCache = { at: Date.now(), me: primary.sendAsEmail || '', contact: !!ready, from: from.sendAsEmail || '', name: 'HORIZON RCRDS', signature: from.signature || primary.signature || '' };
  return sendAsCache;
}
// carpetas y etiquetas con sus contadores
async function folders(env) {
  const list = (await gmail(env, '/labels')).labels || [];
  const user = list.filter(l => l.type === 'user' && l.labelListVisibility !== 'labelHide').sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
  const ids = ['INBOX', 'STARRED', 'IMPORTANT', 'DRAFT', 'SPAM', 'TRASH', ...user.map(l => l.id)];
  const got = await gmailBatch(env, ids.map(id => `/labels/${encodeURIComponent(id)}`));
  const n = Object.fromEntries(ids.map((id, i) => [id, got[i] || {}]));
  return {
    counts: { inbox: n.INBOX.threadsUnread || 0, drafts: n.DRAFT.messagesTotal || 0, spam: n.SPAM.threadsUnread || 0, important: n.IMPORTANT.threadsUnread || 0 },
    labels: user.map(l => ({ id: l.id, name: l.name, unread: n[l.id]?.threadsUnread || 0, color: l.color?.backgroundColor || '' })),
  };
}
const ACTS = {
  archive: { removeLabelIds: ['INBOX'] }, read: { removeLabelIds: ['UNREAD'] }, unread: { addLabelIds: ['UNREAD'] },
  star: { addLabelIds: ['STARRED'] }, unstar: { removeLabelIds: ['STARRED'] }, spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
  notspam: { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] }, important: { addLabelIds: ['IMPORTANT'] }, unimportant: { removeLabelIds: ['IMPORTANT'] },
};
const ACT_LOG = { archive: 'Archived', trash: 'Moved to the Gmail trash', untrash: 'Restored from the trash', spam: 'Reported as spam', notspam: 'Marked as not spam', move: 'Moved' };
async function templates(env) {
  const row = await env.DB.prepare("SELECT value FROM panel_settings WHERE key = 'mail_templates'").first().catch(() => null);
  try { const v = JSON.parse(row?.value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function mailApi(req, env, s, url, audit) {
  if (s.sync || !(s.owner || s.mail)) throw new MailError(403, 'You have no access to Mail. Ask an owner.');
  const p = url.pathname, m = req.method, peek = url.searchParams.get('peek') === '1';   // peek: «Test» (no marca como leído)
  if (p === '/api/mail/info' && m === 'GET') {
    const [who, f] = await Promise.all([senders(env), folders(env)]);
    return { me: who.me, from: who.from, contact: who.contact, name: who.name, signature: who.signature, unread: f.counts.inbox, counts: f.counts, labels: f.labels };
  }
  if (p === '/api/mail/threads' && m === 'GET') {
    const boxId = String(url.searchParams.get('box') || 'inbox');
    const box = BOXES[boxId] || (/^L:[\w-]+$/.test(boxId) ? { labels: [boxId.slice(2)] } : BOXES.inbox);
    const cat = boxId === 'inbox' && CATS[url.searchParams.get('cat')] ? CATS[url.searchParams.get('cat')] : '';
    const q = [box.q || '', String(url.searchParams.get('q') || '').slice(0, 200)].filter(Boolean).join(' ');
    const page = String(url.searchParams.get('page') || '').replace(/[^\w-]/g, '').slice(0, 80);
    const n = Math.max(5, Math.min(25, Number(url.searchParams.get('n')) || 12));
    const qs = [`maxResults=${n}`, ...(box.labels || []).concat(cat ? [cat] : []).map(l => 'labelIds=' + encodeURIComponent(l)), q ? 'q=' + encodeURIComponent(q) : '', page ? 'pageToken=' + page : '', box.st ? 'includeSpamTrash=true' : ''].filter(Boolean).join('&');
    const j = await gmail(env, `/threads?${qs}`);
    const ids = (j.threads || []).map(t => t.id);
    const all = await gmailBatch(env, [...ids.map(id => `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`), '/labels/INBOX']);
    const lab = all.pop(), meta = all;
    const sentBox = boxId === 'sent' || boxId === 'drafts';
    const threads = meta.filter(Boolean).map(t => {
      const msgs = t.messages || [], first = msgs[0] || {}, last = msgs[msgs.length - 1] || {};
      const other = [...msgs].reverse().find(x => !(x.labelIds || []).some(l => l === 'SENT' || l === 'DRAFT')) || last;
      const labs = [...new Set(msgs.flatMap(x => x.labelIds || []))];
      return { id: t.id, subject: hdr(first, 'subject'), from: hdr(sentBox ? last : other, sentBox ? 'to' : 'from'), at: Number(last.internalDate) || 0, snippet: last.snippet || '', count: msgs.length,
        unread: labs.includes('UNREAD'), starred: labs.includes('STARRED'), important: labs.includes('IMPORTANT'), draft: labs.includes('DRAFT'), labels: labs.filter(l => /^Label_/.test(l)),
        files: msgs.some(x => /mixed/i.test(x.payload?.mimeType || '')) };
    });
    return { threads, next: j.nextPageToken || '', total: j.resultSizeEstimate || 0, unread: lab ? lab.threadsUnread || 0 : null };
  }
  let mt = p.match(/^\/api\/mail\/thread\/([\w-]{6,40})$/);
  if (mt && m === 'GET') {
    const t = await gmail(env, `/threads/${mt[1]}?format=full`);
    if (!peek && (t.messages || []).some(x => (x.labelIds || []).includes('UNREAD'))) await post(env, `/threads/${mt[1]}/modify`, { removeLabelIds: ['UNREAD'] }).catch(() => {});
    return { id: t.id, messages: (t.messages || []).map(x => ({ id: x.id, labels: x.labelIds || [], at: Number(x.internalDate) || 0, payload: x.payload })) };
  }
  // una acción sobre uno o varios correos: archivar, papelera, restaurar, spam, leído, estrella, mover a una etiqueta…
  mt = p.match(/^\/api\/mail\/thread\/([\w-]{6,40})\/(\w+)$/);
  if ((mt && m === 'POST') || (p === '/api/mail/bulk' && m === 'POST')) {
    const b = mt ? { ids: [mt[1]], act: mt[2] } : await req.json().catch(() => ({}));
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => ID.test(x)).slice(0, 50), act = String(b.act || '');
    if (!ids.length) throw new MailError(400, 'Choose at least one email.');
    let one;
    if (act === 'trash' || act === 'untrash') one = id => post(env, `/threads/${id}/${act}`);
    else if (act === 'move' || act === 'label' || act === 'unlabel') {
      const label = String(b.label || '');
      if (!ID.test(label)) throw new MailError(400, 'Choose a label.');
      const body = act === 'unlabel' ? { removeLabelIds: [label] } : act === 'label' ? { addLabelIds: [label] } : label === 'INBOX' ? { addLabelIds: ['INBOX'] } : { addLabelIds: [label], removeLabelIds: ['INBOX'] };
      one = id => post(env, `/threads/${id}/modify`, body);
    } else if (ACTS[act]) one = id => post(env, `/threads/${id}/modify`, ACTS[act]);
    else throw new MailError(400, 'Unknown action.');
    const res = await Promise.all(ids.map(id => one(id).then(() => true, () => false)));
    const ok = res.filter(Boolean).length;
    if (ACT_LOG[act]) await audit(`${ACT_LOG[act]} ${ok} email${ok === 1 ? '' : 's'} in Mail`);
    if (!ok) throw new MailError(502, 'Gmail did not accept the change. Try again.');
    return { ok: true, done: ok };
  }
  mt = p.match(/^\/api\/mail\/attachment\/([\w-]{6,40})\/([\w-]{6,40})\/([\w-]{6,1200})$/);
  if (mt && m === 'GET') {
    const a = await gmail(env, `/messages/${mt[2]}/attachments/${mt[3]}`);
    return new Response(JSON.stringify({ data: a.data || '' }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  // plantillas (las de Gmail no se pueden leer desde fuera: se guardan aquí; se pueden importar desde los borradores de Gmail)
  if (p === '/api/mail/templates' && m === 'GET') return { templates: await templates(env) };
  if (p === '/api/mail/templates' && (m === 'POST' || m === 'DELETE')) {
    let list = await templates(env);
    if (m === 'DELETE') list = list.filter(t => t.id !== url.searchParams.get('id'));
    else {
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80), html = String(b.html || '').slice(0, 60000);
      if (!name) throw new MailError(400, 'Give the template a name.');
      const old = list.find(t => t.id === b.id || t.name.toLowerCase() === name.toLowerCase());
      const t = { id: old?.id || crypto.randomUUID().slice(0, 12), name, subject: String(b.subject || '').slice(0, 200), html };
      list = old ? list.map(x => x === old ? t : x) : [...list, t];
      if (JSON.stringify(list).length > 400000) throw new MailError(413, 'Too many templates (or too long). Delete some first.');
    }
    await env.DB.prepare("INSERT INTO panel_settings (key, value) VALUES ('mail_templates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(list)).run();
    await audit(m === 'DELETE' ? 'Deleted a Mail template' : 'Saved a Mail template');
    return { templates: list };
  }
  // borradores de Gmail (para importar plantillas)
  if (p === '/api/mail/drafts' && m === 'GET') {
    const j = await gmail(env, '/drafts?maxResults=25');
    const got = await gmailBatch(env, (j.drafts || []).map(d => `/drafts/${d.id}?format=full`));
    return { drafts: got.filter(Boolean).map(d => ({ id: d.id, subject: hdr(d.message || {}, 'subject'), to: hdr(d.message || {}, 'to'), snippet: d.message?.snippet || '', payload: d.message?.payload })) };
  }
  if (p === '/api/mail/send' && m === 'POST') {
    // el navegador manda el correo ya montado (RFC 822); aquí solo se miran las cabeceras
    const raw = await req.text();
    if (raw.length > 18e6) throw new MailError(413, 'Too big: attachments can be up to 12 MB in total.');
    const end = raw.search(/\r?\n\r?\n/), head = raw.slice(0, end < 0 ? 20000 : Math.min(end, 20000));
    const get = n => (head.match(new RegExp(`^${n}:\\s*((?:.*)(?:\\r?\\n[ \\t].*)*)`, 'im')) || [])[1]?.replace(/\r?\n[ \t]/g, ' ').trim() || '';
    const who = await senders(env);
    const from = (get('From').match(/<([^>]+)>/) || [, get('From')])[1].trim().toLowerCase();
    if (!who.from || from !== who.from.toLowerCase()) throw new MailError(400, 'The sender is not valid.');
    if (!get('To') && !get('Cc') && !get('Bcc')) throw new MailError(400, 'Add who it goes to.');
    const thread = String(url.searchParams.get('thread') || '').replace(/[^\w-]/g, '').slice(0, 40);
    const b = 'hz' + crypto.randomUUID().replace(/-/g, '');
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(thread ? { threadId: thread } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n${raw}\r\n--${b}--`;
    const r = await gmail(env, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    await audit(`Sent an email${thread ? ' (reply)' : ''} to ${decodeWord(get('To')).slice(0, 120)}: ${decodeWord(get('Subject')).slice(0, 120)}`);
    return { ok: true, id: r.id, threadId: r.threadId };
  }
  throw new MailError(404, 'Not found.');
}
// =?UTF-8?B?…?= → texto (solo para el historial)
function decodeWord(s) {
  return String(s).replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, x) => { try { return new TextDecoder().decode(Uint8Array.from(atob(x), c => c.charCodeAt(0))); } catch { return x; } });
}
