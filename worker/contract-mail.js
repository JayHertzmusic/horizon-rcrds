/* Correos de contratos a los artistas (Resend).
   Salen de contratos@horizonrcrds.com; las respuestas van al correo de Horizon y Horizon recibe copia oculta de cada uno. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body, button) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f2f2f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111">
<tr><td style="background:#050505;padding:22px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:4px">HORIZON RCRDS</td></tr>
<tr><td style="padding:30px 28px 8px;font-size:22px;font-weight:700;line-height:1.3">${title}</td></tr>
<tr><td style="padding:8px 28px 4px;font-size:15px;line-height:1.6;color:#333">${body}</td></tr>
${button ? `<tr><td style="padding:22px 28px 8px"><a href="${esc(button.href)}" style="display:inline-block;background:#111;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:2px;text-transform:uppercase;padding:15px 30px;border-radius:4px">${esc(button.label)}</a></td></tr>
<tr><td style="padding:10px 28px 0;font-size:12px;line-height:1.5;color:#777">If the button does not work, copy this link into your browser:<br><a href="${esc(button.href)}" style="color:#555;word-break:break-all">${esc(button.href)}</a></td></tr>` : ''}
<tr><td style="padding:26px 28px 28px;font-size:12px;line-height:1.5;color:#999">This link is private and only for you. Any questions? Just reply to this email.<br>HORIZON RCRDS</td></tr>
</table></td></tr></table></body></html>`;
}
const textOf = html => html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
const hello = sg => sg.label && !/^Artista?\s*\d*$/i.test(sg.label) ? `Hi ${esc(sg.label)},` : 'Hi,';

// Resend (plan gratis: 3.000 correos/mes, 100/día). La clave va como secreto RESEND_API_KEY.
async function send(env, msg) {
  const from = env.MAIL_FROM || 'contratos@horizonrcrds.com';
  const body = {
    from: `HORIZON RCRDS <${from}>`, to: [msg.to], reply_to: env.MAIL_TO || from, ...(env.MAIL_TO && env.MAIL_TO !== msg.to ? { bcc: [env.MAIL_TO] } : {}),
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

// invitación a firmar
export function inviteMail(env, c, sg, link) {
  const body = `${hello(sg)}<br><br>HORIZON RCRDS has sent you a contract to review and sign: <b>${esc(c.title)}</b>.<br><br>
    Open it with the button below. To access it, enter this email address (<b>${esc(sg.email)}</b>). You can read the whole contract and sign it online.`;
  return send(env, { to: sg.email, subject: `Contract to sign — ${c.title}`, html: layout('Your contract is ready to sign', body, { href: link, label: 'Review and sign' }) });
}

// contrato terminado (han firmado todos): enlace privado para descargar el PDF firmado
export function doneMail(env, c, sg, link) {
  const body = `${hello(sg)}<br><br>Everyone has signed <b>${esc(c.title)}</b>. The contract is now complete.<br><br>
    Download your signed copy (PDF) from your private link below. Enter this email address (<b>${esc(sg.email)}</b>) to open it. The link stays available, so you can download it again at any time.`;
  return send(env, { to: sg.email, subject: `Signed contract — ${c.title}`, html: layout('Your contract is signed', body, { href: link, label: 'Download signed contract' }) });
}
