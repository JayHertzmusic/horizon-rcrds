/* PDF firmado, generado en el servidor cuando firman todos: el PDF original del Google Doc (sin tocar) + cada firma
   en su recuadro + página de certificado. Es lo mismo que hace contract-pdf.js en el navegador. */
import * as PDFLib from '../assets/vendor/pdf/pdf-lib.min.js';

const latin1 = s => String(s ?? '').normalize('NFC').replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…€™]/g, '?');
const fmt = t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const pngBytes = d => Uint8Array.from(atob(d.slice(d.indexOf(',') + 1)), c => c.charCodeAt(0));

/* data: { title, hash, link, signers: [{ label, box, signed: { name, email, at, ip, ua, signature } }] } → Uint8Array */
export async function buildSignedPdf(bytes, data) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(bytes);
  const helv = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), ital = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const list = data.signers;
  for (const one of list) {
    const s = one.signed, b = one.box;
    if (!s || !b) continue;
    const page = doc.getPage(Math.min(b.page, doc.getPageCount() - 1));
    const { width: W, height: H } = page.getSize();
    const bx = b.x * W, bw = b.w * W, bh = b.h * H, by = H - b.y * H - bh;
    const labelH = Math.min(9, bh * 0.22);
    if (s.signature.startsWith('typed:')) {
      const txt = latin1(s.signature.slice(6));
      let size = Math.min(bh * 0.6, 28);
      while (size > 6 && ital.widthOfTextAtSize(txt, size) > bw) size -= 1;
      page.drawText(txt, { x: bx, y: by + labelH + 2, size, font: ital, color: rgb(0.05, 0.05, 0.2) });
    } else {
      const png = await doc.embedPng(pngBytes(s.signature));
      const k = Math.min(bw / png.width, (bh - labelH - 2) / png.height);
      page.drawImage(png, { x: bx, y: by + labelH + 2, width: png.width * k, height: png.height * k });
    }
    page.drawText(latin1(`Signed electronically by ${s.name} - ${fmt(s.at)}`), { x: bx, y: by, size: Math.max(5, labelH * 0.8), font: helv, color: rgb(0.25, 0.25, 0.25) });
  }

  // Certificado
  let cp = doc.addPage([612, 792]);
  let y = 740;
  const line = (t, f = helv, size = 10, gap = 16) => { if (y < 60) { cp = doc.addPage([612, 792]); y = 740; } cp.drawText(latin1(t), { x: 56, y, size, font: f, color: rgb(0.1, 0.1, 0.1), maxWidth: 500 }); y -= gap; };
  line('HORIZON RCRDS', bold, 16, 24);
  line('Electronic signature certificate', bold, 13, 28);
  line(`Document: ${data.title}`, helv, 10, 18);
  line('Document fingerprint (SHA-256 of the PDF that was signed):', bold, 9, 13);
  line(data.hash || '', helv, 8.5, 22);
  for (const one of list) {
    const s = one.signed;
    if (!s) continue;
    if (y < 150) { cp = doc.addPage([612, 792]); y = 740; }
    line(`${one.label ? one.label + ' - ' : ''}Signed by: ${s.name}`, bold, 10, 15);
    line(`Email: ${s.email}`, helv, 9.5, 14);
    line(`Date and time: ${fmt(s.at)}   IP address: ${s.ip || '-'}`, helv, 9.5, 14);
    line(`Device: ${(s.ua || '-').slice(0, 110)}`, helv, 7.5, 13);
    line(`Signature method: ${s.signature.startsWith('typed:') ? 'typed name' : 'signature adopted on screen (typed or drawn)'}`, helv, 9, 22);
  }
  line('Each signer opened the document with their private link, confirmed their email address,', helv, 9, 13);
  line('read the document above, confirmed that they agree to it and signed it online.', helv, 9, 13);
  line('The fingerprint proves that the signed document is exactly this file: any change gives a different fingerprint.', helv, 9, 20);
  if (data.link) line(`Signed copy: ${data.link}`, helv, 8.5, 14);
  doc.setTitle(`${latin1(data.title)} (signed)`);
  doc.setProducer('HORIZON RCRDS');
  return doc.save();
}
