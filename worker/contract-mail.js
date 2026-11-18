/* Correos de contratos a los artistas (Resend).
   Salen de contratos@horizonrcrds.com y solo le llegan al artista; si responde, la respuesta llega al correo de Horizon. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fondo blanco, icono de Horizon (cuadrado negro con la H), nombre en letra fina espaciada, botón negro
const SITE = 'https://horizonrcrds.com';
const FONT = "Helvetica,Arial,sans-serif";
function layout(title, body, button) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff">
<center style="width:100%;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff"><tr><td align="center" style="padding:36px 12px 28px">
<table role="presentation" align="center" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;font-family:${FONT};color:#111111">
<tr><td align="center" style="padding:0 0 24px"><a href="${SITE}" style="text-decoration:none"><img src="${SITE}/assets/favicon_icon.png" width="52" height="52" alt="HORIZON RCRDS" style="display:block;margin:0 auto;border:0;width:52px;height:52px;border-radius:12px"></a>
  <div style="margin-top:14px;font-family:${FONT};font-size:13px;font-weight:400;letter-spacing:6px;padding-left:6px;color:#111111">HORIZON RCRDS</div></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:32px 30px 28px">
  <div style="font-size:22px;line-height:1.3;font-weight:700;color:#111111">${title}</div>
  <div style="margin-top:16px;font-size:15px;line-height:1.65;color:#374151">${body}</div>
  ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr><td style="background:#050505;border-radius:4px"><a href="${esc(button.href)}" style="display:inline-block;padding:15px 32px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none">${esc(button.label)}</a></td></tr></table>
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid #eeeeee;font-size:12px;line-height:1.55;color:#6b7280">If the button does not work, copy this link into your browser:<br><a href="${esc(button.href)}" style="color:#4b5563;word-break:break-all">${esc(button.href)}</a></div>` : ''}
</td></tr>
<tr><td align="center" style="padding:22px 10px 0;font-size:12px;line-height:1.6;color:#9ca3af">${button ? 'This link is private and only for you. Any questions? Just reply to this email.' : 'Sent by HORIZON RCRDS.'}<br>
  <a href="${SITE}" style="color:#6b7280;text-decoration:none;letter-spacing:2px;padding-left:2px">horizonrcrds.com</a></td></tr>
</table></td></tr></table></center>
</body></html>`;
}
const textOf = html => html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
// nombre del contrato en su propia línea, debajo de la frase
const docTitle = t => `<div style="margin:10px 0 2px;font-size:17px;line-height:1.4;font-weight:700;color:#111111">${esc(t)}</div>`;
// nombre del contrato en los correos: «HORIZON RCRDS RELEASE CONTRACT | Artista 1 & Artista 2 - Track»
// «Artista 1 & Artista 2 - Track»
export function mailWho(c) {
  const vars = (() => { try { return JSON.parse(c.vars || '{}'); } catch { return {}; } })();
  const artists = String(c.artist || '').split(/\s*(?:,|&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean).join(' & ');
  const track = String(c.release_name || vars.Track || vars.track || '').trim();
  return [artists, track].filter(Boolean).join(' - ');
}
export function mailName(c) {
  const kind = c.kind === 'draft' || /draft/i.test(c.title || '') ? 'DRAFT CONTRACT' : /remix/i.test(c.title || '') ? 'REMIX AUTHORIZATION' : 'RELEASE CONTRACT';
  const who = mailWho(c);
  return `HORIZON RCRDS ${kind}${who ? ' | ' + who : ''}`;
}
// en el texto del correo solo «Artista - Track» (el asunto ya dice qué es)
const bodyName = c => docTitle(mailWho(c) || mailName(c));
const hello = sg => sg.label && !/^Artista?\s*\d*$/i.test(sg.label) ? `Hi ${esc(sg.label)},` : 'Hi,';

// Resend (plan gratis: 3.000 correos/mes, 100/día). La clave va como secreto RESEND_API_KEY.
async function send(env, msg) {
  const from = msg.from || env.MAIL_FROM || 'contracts@horizonrcrds.com';
  const body = {
    from: `HORIZON RCRDS <${from}>`, to: Array.isArray(msg.to) ? msg.to : [msg.to], reply_to: env.MAIL_TO || from,   // solo al artista (sin copia a Horizon); si responde, llega a Horizon
    subject: msg.subject, html: msg.html, text: textOf(msg.html),
    ...(msg.attachments ? { attachments: msg.attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
  };
  if (!env.RESEND_API_KEY) {
    // en el ordenador (wrangler dev) sin clave: no se envía, solo se apunta
    if (env.DEV_LOGIN === '1') { console.log('[mail de prueba]', msg.to, '—', msg.subject, msg.attachments ? `(+ ${msg.attachments[0].filename})` : ''); return; }
    throw new Error('Email sending is not set up yet (Resend key missing).');
  }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return;
  const j = await r.json().catch(() => ({}));
  const m = String(j.message || '');
  if (/domain.*not verified|verify a domain|testing emails/i.test(m)) throw new Error('Resend did not send it: the horizonrcrds.com domain is not verified in Resend yet.');
  if (r.status === 429) throw new Error('Resend sending limit reached (100 a day on the free plan). Try again later.');
  throw new Error(`The email could not be sent (Resend: ${m || r.status}).`);
}

// respuesta a una demo (aceptada / rechazada): sale de demos@, y si el artista contesta llega al correo de Horizon
export function demoReplyMail(env, to, subject, text) {
  const body = esc(text).replace(/https?:\/\/[^\s<>&"]+/g, u => `<a href="${u}" style="color:#111111;word-break:break-all">${u}</a>`).replace(/\r?\n/g, '<br>');
  return send(env, { to, from: env.DEMO_FROM || 'demos@horizonrcrds.com', subject, html: layout(esc(subject), body, null) });
}

// código para entrar al panel con el email (para quien no usa Google)
export function loginCodeMail(env, email, code, area) {
  const body = `Use this code to sign in to the HORIZON RCRDS ${area === 'admin' ? 'panel' : 'team panel'}:
    <div style="margin:18px 0 6px;font-size:32px;line-height:1;font-weight:700;letter-spacing:10px;padding-left:10px;color:#111111">${esc(code)}</div>
    <div style="font-size:13px;color:#6b7280">It expires in 10 minutes. If you did not try to sign in, you can ignore this email.</div>`;
  return send(env, { to: email, subject: `Your sign-in code: ${code}`, html: layout('Sign in to HORIZON RCRDS', body, null), noBcc: true });
}

// invitación a firmar (o, si es un draft, solo a mirarlo)
export function inviteMail(env, c, sg, link) {
  if (c.kind === 'draft') {
    const body = `${hello(sg)}<br><br>HORIZON RCRDS has sent you a draft of your contract to review:${bodyName(c)}<br>
      Open it with the button below and enter this email address (<b>${esc(sg.email)}</b>) to read it online. It is only a draft: there is nothing to sign yet.`;
    return send(env, { to: sg.email, subject: mailName(c), html: layout('Your draft contract is ready to review', body, { href: link, label: 'Review' }) });
  }
  const body = `${hello(sg)}<br><br>HORIZON RCRDS has sent you a contract to review and sign:${bodyName(c)}<br>
    Open it with the button below and enter this email address (<b>${esc(sg.email)}</b>). You can read the whole contract and sign it online.`;
  return send(env, { to: sg.email, subject: mailName(c), html: layout('Your contract is ready to sign', body, { href: link, label: 'Review and sign' }) });
}

// contrato terminado (han firmado todos): enlace privado para descargar el PDF firmado
export function doneMail(env, c, sg, link) {
  const body = `${hello(sg)}<br><br>Everyone has signed this contract, so it is now complete:${bodyName(c)}<br>
    Download your signed copy (PDF) from your private link below. Enter this email address (<b>${esc(sg.email)}</b>) to open it. The link stays available, so you can download it again at any time.`;
  return send(env, { to: sg.email, subject: `${mailName(c)} (signed)`, html: layout('Your contract is signed', body, { href: link, label: 'Download signed contract' }) });
}
