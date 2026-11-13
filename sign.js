/* HORIZON RCRDS — firma de contratos (página /sign/<token>). */
(() => {
  const root = document.getElementById('root'), statusEl = document.getElementById('status');
  const token = (location.pathname.match(/^\/sign\/([\w-]{20,64})/) || [])[1] || '';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  let data = null, hash = '', drawn = false;

  async function sha256(s) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function sigHtml(s) {
    if (!s) return '';
    const sig = s.signature.startsWith('typed:') ? `<div class="typed-sig">${esc(s.signature.slice(6))}</div>` : `<img src="${esc(s.signature)}" alt="Signature">`;
    return `<div class="sigblock"><h3>Signed electronically</h3>${sig}
      <p><b>${esc(s.name)}</b> · ${esc(s.email)}<br>${esc(fmt(s.at))}</p>
      <p class="cert">Document fingerprint (SHA-256): ${esc(s.hash)}<br>IP address: ${esc(s.ip || '—')}</p></div>`;
  }
  function render() {
    document.title = `${data.title} — HORIZON RCRDS`;
    const signed = data.status === 'signed';
    statusEl.className = 'status' + (signed ? ' ok' : '');
    statusEl.textContent = signed ? 'Signed' : 'Pending signature';
    root.innerHTML = `
      <h1>${esc(data.title)}</h1>
      <p class="sub">${signed ? 'This contract has been signed. You can keep a copy (Download / print → Save as PDF).' : 'Please read the whole contract. At the end you can sign it.'}</p>
      <article class="doc" id="doc">${data.html}${signed ? sigHtml(data.signed) : ''}</article>
      ${signed ? `<div class="actions"><button type="button" class="btn" id="print">Download / print</button></div>` : `
      <form class="panel" id="sign" novalidate>
        <h2>Sign the contract</h2>
        <div class="field"><label for="s-name">Full legal name</label><input id="s-name" name="name" type="text" autocomplete="name" maxlength="160" required value=""></div>
        <div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" autocomplete="email" maxlength="160" required value="${esc(data.email)}"></div>
        <div class="field"><label>Signature</label>
          <div class="pad-wrap"><canvas id="pad" aria-label="Draw your signature here"></canvas></div>
          <div class="pad-actions"><span id="pad-hint">Draw your signature with your finger or mouse.</span><button type="button" class="link-btn" id="clear">Clear</button></div>
          <p class="msg" style="margin:10px 0 6px;font-size:14px">…or type your name as your signature:</p>
          <input name="typed" type="text" maxlength="120" aria-label="Typed signature" autocomplete="off">
        </div>
        <label class="agree"><input type="checkbox" name="agree"><span>I have read the whole contract and I agree to it. I understand that signing here is legally the same as signing on paper.</span></label>
        <p class="err" id="err" role="alert" hidden></p>
        <button class="btn" type="submit">Sign contract</button>
      </form>`}`;
    if (signed) document.getElementById('print').addEventListener('click', () => window.print());
    else setupPad();
  }
  function setupPad() {
    const c = document.getElementById('pad'), ctx = c.getContext('2d');
    const size = () => { const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1; const img = drawn ? c.toDataURL() : null; c.width = r.width * d; c.height = r.height * d; ctx.scale(d, d); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; if (img) { const i = new Image(); i.onload = () => ctx.drawImage(i, 0, 0, r.width, r.height); i.src = img; } };
    size(); window.addEventListener('resize', size);
    let down = false, last = null;
    const pt = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', e => { down = true; last = pt(e); c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => { if (!down) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; });
    const up = () => { down = false; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    document.getElementById('clear').addEventListener('click', () => { ctx.clearRect(0, 0, c.width, c.height); drawn = false; });
  }
  async function load() {
    try {
      const r = await fetch('/api/public/sign/' + encodeURIComponent(token), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'This contract link is not valid.');
      data = j; hash = await sha256(data.html);
      render();
    } catch (e) { root.innerHTML = `<h1>Contract</h1><p class="msg">${esc(e.message)}</p>`; }
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
      const r = await fetch('/api/public/sign/' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, typed: drawn ? '' : typed, signature: drawn ? document.getElementById('pad').toDataURL('image/png') : '', agree: true, hash }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || 'Something went wrong. Please try again.');
      data = j; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (x) { show(x.message); btn.disabled = false; btn.textContent = 'Sign contract'; }
  });
  load();
})();
