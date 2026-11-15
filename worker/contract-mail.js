/* Correos de contratos a los artistas (Resend).
   Salen de contratos@horizonrcrds.com; las respuestas van al correo de Horizon y Horizon recibe copia oculta de cada uno. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Estilo de la web: negro, logo de Horizon, títulos en mayúsculas espaciadas, botón blanco
const SITE = 'https://horizonrcrds.com';
const FONT = "'Barlow',Helvetica,Arial,sans-serif";
function layout(title, body, button) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@400;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#050505">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:36px 12px 28px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};color:#e5e7eb">
<tr><td align="center" style="padding:0 0 26px"><a href="${SITE}" style="text-decoration:none"><img src="${SITE}/assets/logo.png" width="56" height="56" alt="HORIZON RCRDS" style="display:block;margin:0 auto;border:0;width:56px;height:56px"></a>
  <div style="margin-top:14px;font-family:'Bebas Neue',${FONT};font-size:22px;font-weight:700;letter-spacing:6px;color:#ffffff">HORIZON RCRDS</div></td></tr>
<tr><td style="background:#0d0d0d;border:1px solid #1f1f1f;border-radius:10px;padding:34px 30px 30px">
  <div style="font-family:'Bebas Neue',${FONT};font-size:30px;line-height:1.05;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#ffffff">${title}</div>
  <div style="margin-top:18px;font-size:15px;line-height:1.65;color:#c7c9ce">${body}</div>
  ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px"><tr><td style="background:#ffffff;border-radius:3px"><a href="${esc(button.href)}" style="display:inline-block;padding:16px 34px;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#000000;text-decoration:none">${esc(button.label)}</a></td></tr></table>
  <div style="margin-top:22px;padding-top:18px;border-top:1px solid #1f1f1f;font-size:12px;line-height:1.55;color:#6b7280">If the button does not work, copy this link into your browser:<br><a href="${esc(button.href)}" style="color:#8b8f98;word-break:break-all">${esc(button.href)}</a></div>` : ''}
</td></tr>
<tr><td align="center" style="padding:24px 10px 0;font-size:12px;line-height:1.6;color:#6b7280">This link is private and only for you. Any questions? Just reply to this email.<br>
  <a href="${SITE}" style="color:#8b8f98;text-decoration:none;letter-spacing:2px;text-transform:uppercase;font-weight:700">horizonrcrds.com</a></td></tr>
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
