/* Correos de contratos a los artistas (Resend).
   Salen de contratos@horizonrcrds.com; las respuestas van al correo de Horizon y Horizon recibe copia oculta de cada uno. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fondo blanco, icono de Horizon (cuadrado negro con la H), nombre en letra fina espaciada, botón negro
const SITE = 'https://horizonrcrds.com';
const FONT = "Helvetica,Arial,sans-serif";
function layout(title, body, button) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:36px 12px 28px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};color:#111111">
<tr><td align="center" style="padding:0 0 24px"><a href="${SITE}" style="text-decoration:none"><img src="${SITE}/assets/favicon_icon.png" width="52" height="52" alt="HORIZON RCRDS" style="display:block;margin:0 auto;border:0;width:52px;height:52px;border-radius:12px"></a>
  <div style="margin-top:14px;font-family:${FONT};font-size:13px;font-weight:400;letter-spacing:6px;padding-left:6px;color:#111111">HORIZON RCRDS</div></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:32px 30px 28px">
  <div style="font-size:22px;line-height:1.3;font-weight:700;color:#111111">${title}</div>
  <div style="margin-top:16px;font-size:15px;line-height:1.65;color:#374151">${body}</div>
  ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr><td style="background:#050505;border-radius:4px"><a href="${esc(button.href)}" style="display:inline-block;padding:15px 32px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none">${esc(button.label)}</a></td></tr></table>
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid #eeeeee;font-size:12px;line-height:1.55;color:#6b7280">If the button does not work, copy this link into your browser:<br><a href="${esc(button.href)}" style="color:#4b5563;word-break:break-all">${esc(button.href)}</a></div>` : ''}
</td></tr>
<tr><td align="center" style="padding:22px 10px 0;font-size:12px;line-height:1.6;color:#9ca3af">This link is private and only for you. Any questions? Just reply to this email.<br>
  <a href="${SITE}" style="color:#6b7280;text-decoration:none;letter-spacing:2px;padding-left:2px">horizonrcrds.com</a></td></tr>
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
