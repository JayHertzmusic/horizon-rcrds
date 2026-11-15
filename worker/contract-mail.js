/* Correos de contratos a los artistas (Cloudflare Email Service, binding SEND).
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

async function send(env, msg) {
  if (!env.SEND) throw new Error('Email sending is not set up on the server.');
  const from = env.MAIL_FROM || 'contratos@horizonrcrds.com';
  try {
    await env.SEND.send({
      from: { email: from, name: 'HORIZON RCRDS' },
      to: msg.to, replyTo: env.MAIL_TO || from, ...(env.MAIL_TO && env.MAIL_TO !== msg.to ? { bcc: env.MAIL_TO } : {}),
      subject: msg.subject, html: msg.html, text: textOf(msg.html), ...(msg.attachments ? { attachments: msg.attachments } : {}),
    });
  } catch (e) {
    const code = e?.code || '';
    if (/RECIPIENT_NOT_ALLOWED|SENDER_NOT_VERIFIED|SENDER_DOMAIN/i.test(code + e?.message)) throw new Error('Cloudflare did not send it: the horizonrcrds.com sending domain is not active yet (Email Service).');
    if (/LIMIT/i.test(code)) throw new Error('Cloudflare daily email limit reached. Try again later.');
    throw new Error(`The email could not be sent (${code || e?.message || 'error'}).`);
  }
}

// invitación a firmar
export function inviteMail(env, c, sg, link) {
  const body = `${hello(sg)}<br><br>HORIZON RCRDS has sent you a contract to review and sign: <b>${esc(c.title)}</b>.<br><br>
    Open it with the button below. To access it, enter this email address (<b>${esc(sg.email)}</b>). You can read the whole contract and sign it online.`;
  return send(env, { to: sg.email, subject: `Contract to sign — ${c.title}`, html: layout('Your contract is ready to sign', body, { href: link, label: 'Review and sign' }) });
}

// contrato terminado (han firmado todos): PDF firmado adjunto + enlace para descargarlo
export function doneMail(env, c, sg, link, pdf, fileName) {
  const body = `${hello(sg)}<br><br>Everyone has signed <b>${esc(c.title)}</b>. The contract is now complete.<br><br>
    The signed contract is attached to this email as a PDF. You can also download it at any time from your private link.`;
  return send(env, {
    to: sg.email, subject: `Signed contract — ${c.title}`, html: layout('Your contract is signed', body, { href: link, label: 'Download signed contract' }),
    attachments: [{ content: pdf, filename: fileName, type: 'application/pdf', disposition: 'attachment' }],
  });
}
