/* HORIZON RCRDS — contratos en PDF (lo usan el panel y la página de firma).
   - HZPDF.render(): dibuja el PDF tal cual (pdf.js), página a página, y opcionalmente el recuadro de la firma.
   - HZPDF.signed(): crea el PDF firmado a partir del PDF original + la firma (pdf-lib): la firma va en el recuadro
     elegido y se añade al final una página de certificado. El resto del documento no cambia.
   Necesita /assets/vendor/pdf/pdf.min.js y /assets/vendor/pdf/pdf-lib.min.js cargados antes. */
(() => {
  const WORKER = '/assets/vendor/pdf/pdf.worker.min.js';
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;

  async function sha256(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function load(bytes) {
    return window.pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false, disableFontFace: false }).promise;
  }
  /* opts: { box, sign (dataURL o 'typed:Nombre'), signedLabel, onPage(pageIndex, x, y), maxWidth } */
  async function render(container, bytes, opts = {}) {
    const pdf = await load(bytes);
    container.innerHTML = '';
    const width = Math.min(opts.maxWidth || 900, container.clientWidth || 900);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const vp = page.getViewport({ scale: scale * dpr });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.style.cssText = `position:relative;width:${width}px;height:${Math.round(base.height * scale)}px;margin:0 auto 14px;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.45)`;
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      c.style.cssText = 'display:block;width:100%;height:100%';
      wrap.appendChild(c);
      // número de página, pequeño, abajo a la derecha (el mismo sitio que en el PDF firmado)
      if (!opts.noNumbers) {
        const num = document.createElement('span');
        num.className = 'pdf-num'; num.textContent = i;
        num.style.cssText = `position:absolute;right:${40 * scale}px;bottom:${24 * scale}px;font:${8 * scale}px/1 Arial,sans-serif;color:#777;pointer-events:none`;
        wrap.appendChild(num);
      }
      container.appendChild(wrap);
      // intent 'print': no espera a requestAnimationFrame (si no, se queda parado con la pestaña en segundo plano)
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
      const idx = i - 1;
      if (opts.onPage) {
        wrap.style.cursor = 'crosshair';
        wrap.addEventListener('click', e => {
          const r = wrap.getBoundingClientRect();
          opts.onPage(idx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
        });
      }
      pages.push(wrap);
    }
    drawMarks(pages, opts.marks || (opts.box ? [{ box: opts.box, sign: opts.sign, label: opts.signedLabel }] : []));
    return { pages, numPages: pdf.numPages };
  }
  /* marks: [{ box, title, sign, label, active, onClick }] — un recuadro por firmante */
  function drawMarks(pages, marks) {
    for (const p of pages) p.querySelectorAll('.pdf-box').forEach(b => b.remove());
    for (const mk of marks || []) {
      const box = mk.box;
      if (!box || !pages[box.page]) continue;
      const el = document.createElement('div');
      el.className = 'pdf-box' + (mk.sign ? ' is-signed' : '') + (mk.active ? ' is-active' : '') + (mk.onClick ? ' is-click' : '');
      el.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;${mk.onClick ? '' : 'pointer-events:none;'}`;
      if (mk.sign) {
        if (mk.sign.startsWith('typed:')) {
          const t = document.createElement('div'); t.className = 'pdf-typed'; t.textContent = mk.sign.slice(6); el.appendChild(t);
        } else {
          // igual que en el PDF firmado: centrada y apoyada sobre la línea
          const im = new Image(); im.src = mk.sign; im.alt = 'Signature';
          im.style.cssText = 'position:absolute;left:5%;bottom:-1px;width:90%;height:62%;object-fit:contain;object-position:center bottom;display:block';
          el.appendChild(im);
        }
        if (mk.label) el.title = mk.label;
      } else {
        const t = document.createElement('span'); t.className = 'pdf-flag'; t.textContent = mk.title || 'Sign here'; el.appendChild(t);
      }
      if (mk.onClick) el.addEventListener('click', e => { e.stopPropagation(); mk.onClick(); });
      pages[box.page].appendChild(el);
      mk.el = el;
    }
  }
  const drawBox = (pages, box, sign, label) => drawMarks(pages, box ? [{ box, sign, label }] : []);

  // pdf-lib usa fuentes estándar (Latin-1): lo que no quepa se cambia por «?» en el texto añadido
  const latin1 = s => String(s ?? '').normalize('NFC').replace(/[^\x20-\x7e\xa0-\xff–—‘’“”•…€™]/g, '?');
  const fmt = t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  /* data: { title, box, signed: { name, email, at, ip, ua, signature, hash }, link } → Uint8Array */
  async function signed(bytes, data) {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.load(bytes.slice(0));
    const helv = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), ital = await doc.embedFont(StandardFonts.TimesRomanItalic);
    const list = data.signers || [{ box: data.box, signed: data.signed }];
    // número de página en cada hoja del contrato (no en el certificado)
    doc.getPages().forEach((pg, i) => {
      const t = String(i + 1), { width: W } = pg.getSize();
      pg.drawText(t, { x: W - 40 - helv.widthOfTextAtSize(t, 8), y: 24, size: 8, font: helv, color: rgb(0.47, 0.47, 0.47) });
    });
    for (const one of list) {
      const s = one.signed, b = one.box;
      if (!s || !b) continue;
      const page = doc.getPage(Math.min(b.page, doc.getPageCount() - 1));
      const { width: W, height: H } = page.getSize();
      const bx = b.x * W, bw = b.w * W, bh = b.h * H, by = H - b.y * H - bh;
      // como una firma a mano: centrada sobre la línea y apoyada en ella (los datos van en el certificado)
      if (s.signature.startsWith('typed:')) {
        const txt = latin1(s.signature.slice(6));
        let size = Math.min(bh * 0.55, 24);
        while (size > 6 && ital.widthOfTextAtSize(txt, size) > bw * 0.9) size -= 1;
        page.drawText(txt, { x: bx + (bw - ital.widthOfTextAtSize(txt, size)) / 2, y: by + 2, size, font: ital, color: rgb(0.05, 0.05, 0.2) });
      } else {
        const png = await doc.embedPng(s.signature);
        const k = Math.min(bw * 0.9 / png.width, bh * 0.62 / png.height), iw = png.width * k, ih = png.height * k;
        page.drawImage(png, { x: bx + (bw - iw) / 2, y: by - 1, width: iw, height: ih });
      }
    }

    // Certificado: logo, datos del documento y una ficha por firmante (con su firma)
    let cp = doc.addPage([612, 792]);
    const ink = rgb(0.07, 0.07, 0.07), soft = rgb(0.42, 0.42, 0.45), rule = rgb(0.86, 0.86, 0.88);
    const txt = (t, x, yy, f = helv, size = 10, color = ink) => cp.drawText(latin1(t), { x, y: yy, size, font: f, color });
    let logo = null;
    try { logo = await doc.embedPng(new Uint8Array(await (await fetch('/assets/favicon_icon.png')).arrayBuffer())); } catch { /* sin logo */ }
    const head = () => {
      if (logo) cp.drawImage(logo, { x: 56, y: 712, width: 40, height: 40 });
      txt('HORIZON RCRDS', logo ? 108 : 56, 734, bold, 15);
      txt('Electronic signature certificate', logo ? 108 : 56, 716, helv, 10, soft);
      cp.drawLine({ start: { x: 56, y: 694 }, end: { x: 556, y: 694 }, thickness: 0.8, color: rule });
    };
    head();
    let y = 664;
    txt('DOCUMENT', 56, y, bold, 7.5, soft); y -= 16;
    txt(data.title, 56, y, bold, 12); y -= 22;
    txt('DOCUMENT FINGERPRINT (SHA-256 OF THE PDF THAT WAS SIGNED)', 56, y, bold, 7.5, soft); y -= 14;
    txt(data.hash || list.find(x => x.signed)?.signed.hash || '', 56, y, helv, 8.5); y -= 30;
    const device = ua => { ua = ua || ''; const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
      const o = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''; return o ? `${b} on ${o}` : b; };
    for (const one of list) {
      const s = one.signed;
      if (!s) continue;
      if (y < 190) { cp = doc.addPage([612, 792]); head(); y = 664; }
      const top = y + 12, h = 118;
      cp.drawRectangle({ x: 56, y: top - h, width: 500, height: h, borderColor: rule, borderWidth: 0.8 });
      txt(one.label ? `ARTIST · ${one.label}` : 'SIGNER', 72, y - 6, bold, 7.5, soft);
      txt(s.name, 72, y - 24, bold, 13);
      const row = (k, v, yy) => { txt(k, 72, yy, bold, 8, soft); txt(v, 150, yy, helv, 9); };
      row('Email', s.email || '-', y - 46); row('Signed on', fmt(s.at), y - 62); row('IP address', s.ip || '-', y - 78); row('Device', device(s.ua), y - 94);
      // la firma, a la derecha
      try {
        if (!s.signature.startsWith('typed:')) {
          const png = await doc.embedPng(s.signature), k = Math.min(150 / png.width, 52 / png.height);
          cp.drawImage(png, { x: 396 + (150 - png.width * k) / 2, y: y - 66, width: png.width * k, height: png.height * k });
        } else txt(s.signature.slice(6), 400, y - 50, ital, 18, rgb(0.05, 0.05, 0.2));
        cp.drawLine({ start: { x: 396, y: y - 70 }, end: { x: 546, y: y - 70 }, thickness: 0.6, color: ink });
        txt('Signature', 396, y - 82, helv, 7.5, soft);
      } catch { /* firma no legible */ }
      y = top - h - 22;
    }
    if (y < 110) { cp = doc.addPage([612, 792]); head(); y = 664; }
    for (const t of ['Each signer opened the document with their private link and their email address, read it, confirmed that',
      'they agree to it and signed it online. The fingerprint proves that the signed document is exactly this file:',
      'any change to it gives a different fingerprint.']) { txt(t, 56, y, helv, 8.5, soft); y -= 13; }
    if (data.link) { y -= 6; txt(`Signed copy: ${data.link}`, 56, y, helv, 8, soft); }
    txt('horizonrcrds.com', 56, 40, helv, 8, soft);
    doc.setTitle(`${latin1(data.title)} (signed)`);
    doc.setProducer('HORIZON RCRDS');
    return doc.save();
  }
  function download(bytes, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  window.HZPDF = { sha256, render, drawBox, drawMarks, signed, download, load };
})();
