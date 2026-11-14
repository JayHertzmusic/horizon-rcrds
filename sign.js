/* HORIZON RCRDS — firma de contratos (página /sign/<token>). El contrato es el PDF exacto del sello. */
(() => {
  const root = document.getElementById('root'), statusEl = document.getElementById('status');
  const token = (location.pathname.match(/^\/sign\/([\w-]{20,64})/) || [])[1] || '';
  const API = '/api/public/sign/' + encodeURIComponent(token);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  let data = null, pdfBytes = null, hash = '', drawn = false, view = null;

  async function load() {
    try {
      const r = await fetch(API, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'This contract link is not valid.');
      data = j;
      const f = await fetch(API + '/pdf', { cache: 'no-store' });
      if (!f.ok) throw new Error('The contract file could not be loaded. Please reload the page.');
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      hash = await HZPDF.sha256(pdfBytes);
      await render();
    } catch (e) { root.innerHTML = `<h1>Contract</h1><p class="msg">${esc(e.message)}</p>`; }
  }
  async function render() {
    document.title = `${data.title} — HORIZON RCRDS`;
    const signed = data.status === 'signed', s = data.signed;
    statusEl.className = 'status' + (signed ? ' ok' : '');
    statusEl.textContent = signed ? 'Signed' : 'Pending signature';
    root.innerHTML = `
      <h1>${esc(data.title)}</h1>
      <p class="sub">${signed ? 'This contract has been signed. Download your signed copy below.' : 'Please read the whole contract. Your signature will be placed in the marked box. The form to sign is at the end.'}</p>
      ${signed ? `<div class="actions" style="margin:0 0 18px"><button type="button" class="btn" id="dl">Download signed PDF</button></div>` : ''}
      <div class="viewer" id="viewer"><p class="msg">Loading the contract…</p></div>
      ${signed ? `<div class="proof"><b>Signed electronically</b> by ${esc(s.name)} (${esc(s.email)}) on ${esc(fmt(s.at))}.<br><code>Document fingerprint (SHA-256): ${esc(s.hash)}</code></div>` : `
      <form class="panel" id="sign" novalidate>
        <h2>Sign the contract</h2>
        <div class="field"><label for="s-name">Full legal name</label><input id="s-name" name="name" type="text" autocomplete="name" maxlength="160" required></div>
        <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" autocomplete="email" maxlength="160" required value="${esc(data.email)}"></div>
        <div class="field"><label>Signature</label>
          <div class="pad-wrap"><canvas id="pad" aria-label="Draw your signature here"></canvas></div>
          <div class="pad-actions"><span>Draw your signature with your finger or mouse.</span><button type="button" class="link-btn" id="clear">Clear</button></div>
          <p class="msg" style="margin:10px 0 6px;font-size:14px">…or type your name as your signature:</p>
          <input name="typed" type="text" maxlength="120" aria-label="Typed signature" autocomplete="off">
        </div>
        <label class="agree"><input type="checkbox" name="agree"><span>I have read the whole contract and I agree to it. I understand that signing here is legally the same as signing on paper.</span></label>
        <p class="err" id="err" role="alert" hidden></p>
        <button class="btn" type="submit">Sign contract</button>
      </form>`}`;
    view = await HZPDF.render(document.getElementById('viewer'), pdfBytes, {
      box: data.box, sign: signed ? s.signature : null, signedLabel: signed ? `Signed electronically by ${s.name} - ${fmt(s.at)}` : '',
    });
    if (signed) document.getElementById('dl').addEventListener('click', downloadSigned);
    else setupPad();
  }
  async function downloadSigned() {
    const btn = document.getElementById('dl');
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const out = await HZPDF.signed(pdfBytes, { title: data.title, box: data.box, signed: data.signed, link: location.href });
      HZPDF.download(out, `${data.title.replace(/[^\w\- ]+/g, '').trim() || 'contract'} - signed.pdf`);
    } catch (e) { alert('The signed PDF could not be created: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Download signed PDF';
  }
  function setupPad() {
    const c = document.getElementById('pad'), ctx = c.getContext('2d');
    const size = () => { const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; c.width = r.width * d; c.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; drawn = false; };
    size();
    let down = false, last = null;
    const pt = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', e => { down = true; last = pt(e); c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => { if (!down) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; });
    const up = () => { down = false; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    document.getElementById('clear').addEventListener('click', () => { ctx.clearRect(0, 0, c.width, c.height); drawn = false; });
  }
  // la firma dibujada se recorta al trazo (sin el blanco de alrededor) para que quepa bien en la línea del contrato
  function trimmedSignature() {
    const c = document.getElementById('pad'), ctx = c.getContext('2d');
    const { width: w, height: h } = c, d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0 || y1 <= y0) return c.toDataURL('image/png');
    const pad = 6, o = document.createElement('canvas');
    o.width = x1 - x0 + pad * 2; o.height = y1 - y0 + pad * 2;
    o.getContext('2d').drawImage(c, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }
  document.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = document.getElementById('err'), btn = f.querySelector('.btn');
    const show = m => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    const name = f.elements.name.value.trim(), email = f.elements.email.value.trim(), typed = f.elements.typed.value.trim();
    if (name.length < 3) return show('Please write your full legal name.');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return show('Please write a valid email.');
    if (!drawn && !typed) return show('Please draw your signature or type your name.');
    if (!f.elements.agree.checked) return show('Please confirm that you have read and agree to the contract.');
    btn.disabled = true; btn.textContent = 'Signing…';
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, typed: drawn ? '' : typed, signature: drawn ? trimmedSignature() : '', agree: true, hash }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'Something went wrong. Please try again.');
      data = j; await render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (x) { show(x.message); btn.disabled = false; btn.textContent = 'Sign contract'; }
  });
  load();
})();
