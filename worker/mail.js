/* Mail: el Gmail de Horizon dentro del panel (Gmail API, gratis).
   - El permiso de Google sale del script de Apps Script de Horizon (el mismo token que Contracts, con el permiso de Gmail).
   - Lo ven los owners y la persona a la que un owner le dé acceso (panel_members.mail = 1), las dos con la bandeja completa.
   - Los correos salen como contact@horizonrcrds.com cuando ese «Enviar como» está listo en Gmail; si no, como el Gmail.
   - El servidor casi no procesa nada (plan gratis = poca CPU): el navegador descodifica los correos y monta el mensaje. */
import { horizonToken, dropHorizonToken } from './gdocs.js';

export class MailError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const MAIL_FROM_ADDR = 'contact@horizonrcrds.com';
const SHARED = ['contact@horizonrcrds.com', 'demos@horizonrcrds.com', 'contracts@horizonrcrds.com'];
const SHARED_Q = '{' + SHARED.map(a => `to:${a} from:${a} cc:${a} deliveredto:${a}`).join(' ') + '}';
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BOXES = { inbox: 'in:inbox', sent: 'in:sent', starred: 'is:starred', all: '-in:trash -in:spam' };

async function gmail(env, path, init = {}, retry = true) {
  let tok;
  try { tok = await horizonToken(env); } catch (e) { throw new MailError(503, e.message); }
  const r = await fetch(path.startsWith('http') ? path : G + path, { ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) } });
  if (r.ok) return r.status === 204 ? {} : r.json();
  const j = await r.json().catch(() => ({}));
  const msg = j.error?.message || `Error ${r.status}`;
  // token antiguo (sin el permiso de Gmail) o caducado: se pide uno nuevo una vez
  if (retry && (r.status === 401 || (r.status === 403 && /insufficient|scope/i.test(msg)))) { await dropHorizonToken(env); return gmail(env, path, init, false); }
  if (/has not been used|is disabled|not been enabled/i.test(msg)) throw new MailError(503, 'The Gmail API is not enabled in the Horizon script (Services → + → Gmail API).');
  if (r.status === 403 && /insufficient|scope/i.test(msg)) throw new MailError(503, 'The Horizon script has no Gmail permission yet. Run _gmailScope in the script and deploy a new version.');
  if (r.status === 404) throw new MailError(404, 'That email no longer exists.');
  throw new MailError(502, `Gmail: ${msg}`);
}
const hdr = (m, name) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === name)?.value || '';
const shared = txt => SHARED.some(a => String(txt).toLowerCase().includes(a));
const touchesShared = msgs => msgs.some(m => ['from', 'to', 'cc', 'delivered-to', 'x-forwarded-to', 'x-original-to'].some(h => shared(hdr(m, h))));

// remitente: contact@ si Gmail ya lo tiene verificado como «Enviar como»; si no, el propio Gmail
let sendAsCache = null;
async function senders(env) {
  if (sendAsCache && sendAsCache.at > Date.now() - 10 * 60e3) return sendAsCache;
  const j = await gmail(env, '/settings/sendAs');
  const list = j.sendAs || [], primary = list.find(x => x.isPrimary) || {};
  const c = list.find(x => x.sendAsEmail?.toLowerCase() === MAIL_FROM_ADDR);
  const ready = c && (c.verificationStatus === 'accepted' || c.isPrimary);
  sendAsCache = { at: Date.now(), me: primary.sendAsEmail || '', contact: !!ready, from: ready ? MAIL_FROM_ADDR : primary.sendAsEmail || '', name: 'HORIZON RCRDS' };
  return sendAsCache;
}

export async function mailApi(req, env, s, url, audit) {
  if (s.sync || !(s.owner || s.mail)) throw new MailError(403, 'You have no access to Mail. Ask an owner.');
  // as=shared: un owner ve Mail como la persona con acceso (Test en el panel)
  // la persona con acceso ve todo el Gmail de Horizon, igual que los owners (lo pidió el owner, 2026-11-18). peek = «Test» (no marca como leído)
  const p = url.pathname, m = req.method, full = true, peek = url.searchParams.get('peek') === '1';
  if (p === '/api/mail/info' && m === 'GET') {
    const [who, lab] = await Promise.all([senders(env), gmail(env, '/labels/INBOX')]);
    return { me: full ? who.me : '', from: who.from, contact: who.contact, name: who.name, unread: full ? lab.threadsUnread || 0 : null, shared: !full };
  }
  if (p === '/api/mail/threads' && m === 'GET') {
    const box = BOXES[url.searchParams.get('box')] ? url.searchParams.get('box') : 'inbox';
    const q = [BOXES[box], String(url.searchParams.get('q') || '').slice(0, 200), full ? '' : SHARED_Q].filter(Boolean).join(' ');
    const page = String(url.searchParams.get('page') || '').replace(/[^\w-]/g, '').slice(0, 80);
    const n = Math.max(5, Math.min(25, Number(url.searchParams.get('n')) || 12));
    const j = await gmail(env, `/threads?maxResults=${n}&q=${encodeURIComponent(q)}${page ? '&pageToken=' + page : ''}`);
    const ids = (j.threads || []).map(t => t.id);
    const meta = await Promise.all(ids.map(id => gmail(env, `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null)));
    const threads = meta.filter(Boolean).map(t => {
      const msgs = t.messages || [], first = msgs[0] || {}, last = msgs[msgs.length - 1] || {};
      const other = [...msgs].reverse().find(x => !(x.labelIds || []).includes('SENT')) || last;
      return { id: t.id, subject: hdr(first, 'subject'), from: hdr(box === 'sent' ? last : other, box === 'sent' ? 'to' : 'from'), at: Number(last.internalDate) || 0, snippet: last.snippet || '', count: msgs.length,
        unread: msgs.some(x => (x.labelIds || []).includes('UNREAD')), starred: msgs.some(x => (x.labelIds || []).includes('STARRED')), files: msgs.some(x => /mixed/i.test(x.payload?.mimeType || '')) };
    });
    return { threads, next: j.nextPageToken || '', total: j.resultSizeEstimate || 0 };
  }
  let mt = p.match(/^\/api\/mail\/thread\/([\w-]{6,40})$/);
  if (mt && m === 'GET') {
    const t = await gmail(env, `/threads/${mt[1]}?format=full`);
    if (!full && !touchesShared(t.messages || [])) throw new MailError(403, 'That email is not one of Horizon’s shared addresses.');
    // al abrirlo queda leído
    if (!peek && (t.messages || []).some(x => (x.labelIds || []).includes('UNREAD'))) await gmail(env, `/threads/${mt[1]}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) }).catch(() => {});
    return { id: t.id, messages: (t.messages || []).map(x => ({ id: x.id, labels: x.labelIds || [], at: Number(x.internalDate) || 0, payload: x.payload })) };
  }
  mt = p.match(/^\/api\/mail\/thread\/([\w-]{6,40})\/(read|unread|star|unstar|trash)$/);
  if (mt && m === 'POST') {
    const [, id, act] = mt;
    if (!full) { const t = await gmail(env, `/threads/${id}?format=metadata`); if (!touchesShared(t.messages || [])) throw new MailError(403, 'That email is not one of Horizon’s shared addresses.'); }
    if (act === 'trash') { await gmail(env, `/threads/${id}/trash`, { method: 'POST' }); await audit('Moved an email to the Gmail trash'); return { ok: true }; }
    const lab = { read: ['removeLabelIds', 'UNREAD'], unread: ['addLabelIds', 'UNREAD'], star: ['addLabelIds', 'STARRED'], unstar: ['removeLabelIds', 'STARRED'] }[act];
    await gmail(env, `/threads/${id}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [lab[0]]: [lab[1]] }) });
    return { ok: true };
  }
  mt = p.match(/^\/api\/mail\/attachment\/([\w-]{6,40})\/([\w-]{6,40})\/([\w-]{6,1200})$/);
  if (mt && m === 'GET') {
    if (!full) { const t = await gmail(env, `/threads/${mt[1]}?format=metadata`); if (!touchesShared(t.messages || [])) throw new MailError(403, 'That email is not one of Horizon’s shared addresses.'); }
    const a = await gmail(env, `/messages/${mt[2]}/attachments/${mt[3]}`);
    return new Response(JSON.stringify({ data: a.data || '' }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
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
    if (!full && /^bcc:/im.test(head)) throw new MailError(400, 'Bcc is not available.');
    const thread = String(url.searchParams.get('thread') || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (thread && !full) { const t = await gmail(env, `/threads/${thread}?format=metadata`); if (!touchesShared(t.messages || [])) throw new MailError(403, 'That email is not one of Horizon’s shared addresses.'); }
    const b = 'hz' + crypto.randomUUID().replace(/-/g, '');
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(thread ? { threadId: thread } : {})}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n${raw}\r\n--${b}--`;
    const r = await gmail(env, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    const subj = decodeWord(get('Subject'));
    await audit(`Sent an email${thread ? ' (reply)' : ''} to ${decodeWord(get('To')).slice(0, 120)}: ${subj.slice(0, 120)}`);
    return { ok: true, id: r.id, threadId: r.threadId };
  }
  throw new MailError(404, 'Not found.');
}
// =?UTF-8?B?…?= → texto (solo para el historial)
function decodeWord(s) {
  return String(s).replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, x) => { try { return new TextDecoder().decode(Uint8Array.from(atob(x), c => c.charCodeAt(0))); } catch { return x; } });
}
