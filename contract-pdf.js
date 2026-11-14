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
    drawBox(pages, opts.box, opts.sign, opts.signedLabel);
    return { pages, numPages: pdf.numPages };
  }
  function drawBox(pages, box, sign, label) {
    for (const p of pages) p.querySelectorAll('.pdf-box').forEach(b => b.remove());
    if (!box || !pages[box.page]) return;
    const el = document.createElement('div');
    el.className = 'pdf-box' + (sign ? ' is-signed' : '');
    el.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;pointer-events:none;`;
    if (sign) {
      if (sign.startsWith('typed:')) {
        const t = document.createElement('div');
        t.className = 'pdf-typed';
        t.textContent = sign.slice(6);
        el.appendChild(t);
      } else {
        const im = new Image(); im.src = sign; im.alt = 'Signature';
        im.style.cssText = 'width:100%;height:78%;object-fit:contain;object-position:left bottom;display:block';
        el.appendChild(im);
      }
      if (label) { const s = document.createElement('div'); s.className = 'pdf-sig-label'; s.textContent = label; el.appendChild(s); }
    } else {
      el.innerHTML = '<span>Artist signature</span>';
    }
    pages[box.page].appendChild(el);
  }

  // pdf-lib usa fuentes estándar (Latin-1): lo que no quepa se cambia por «?» en el texto añadido
  const latin1 = s => String(s ?? '').normalize('NFC').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  const fmt = t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  /* data: { title, box, signed: { name, email, at, ip, ua, signature, hash }, link } → Uint8Array */
  async function signed(bytes, data) {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.load(bytes.slice(0));
    const helv = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), ital = await doc.embedFont(StandardFonts.TimesRomanItalic);
    const s = data.signed, b = data.box;
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
      const png = await doc.embedPng(s.signature);
      const maxW = bw, maxH = bh - labelH - 2;
      const k = Math.min(maxW / png.width, maxH / png.height);
      page.drawImage(png, { x: bx, y: by + labelH + 2, width: png.width * k, height: png.height * k });
    }
    page.drawText(latin1(`Signed electronically by ${s.name} - ${fmt(s.at)}`), { x: bx, y: by, size: Math.max(5, labelH * 0.8), font: helv, color: rgb(0.25, 0.25, 0.25) });

    // Certificado
    const cp = doc.addPage([612, 792]);
    let y = 740;
    const line = (t, f = helv, size = 10, gap = 16) => { cp.drawText(latin1(t), { x: 56, y, size, font: f, color: rgb(0.1, 0.1, 0.1), maxWidth: 500 }); y -= gap; };
    line('HORIZON RCRDS', bold, 16, 24);
    line('Electronic signature certificate', bold, 13, 28);
    line(`Document: ${data.title}`, helv, 10, 18);
    line(`Document fingerprint (SHA-256 of the PDF that was signed):`, bold, 9, 13);
    line(s.hash, helv, 8.5, 22);
    line(`Signed by: ${s.name}`, helv, 10, 16);
    line(`Email: ${s.email}`, helv, 10, 16);
    line(`Date and time: ${fmt(s.at)}`, helv, 10, 16);
    line(`IP address: ${s.ip || '-'}`, helv, 10, 16);
    line(`Device: ${(s.ua || '-').slice(0, 110)}`, helv, 8, 22);
    line(`Signature method: ${s.signature.startsWith('typed:') ? 'typed name' : 'handwritten signature drawn on screen'}`, helv, 10, 16);
    line('The signer read the document above, confirmed that they agree to it and signed it online.', helv, 9, 13);
    line('The fingerprint proves that the signed document is exactly this file: any change gives a different fingerprint.', helv, 9, 20);
    if (data.link) line(`Signed copy: ${data.link}`, helv, 8.5, 14);
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
  window.HZPDF = { sha256, render, drawBox, signed, download, load };
})();
