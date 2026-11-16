/* HORIZON RCRDS — firma de contratos (/sign/<token>).
   Acceso: el enlace es único y solo se abre con el email al que se envió. Se lee el contrato, se firma en su recuadro
   («SIGN HERE»: dibujada o escrita, a nombre del nombre legal del contrato) y abajo se envía. Después, pantalla final
   (gracias + descargar cuando hayan firmado todos). Un draft solo se mira. La página no se recarga. */
(() => {
  const root = document.getElementById('root'), statusEl = document.getElementById('status');
  const token = (location.pathname.match(/^\/sign\/([\w-]{20,64})/) || [])[1] || '';
  const API = '/api/public/sign/' + encodeURIComponent(token);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  // letras de firma (Google Fonts, cargadas en sign.html)
  const FONTS = ["'Mrs Saint Delafield', cursive", "'Herr Von Muellerhoff', cursive", "'Great Vibes', cursive", "'Allura', cursive", "'Dancing Script', cursive", "'Sacramento', cursive"];
  let data = null, pdfBytes = null, hash = '', view = null, adopted = null, drawn = false, font = 0;
  // sesión (se recuerda en esta pestaña)
  const KEY = 'hz_sign_' + token;
  let sess = '';
  try { sess = sessionStorage.getItem(KEY) || ''; } catch { /* nada */ }
  const hdr = () => (sess ? { 'X-Sign-Session': sess } : {});
  const get = (path = '') => fetch(API + path, { cache: 'no-store', headers: hdr() });
  const post = (path, body) => fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr() }, body: JSON.stringify(body || {}) });
  const setStatus = (t, ok) => { statusEl.className = 'status' + (ok ? ' ok' : ''); statusEl.textContent = t; };

  // entrar: el email al que se envió
  function gate(message = '') {
    setStatus('Private contract');
    root.innerHTML = `
      <form class="panel gate" id="gate" novalidate>
        <h2>Open your contract</h2>
        <p class="msg">This link is private. Enter the email address where you received it.</p>
        <div class="field"><label for="g-email">Email</label><input id="g-email" name="email" type="email" autocomplete="email" maxlength="160"></div>
        <p class="err" id="g-err" role="alert"${message ? '' : ' hidden'}>${esc(message)}</p>
        <div class="actions"><button type="submit" class="btn">Open</button></div>
      </form>`;
    const f = document.getElementById('gate'), err = document.getElementById('g-err'), btn = f.querySelector('.btn');
    f.elements.email.focus();
    f.addEventListener('submit', async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        const v = f.elements.email.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) throw new Error('Please write a valid email.');
        const r = await post('/open', { email: v }); const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.session) throw new Error(j.message || 'Something went wrong. Please try again.');
        sess = j.session; try { sessionStorage.setItem(KEY, sess); } catch { /* nada */ }
        load();
      } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; }
    });
  }

  async function load() {
    try {
      const r = await get();
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || j.gate) { sess = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } return gate(); }
      if (!r.ok) throw new Error(j.message || 'This contract link is not valid.');
      data = j;
      document.title = `${data.title} — HORIZON RCRDS`;
      if (data.me.signed && !data.draft) return done();
      root.innerHTML = '<p class="msg">Loading the contract…</p>';
      const f = await get('/pdf');
      if (!f.ok) throw new Error('The contract file could not be loaded. Please reload the page.');
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      hash = await HZPDF.sha256(pdfBytes);
      await build();
    } catch (e) { root.innerHTML = `<h1>Contract</h1><p class="msg">${esc(e.message)}</p>`; }
  }
  const allSigned = () => data.signers.every(s => s.signed);
  const myPage = () => (data.me.box ? data.me.box.page + 1 : null);
  const marks = () => data.draft ? [] : data.signers.map((s, i) => {
    const mine = i === data.me.index;
    if (s.signed) return { box: s.box, sign: s.signed.signature, label: `Signed electronically by ${s.signed.name} - ${fmt(s.signed.at)}` };
    if (mine && adopted) return { box: s.box, sign: adopted.signature, label: 'Your signature (click to change it)', onClick: openAdopt, active: true };
    if (mine) return { box: s.box, title: 'Sign here', active: true, onClick: openAdopt };
    return { box: s.box, title: s.label ? `${s.label} signs here` : 'Another signer' };
  });

  // el contrato: se monta una vez; después solo cambian la barra, las firmas y el botón de enviar
  async function build() {
    root.innerHTML = `
      <div class="ds-bar" id="bar"></div>
      <h1 class="doc-title">${esc(data.title)}</h1>
      <div class="viewer" id="viewer"><p class="msg">Loading the contract…</p></div>
      <div class="ds-end" id="end"></div>`;
    view = await HZPDF.render(document.getElementById('viewer'), pdfBytes, { marks: marks() });
    refresh();
    // «leído hasta el final» (para el registro del sello), una vez
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) { io.disconnect(); post('/event', { event: 'read to the end' }).catch(() => {}); } });
      io.observe(document.getElementById('end'));
    }
  }
  function refresh() {
    const bar = document.getElementById('bar'), end = document.getElementById('end');
    if (data.draft) {
      setStatus('Draft');
      bar.innerHTML = '<p>This is a draft for you to review. There is nothing to sign yet.</p>';
      end.innerHTML = '';
      return;
    }
    setStatus('Needs your signature');
    bar.innerHTML = adopted
      ? '<p>Your signature is in place. Send it with the button at the end of the page.</p>'
      : '<p>Please read the whole contract and sign in the <b>SIGN HERE</b> box.</p>';
    if (view) HZPDF.drawMarks(view.pages, marks());
    end.innerHTML = adopted ? `
      <button type="button" class="btn" id="finish">Send signed contract</button>
      <p class="err" id="err" role="alert" hidden></p>` : '';
    document.getElementById('finish')?.addEventListener('click', finish);
  }

  // pantalla final: ya firmado
  function done() {
    const all = allSigned();
    setStatus(all ? 'Completed' : 'Signed', all);
    root.innerHTML = `
      <section class="ds-done">
        <img src="/assets/favicon_icon.png" alt="" class="ds-done-logo">
        <h1>Welcome to the <span class="nw">HORIZON RCRDS family</span></h1>
        <p class="lead">Thank you for choosing us. Your contract is signed.</p>
        <p class="msg">${esc(data.title)}</p>
        <p class="msg">${all ? 'Everyone has signed. You can download your copy below, and we have also emailed it to you.' : 'The other artists still have to sign. As soon as everyone has signed, you will get an email to download the signed contract.'}</p>
        <div class="actions">${all ? '<button type="button" class="btn" id="dl">Download contract</button>' : ''}<a class="btn ghost" href="/">Go to horizonrcrds.com</a></div>
      </section>`;
    document.getElementById('dl')?.addEventListener('click', e => download(e.currentTarget));
    window.scrollTo({ top: 0 });
  }

  /* «Adopt your signature»: dibujada (primero) o escrita, a nombre del nombre legal del contrato */
  function openAdopt() {
    if (data.me.signed || data.draft) return;
    const name = data.me.name || data.me.label || '';
    const m = document.createElement('div');
    m.className = 'ds-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Adopt your signature');
    m.innerHTML = `
      <form class="ds-card" novalidate>
        <h2>Adopt your signature</h2>
        <p class="msg">Signing as <b>${esc(name)}</b></p>
        <div class="ds-tabs" role="tablist"><button type="button" class="on" data-tab="draw" role="tab">Draw</button><button type="button" data-tab="type" role="tab">Type</button></div>
        <div class="ds-pane" data-pane="draw">
          <div class="pad-wrap"><canvas id="pad" aria-label="Draw your signature here"></canvas><button type="button" class="pad-clear" id="clear">Clear</button></div>
          <p class="pad-hint">Draw your signature with your finger or mouse.</p>
        </div>
        <div class="ds-pane" data-pane="type" hidden>
          <div class="ds-styles">${FONTS.map((f, i) => `<button type="button" class="ds-style${i === font ? ' on' : ''}" data-font="${i}" style="font-family:${f}">${esc(name)}</button>`).join('')}</div>
        </div>
        <label class="agree"><input type="checkbox" name="agree"><span>I have read the whole contract and I agree to it. This is my electronic signature, legally the same as signing on paper.</span></label>
        <p class="err" id="a-err" role="alert" hidden></p>
        <div class="ds-actions"><button type="submit" class="btn">Adopt and sign</button><button type="button" class="btn ghost" id="a-cancel">Cancel</button></div>
      </form>`;
    document.body.appendChild(m);
    const f = m.querySelector('form');
    let tab = 'draw';
    setupPad(m.querySelector('#pad'));
    m.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      m.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
      m.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab; });
      if (tab === 'draw') setupPad(m.querySelector('#pad'));
    }));
    m.querySelectorAll('[data-font]').forEach(b => b.addEventListener('click', () => { font = Number(b.dataset.font); m.querySelectorAll('[data-font]').forEach(x => x.classList.toggle('on', x === b)); }));
    const close = () => m.remove();
    m.querySelector('#a-cancel').addEventListener('click', close);
    m.addEventListener('click', e => { if (e.target === m) close(); });   // clic fuera: se cierra sin firmar
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const err = m.querySelector('#a-err'), show = t => { err.textContent = t; err.hidden = false; };
      if (tab === 'draw' && !drawn) return show('Please draw your signature, or choose Type.');
      if (!f.elements.agree.checked) return show('Please confirm that you have read and agree to the contract.');
      if (tab === 'type') try { await document.fonts.load(`64px ${FONTS[font]}`, name); } catch { /* letra del sistema */ }
      adopted = { signature: tab === 'draw' ? trimmed(m.querySelector('#pad')) : typedImage(name, FONTS[font]) };
      close();
      refresh();
      document.getElementById('end').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  function setupPad(c) {
    const ctx = c.getContext('2d');
    const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    c.width = r.width * d; c.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; drawn = false;
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
  // firma recortada al trazo
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
    if (!adopted?.signature) return;   // sin firma no se envía nada
    btn.disabled = true; btn.textContent = 'Sending…'; err.hidden = true;
    try {
      const r = await post('', { signature: adopted.signature, agree: true, hash });
      const j = await r.json().catch(() => ({}));
      // la sesión caducó (12 h con la página abierta): se vuelve a pedir el email; la firma adoptada se queda puesta
      if (r.status === 401) { sess = ''; try { sessionStorage.removeItem(KEY); } catch { /* nada */ } return gate('Your session expired. Enter your email again: your signature stays in place.'); }
      if (!r.ok) throw new Error(j.message || 'Something went wrong. Please try again.');
      data = j; adopted = null;
      done();
    } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send signed contract'; }
  }
  // «HORIZON RCRDS RELEASE CONTRACT ｜ Artista - Track.pdf» (la barra normal no se permite en nombres de archivo)
  async function download(btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const name = `${data.title.replace(/\|/g, '｜').replace(/[\\/:*?"<>]+/g, '').trim() || 'Contract'}.pdf`;
      const r = await get('/signed');
      if (r.ok) HZPDF.download(new Uint8Array(await r.arrayBuffer()), name);
      else {
        // todavía no está guardado el oficial: se hace aquí igual (todos han firmado)
        if (!pdfBytes) pdfBytes = new Uint8Array(await (await get('/pdf')).arrayBuffer());
        const out = await HZPDF.signed(pdfBytes, { title: data.title, hash: data.pdf_hash,
          signers: data.signers.map(s => ({ label: s.label, box: s.box, signed: s.signed ? { ...s.signed, hash: data.pdf_hash } : null })) });
        HZPDF.download(out, name);
      }
    } catch (e) { alert('The contract could not be downloaded: ' + e.message); }
    btn.disabled = false; btn.textContent = label;
  }
  load();
})();
