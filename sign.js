/* HORIZON RCRDS — firma de contratos (/sign/<token>), al estilo DocuSign:
   barra arriba con START → lleva a la pestaña amarilla «SIGN HERE» del documento → «Adopt your signature» (escrita o
   dibujada) → FINISH. El documento es el PDF exacto del sello; cada firmante tiene su enlace y su recuadro. */
(() => {
  const root = document.getElementById('root'), statusEl = document.getElementById('status');
  const token = (location.pathname.match(/^\/sign\/([\w-]{20,64})/) || [])[1] || '';
  const API = '/api/public/sign/' + encodeURIComponent(token);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  // letras de firma (Google Fonts, cargadas en sign.html)
  const FONTS = ["'Mrs Saint Delafield', cursive", "'Herr Von Muellerhoff', cursive", "'Great Vibes', cursive", "'Allura', cursive", "'Dancing Script', cursive", "'Sacramento', cursive"];
  let data = null, pdfBytes = null, hash = '', view = null, adopted = null, drawn = false, font = 0;
  // acceso: el email al que se envió el contrato (se recuerda en esta pestaña)
  const KEY = 'hz_sign_' + token;
  let who = '';
  try { who = sessionStorage.getItem(KEY) || ''; } catch { /* nada */ }
  const get = (path = '') => fetch(API + path, { cache: 'no-store', headers: who ? { 'X-Signer-Email': who } : {} });

  function gate(message = '') {
    statusEl.className = 'status'; statusEl.textContent = 'Private contract';
    root.innerHTML = `
      <form class="panel gate" id="gate" novalidate>
        <h2>Open your contract</h2>
        <p class="msg">For your security, enter the email address where you received this contract.</p>
        <div class="field"><label for="g-email">Email</label><input id="g-email" name="email" type="email" autocomplete="email" maxlength="160" value="${esc(who)}"></div>
        <p class="err" id="g-err" role="alert"${message ? '' : ' hidden'}>${esc(message)}</p>
        <div class="actions"><button type="submit" class="btn">Continue</button></div>
      </form>`;
    const f = document.getElementById('gate');
    f.elements.email.focus();
    f.addEventListener('submit', e => {
      e.preventDefault();
      const v = f.elements.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) { const er = document.getElementById('g-err'); er.textContent = 'Please write a valid email.'; er.hidden = false; return; }
      who = v; f.querySelector('.btn').disabled = true;
      load();
    });
  }

  async function load() {
    try {
      const r = await get();
      const j = await r.json().catch(() => ({}));
      if (r.status === 403 && who) { who = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } return gate(j.message); }
      if (!r.ok) throw new Error(j.message || 'This contract link is not valid.');
      if (j.gate) return gate();
      if (who) try { sessionStorage.setItem(KEY, who); } catch { /* nada */ }
      data = j;
      root.innerHTML = '<p class="msg">Loading the contract…</p>';
      const f = await get('/pdf');
      if (!f.ok) throw new Error('The contract file could not be loaded. Please reload the page.');
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      hash = await HZPDF.sha256(pdfBytes);
      await render();
    } catch (e) { root.innerHTML = `<h1>Contract</h1><p class="msg">${esc(e.message)}</p>`; }
  }
  const allSigned = () => data.signers.every(s => s.signed);
  const marks = () => data.signers.map((s, i) => {
    const mine = i === data.me.index;
    if (s.signed) return { box: s.box, sign: s.signed.signature, label: `Signed electronically by ${s.signed.name} - ${fmt(s.signed.at)}` };
    if (mine && adopted) return { box: s.box, sign: adopted.signature, label: `Signed electronically by ${adopted.name}`, onClick: openAdopt, active: true };
    if (mine) return { box: s.box, title: 'Sign here', active: true, onClick: openAdopt };
    return { box: s.box, title: s.label ? `${s.label} signs here` : 'Another signer' };
  });

  async function render() {
    document.title = `${data.title} — HORIZON RCRDS`;
    const done = data.me.signed, all = allSigned();
    statusEl.className = 'status' + (all ? ' ok' : '');
    statusEl.textContent = all ? 'Completed' : done ? 'Signed — waiting for others' : 'Needs your signature';
    root.innerHTML = `
      <div class="ds-bar${done ? ' done' : ''}">
        <p>${done ? (all ? 'Everyone has signed. You can download the signed contract.' : 'You have signed. The other signers have their own link; you can download your copy now.') : adopted ? 'Your signature is in place. Click <b>FINISH</b> to sign the contract.' : 'Please review the document below. When you are ready, click <b>START</b> to go to the place where you sign.'}</p>
        ${done ? '<button type="button" class="btn" id="dl">Download signed PDF</button>' : adopted ? '<button type="button" class="btn" id="finish">Finish</button>' : '<button type="button" class="btn" id="start">Start</button>'}
      </div>
      <h1>${esc(data.title)}</h1>
      <div class="viewer" id="viewer"><p class="msg">Loading the contract…</p></div>
      ${done ? `<div class="proof">${data.signers.filter(s => s.signed).map(s => `<b>${esc(s.signed.name)}</b>${s.label ? ` (${esc(s.label)})` : ''} signed on ${esc(fmt(s.signed.at))}`).join('<br>')}<br><code>Document fingerprint (SHA-256): ${esc(data.pdf_hash)}</code></div>` : ''}
      <p class="err" id="err" role="alert" hidden></p>`;
    view = await HZPDF.render(document.getElementById('viewer'), pdfBytes, { marks: marks() });
    document.getElementById('start')?.addEventListener('click', goToSign);
    document.getElementById('finish')?.addEventListener('click', finish);
    document.getElementById('dl')?.addEventListener('click', downloadSigned);
  }
  function goToSign() {
    const el = document.querySelector('.pdf-box.is-active');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 1800);
  }

  /* «Adopt your signature» */
  function openAdopt() {
    if (data.me.signed) return;
    const m = document.createElement('div');
    m.className = 'ds-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Adopt your signature');
    m.innerHTML = `
      <form class="ds-card" novalidate>
        <h2>Adopt your signature</h2>
        <p class="msg">Confirm your name and your signature.</p>
        <div class="field"><label for="a-name">Full legal name</label><input id="a-name" name="name" type="text" autocomplete="name" maxlength="160" value="${esc(adopted?.name || '')}"></div>
        <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" autocomplete="email" maxlength="160" value="${esc(adopted?.email || data.email || who || '')}"${data.email ? ' readonly' : ''}></div>
        <div class="ds-tabs" role="tablist"><button type="button" class="on" data-tab="type" role="tab">Type</button><button type="button" data-tab="draw" role="tab">Draw</button><button type="button" data-tab="upload" role="tab">Upload</button></div>
        <div class="ds-pane" data-pane="type">
          <div class="ds-styles">${FONTS.map((f, i) => `<button type="button" class="ds-style${i === font ? ' on' : ''}" data-font="${i}" style="font-family:${f}">Your name</button>`).join('')}</div>
        </div>
        <div class="ds-pane" data-pane="draw" hidden>
          <canvas id="pad" aria-label="Draw your signature here"></canvas>
          <div class="pad-actions"><span>Draw with your finger or mouse.</span><button type="button" class="link-btn" id="clear">Clear</button></div>
        </div>
        <div class="ds-pane" data-pane="upload" hidden>
          <label class="up-box" for="up-file"><img id="up-img" alt="" hidden><span id="up-txt">Choose a photo or image of your signature</span></label>
          <input type="file" id="up-file" accept="image/*" class="sr-only">
          <div class="pad-actions"><span>Sign on white paper and take a photo, or use a saved image. The background is removed.</span></div>
        </div>
        <label class="agree"><input type="checkbox" name="agree"><span>I have read the whole contract and I agree to it. By selecting <b>Adopt and sign</b>, I agree that this signature is the electronic representation of my signature, legally the same as signing on paper.</span></label>
        <p class="err" id="a-err" role="alert" hidden></p>
        <div class="ds-actions"><button type="submit" class="btn">Adopt and sign</button><button type="button" class="btn ghost" id="a-cancel">Cancel</button></div>
      </form>`;
    document.body.appendChild(m);
    const f = m.querySelector('form'), nameIn = f.elements.name;
    let tab = 'type';
    const preview = () => m.querySelectorAll('.ds-style').forEach(b => { b.textContent = nameIn.value.trim() || 'Your name'; });
    preview();
    nameIn.addEventListener('input', preview);
    nameIn.focus();
    m.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      m.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
      m.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab; });
      if (tab === 'draw') setupPad(m.querySelector('#pad'));
    }));
    // firma guardada: imagen → sin fondo y recortada a la tinta
    let uploaded = '';
    m.querySelector('#up-file').addEventListener('change', async ev => {
      const file = ev.target.files?.[0], err = m.querySelector('#a-err');
      if (!file) return;
      try {
        uploaded = await signatureFromImage(file);
        const im = m.querySelector('#up-img'); im.src = uploaded; im.hidden = false;
        m.querySelector('#up-txt').textContent = 'Change image'; err.hidden = true;
      } catch (x) { uploaded = ''; err.textContent = x.message; err.hidden = false; }
    });
    m.querySelectorAll('[data-font]').forEach(b => b.addEventListener('click', () => { font = Number(b.dataset.font); m.querySelectorAll('[data-font]').forEach(x => x.classList.toggle('on', x === b)); }));
    const close = () => m.remove();
    m.querySelector('#a-cancel').addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const err = m.querySelector('#a-err'), show = t => { err.textContent = t; err.hidden = false; };
      const name = nameIn.value.trim(), email = f.elements.email.value.trim();
      if (name.length < 3) return show('Please write your full legal name.');
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return show('Please write a valid email.');
      if (tab === 'draw' && !drawn) return show('Please draw your signature, or choose Type.');
      if (tab === 'upload' && !uploaded) return show('Please choose an image of your signature.');
      if (!f.elements.agree.checked) return show('Please confirm that you have read and agree to the contract.');
      if (tab !== 'draw') try { await document.fonts.load(`64px ${FONTS[font]}`, name); } catch { /* letra del sistema */ }
      adopted = { name, email, signature: tab === 'draw' ? trimmed(m.querySelector('#pad')) : tab === 'upload' ? uploaded : typedImage(name, FONTS[font]) };
      close();
      render().then(() => document.getElementById('finish')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    });
  }
  function setupPad(c) {
    const ctx = c.getContext('2d');
    const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    c.width = r.width * d; c.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; drawn = false;
    let down = false, last = null;
    const pt = e => { const b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    c.onpointerdown = e => { down = true; last = pt(e); c.setPointerCapture(e.pointerId); };
    c.onpointermove = e => { if (!down) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; };
    c.onpointerup = c.onpointercancel = () => { down = false; };
    c.parentElement.querySelector('#clear').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); drawn = false; };
  }
  // firma escrita → imagen (así se ve igual en el PDF firmado, con la letra elegida)
  function typedImage(name, family) {
    const c = document.createElement('canvas'), x = c.getContext('2d'), size = 96;
    x.font = `${size}px ${family}`;
    c.width = Math.ceil(x.measureText(name).width) + size; c.height = size * 2;
    x.font = `${size}px ${family}`; x.fillStyle = '#0d0d33'; x.textBaseline = 'middle';
    x.fillText(name, size / 2, c.height / 2);
    return trimmed(c);   // recortada a la tinta: así se apoya bien sobre la línea
  }
  // imagen de una firma (foto o archivo): el fondo claro se vuelve transparente y se recorta; tamaño contenido
  async function signatureFromImage(file) {
    if (!/^image\//.test(file.type)) throw new Error('Please choose an image (JPG or PNG).');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('That image could not be opened.')); i.src = url; });
      const k = Math.min(1, 1400 / img.width, 700 / img.height), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
      let ink = 0;
      for (let i = 0; i < p.length; i += 4) {
        const lum = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], a = p[i + 3] / 255;
        // claro → transparente; oscuro → tinta (más oscuro, más opaco)
        const alpha = a * Math.max(0, Math.min(1, (190 - lum) / 90));
        if (alpha > 0.1) ink++;
        p[i] = 13; p[i + 1] = 13; p[i + 2] = 51; p[i + 3] = Math.round(alpha * 255);
      }
      if (ink < 30) throw new Error('No signature found in that image. Use a dark pen on white paper.');
      x.putImageData(d, 0, 0);
      let out = trimmed(c);
      // que no pese demasiado (máx. ~300 KB)
      for (let w = 900; out.length > 290000 && w >= 200; w -= 150) {
        const t = new Image(); t.src = out; await t.decode();
        const r = document.createElement('canvas'), q = Math.min(1, w / t.width); r.width = Math.round(t.width * q); r.height = Math.round(t.height * q);
        r.getContext('2d').drawImage(t, 0, 0, r.width, r.height); out = r.toDataURL('image/png');
      }
      if (out.length > 290000) throw new Error('That image is too large. Try a smaller one.');
      return out;
    } finally { URL.revokeObjectURL(url); }
  }
  // firma dibujada recortada al trazo
  function trimmed(c) {
    const ctx = c.getContext('2d'), { width: w, height: h } = c, d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0 || y1 <= y0) return c.toDataURL('image/png');
    const pad = 6, o = document.createElement('canvas');
    o.width = x1 - x0 + pad * 2; o.height = y1 - y0 + pad * 2;
    o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }
  async function finish() {
    const btn = document.getElementById('finish'), err = document.getElementById('err');
    btn.disabled = true; btn.textContent = 'Signing…'; err.hidden = true;
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(who ? { 'X-Signer-Email': who } : {}) },
        body: JSON.stringify({ name: adopted.name, email: adopted.email, signature: adopted.signature, agree: true, hash }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'Something went wrong. Please try again.');
      data = j; adopted = null; await render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Finish'; }
  }
  async function downloadSigned() {
    const btn = document.getElementById('dl');
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const name = `${data.title.replace(/[^\w\- ]+/g, '').trim() || 'contract'} - signed.pdf`;
      if (allSigned()) {
        const r = await get('/signed');
        if (r.ok) { HZPDF.download(new Uint8Array(await r.arrayBuffer()), name); btn.disabled = false; btn.textContent = 'Download signed PDF'; return; }
      }
      const out = await HZPDF.signed(pdfBytes, { title: data.title, hash: data.pdf_hash,
        signers: data.signers.map(s => ({ label: s.label, box: s.box, signed: s.signed ? { ...s.signed, hash: data.pdf_hash } : null })) });
      HZPDF.download(out, name);
    } catch (e) { alert('The signed PDF could not be created: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Download signed PDF';
  }
  load();
})();
