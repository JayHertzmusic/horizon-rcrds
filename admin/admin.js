/* HORIZON RCRDS — panel (/admin para los owners, /team para el resto del equipo).
   Se entra con Google. El servidor de la web en Cloudflare (worker/index.js) revisa cada cambio contra el rol de
   quien lo hace y lo guarda: releases, mixtapes, playlists y los archivos subidos. Sale en la web al momento. */
'use strict';
(() => {
  const CFG = Object.assign({ api: '' }, window.HZ_CONFIG || {});
  const MODE = document.documentElement.dataset.panel === 'team' ? 'team' : 'admin';
  const SITE = '../';                 // el panel vive en <web>/admin/ o <web>/team/
  const AUTH_KEY = 'hz_panel_' + MODE;
  const COVER_PX = 1000;              // mismo tamaño que las portadas que ya tiene la web
  const MAX_AUDIO = 25 * 1024 * 1024;
  const MAX_IMAGE_IN = 30 * 1024 * 1024;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  let auth = null;        // { token (sesión del panel), user, sections, owner, repo, branch, root }
  let repo = null;        // { head, treeSha, files: Map(ruta → {sha,size}), truncated, releases: [], playlists: [] }
  let view = 'releases';
  let editing = null;     // editor abierto (lanzamiento o playlist)
  let filter = '';
  let busy = false;
  const previews = new Map();   // ruta del repositorio → URL local de lo recién subido (la web aún no lo tiene)

  /* ---------------- Sesión ---------------- */
  function readAuth() {
    for (const s of [localStorage, sessionStorage]) {
      try { const a = JSON.parse(s.getItem(AUTH_KEY) || 'null'); if (a?.token && a.user) return a; } catch { /* almacenamiento bloqueado */ }
    }
    return null;
  }
  function saveAuth(a, remember) {
    clearAuth();
    try { (remember ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(a)); } catch { /* sólo para esta pestaña */ }
  }
  function clearAuth() { for (const s of [localStorage, sessionStorage]) { try { s.removeItem(AUTH_KEY); } catch { /* nada */ } } }

  /* ---------------- Servidor (Cloudflare) ---------------- */
  class GhError extends Error { constructor(msg, status = 0) { super(msg); this.status = status; } }
  const P = p => p;   // rutas de la web (assets/…) tal cual
  /* Sus errores ya vienen explicados ({ message }). */
  async function api(method, path, body) {
    let res;
    const form = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      res = await fetch(CFG.api + path, {
        method, cache: 'no-store',
        headers: { ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
      });
    } catch { throw new GhError('No connection to the server. Check your connection and try again.'); }
    const j = await res.json().catch(() => ({}));
    if (res.ok) return j;
    throw new GhError(j.message || `Server error (${res.status}).`, res.status);
  }
  /* Permisos del rol (el servidor los vuelve a comprobar en cada cambio) */
  // «Probar rol» (owners en /admin): el panel se ve con los permisos de ese rol y no se puede guardar nada
  let preview = null;   // { id, name, perms }
  const can = (sec, act = 'view') => preview ? !!preview.perms?.[sec]?.[act] : !!(auth?.user?.owner || auth?.user?.perms?.[sec]?.[act]);

  async function loadRepo() {
    const d = await api('GET', '/api/data');
    const files = new Map();
    for (const [name, f] of Object.entries(d.files || {})) files.set('assets/' + name, { sha: String(f.v), size: f.size });
    return { head: d.version, files, releases: d.releases || [], mixtapes: d.mixtapes || [], playlists: d.playlists || [], ignore: d.ignore || [] };
  }

  /* Un «Publicar» = un cambio en el servidor. Las listas se recalculan sobre la versión más reciente
     (si alguien publicó a la vez, se reintenta sin pisar su cambio). Sale en la web al momento. */
  async function publish(message, uploads, build) {
    if (preview) throw new Error(`You are testing the role ${preview.name}: changes are not saved. Leave the test to publish.`);
    for (let attempt = 0; ; attempt++) {
      const fresh = await loadRepo();
      const out = build ? build(fresh) : {};
      const lists = {};
      for (const k of ['releases', 'mixtapes', 'playlists', 'ignore']) if (out[k]) lists[k] = out[k];
      const remove = [...new Set(out.remove || [])].filter(p => fresh.files.has(p) && !uploads.some(u => u.path === p)).map(p => p.replace(/^assets\//, ''));
      const form = new FormData();
      form.append('meta', JSON.stringify({ base: fresh.head, message, lists, remove }));
      for (const u of uploads) form.append('file:' + u.path.replace(/^assets\//, ''), u.blob, u.path.split('/').pop());
      let res;
      try { res = await api('POST', '/api/publish', form); }
      catch (e) { if (e.status === 409 && attempt < 3) continue; throw e; }
      if (res.unchanged) { repo = fresh; return { out, unchanged: true }; }
      for (const m of uploads) { const old = previews.get(m.path); if (old) URL.revokeObjectURL(old); previews.set(m.path, URL.createObjectURL(m.blob)); }
      try { repo = await loadRepo(); } catch { repo = { ...fresh, releases: out.releases || fresh.releases, mixtapes: out.mixtapes || fresh.mixtapes, playlists: out.playlists || fresh.playlists }; }
      return { out, made: uploads };
    }
  }

  /* ---------------- ¿Ya está en la web? ---------------- */
  let watchTimer = 0, watchId = 0;
  function watchSite(probes) {
    clearTimeout(watchTimer);
    const id = ++watchId, start = Date.now();
    deploy('Publishing to the site…', 'busy');
    const tick = async () => {
      if (id !== watchId) return;
      let ok = true;
      for (const p of probes) {
        try {
          const res = await fetch(`${SITE}${p.url}?hz=${Date.now()}`, { cache: 'no-store' });
          ok = res.ok && await p.test(res);
        } catch { ok = false; }
        if (!ok) break;
      }
      if (id !== watchId) return;
      if (ok) { deploy('✓ Live on the site', 'ok'); watchTimer = setTimeout(() => id === watchId && deploy(), 5000); return; }
      if (Date.now() - start > 2 * 60e3) { deploy('The change isn’t visible yet. Reload the site in a moment.', 'warn'); watchTimer = setTimeout(() => id === watchId && deploy(), 15000); return; }
      watchTimer = setTimeout(tick, 2000);
    };
    watchTimer = setTimeout(tick, 400);
  }
  const jsonProbe = (name, data) => ({ url: name, test: async res => { try { return JSON.stringify(await res.json()) === JSON.stringify(data); } catch { return false; } } });
  const fileProbe = (file, blob) => ({ url: `assets/${encodeURIComponent(file)}`, test: async res => (await res.blob()).size === blob.size });
  function deploy(text, kind) {
    const el = $('#deploy');
    if (!text) { el.hidden = true; return; }
    el.hidden = false; el.className = `deploy is-${kind}`; el.textContent = text;
  }

  /* ---------------- Avisos ---------------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false; el.classList.remove('is-out');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.add('is-out'); toastTimer = setTimeout(() => { el.hidden = true; }, 250); }, 3200);
  }
  function confirmBox(msg, okLabel = 'Delete') {
    const d = $('#confirm');
    $('#confirm-msg').textContent = msg; $('#confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.showModal();
    // se responde al pulsar el botón (y con Esc, al cerrarse); una sola vez
    return new Promise(res => {
      let done = false; const end = v => { if (!done) { done = true; res(v); } };
      d.querySelector('form').addEventListener('submit', e => end(e.submitter?.value === 'ok'), { once: true });
      d.addEventListener('close', () => end(d.returnValue === 'ok'), { once: true });
    });
  }

  /* ---------------- Utilidades de datos ---------------- */
  const catOf = r => String(r?.catalog ?? r?.catalog_number ?? '');
  const keyOf = r => String(r?.id || catOf(r) || r?.title || '');
  const normCat = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  function hex6(c) {
    c = String(c || '').trim();
    if (!HEX.test(c)) return null;
    if (c.length === 4) c = '#' + [...c.slice(1)].map(x => x + x).join('');
    return c.toLowerCase();
  }
  function nextCatalog(list) {
    let best = null;
    for (const r of list) {
      const m = catOf(r).match(/^(.*?)(\d+)\s*$/);
      if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1], n: Number(m[2]), width: m[2].length };
    }
    if (!best) return 'HRZ#001';
    return best.prefix + String(best.n + 1).padStart(best.width, '0');
  }
  const safeFile = f => typeof f === 'string' && /^[\w.-]+$/.test(f) && !f.startsWith('.');
  function assetSrc(file) {
    if (!safeFile(file)) return '';
    const path = P('assets/' + file);
    if (previews.has(path)) return previews.get(path);
    const sha = repo?.files.get(path)?.sha;
    return `${SITE}assets/${encodeURIComponent(file)}${sha ? `?v=${sha.slice(0, 8)}` : ''}`;
  }
  const imgTag = (file, cls, alt = '') => file && safeFile(file)
    ? `<img class="${cls}" src="${esc(assetSrc(file))}" data-repo="${esc(P('assets/' + file))}" alt="${esc(alt)}" loading="lazy" decoding="async">`
    : `<span class="${cls} ph" aria-hidden="true"></span>`;
  function uniqueName(base, ext) {
    const taken = p => repo.files.has(P('assets/' + p)) || [...previews.keys()].includes(P('assets/' + p));
    let name = `${base}.${ext}`;
    if (taken(name)) name = `${base}-${Date.now().toString(36)}.${ext}`;
    return name;
  }
  function accent() {
    // el panel va en blanco y gris (legible); el color de cada release solo se ve en sus muestras de color
    const c = '#ffffff';
    const n = parseInt(c.slice(1), 16);
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent-rgb', `${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}`);
  }

  /* Imagen que no carga: se marca (el panel sigue funcionando) */
  document.addEventListener('error', e => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.repo) img.classList.add('is-broken');
  }, true);

  /* ---------------- Imágenes ---------------- */
  async function decodeImage(blob) {
    if (window.createImageBitmap) { try { return await createImageBitmap(blob); } catch { /* probar con <img> */ } }
    const img = new Image(); img.src = URL.createObjectURL(blob);
    try { await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(img.src), 0); }
  }
  /* Recorte cuadrado centrado a n px, reducido en pasos de mitad en mitad (sin dientes de sierra). */
  function square(src, w, h, n) {
    const side = Math.min(w, h);
    let from = src, sx = (w - side) / 2, sy = (h - side) / 2, size = side;
    while (size > n * 2) {
      const half = Math.round(size / 2), c = document.createElement('canvas');
      c.width = c.height = half;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(from, sx, sy, size, size, 0, 0, half, half);
      from = c; sx = sy = 0; size = half;
    }
    const out = document.createElement('canvas');
    out.width = out.height = Math.min(n, side);
    const x = out.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.fillStyle = '#000'; x.fillRect(0, 0, out.width, out.height);   // PNG con transparencia → fondo negro, no gris
    x.drawImage(from, sx, sy, size, size, 0, 0, out.width, out.height);
    return out;
  }
  /* Color de acento sugerido: el tono más presente entre los colores vivos de la portada. */
  function pickColor(canvas) {
    const s = 48, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(canvas, 0, 0, s, s);
    const d = x.getImageData(0, 0, s, s).data, bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let light = { w: 0, r: 0, g: 0, b: 0 };
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, sat = mx ? (mx - mn) / mx : 0;
      if (v > .55) { const w = v * v; light.w += w; light.r += r * w; light.g += g * w; light.b += b * w; }
      if (v < .18 || sat < .25) continue;
      let hue = 0;
      if (mx !== mn) hue = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      const bin = bins[Math.floor(hue * 4) % 24], w = sat * sat * v;
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    const scored = bins.map((b, i) => ({ i, w: b.w + bins[(i + 23) % 24].w * .5 + bins[(i + 1) % 24].w * .5 }));
    const top = scored.sort((a, b) => b.w - a.w)[0];
    let pick = top.w > s * s * .015 ? bins[top.i] : light.w ? light : { w: 1, r: 1, g: 1, b: 1 };
    if (!pick.w) pick = light.w ? light : { w: 1, r: 1, g: 1, b: 1 };
    let [r, g, b] = [pick.r / pick.w, pick.g / pick.w, pick.b / pick.w];
    // Que se lea sobre el negro de la web: subir el brillo si el tono es oscuro
    const mx = Math.max(r, g, b);
    if (mx > 0 && mx < .82) { const k = .82 / mx; r *= k; g *= k; b *= k; }
    return '#' + [r, g, b].map(v => Math.round(Math.min(1, v) * 255).toString(16).padStart(2, '0')).join('');
  }
  async function processCover(file, n) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG or WebP image.');
    if (file.size > MAX_IMAGE_IN) throw new Error('The image is too big (max 30 MB).');
    const img = await decodeImage(file).catch(() => null);
    const w = img?.width || img?.naturalWidth, h = img?.height || img?.naturalHeight;
    if (!w || !h) throw new Error('Could not read the image. Try another file.');
    const canvas = square(img, w, h, n);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .9));
    if (!blob) throw new Error('Could not prepare the image.');
    return { blob, url: URL.createObjectURL(blob), w, h, color: pickColor(canvas), small: Math.min(w, h) < n };
  }

  /* ---------------- Validación ---------------- */
  class FieldError extends Error { constructor(field, msg) { super(msg); this.field = field; } }
  function text(form, name, label, { max = 120, missing = '' } = {}) {
    const v = String(form.elements[name]?.value ?? '').replace(/\s+/g, ' ').trim();
    if (missing && !v) throw new FieldError(name, missing);
    if (/[<>]/.test(v)) throw new FieldError(name, `${label}: don’t use the characters < ni > (the site reads them as code).`);
    if (v.length > max) throw new FieldError(name, `${label}: maximum ${max} characters.`);
    return v;
  }
  const HOSTS = {
    spotify: [/^open\.spotify\.com$/, /^spotify\.link$/],
    soundcloud: [/^(www\.|m\.)?soundcloud\.com$/, /^on\.soundcloud\.com$/, /^snd\.sc$/],
    youtube: [/^(www\.|m\.|music\.)?youtube\.com$/, /^youtu\.be$/],
  };
  function link(form, name, label, hosts, missing = '') {
    const v = String(form.elements[name]?.value ?? '').trim();
    if (!v) { if (missing) throw new FieldError(name, missing); return ''; }
    let u;
    try { u = new URL(v); } catch { throw new FieldError(name, `${label}: not a valid link.`); }
    if (u.protocol !== 'https:') throw new FieldError(name, `${label}: debe empezar por https://`);
    if (/["'<>\s\\`]/.test(v)) throw new FieldError(name, `${label}: the link has invalid characters.`);
    if (hosts && !hosts.some(h => h.test(u.hostname))) throw new FieldError(name, `${label}: doesn’t look like a ${label} link.`);
    return v;
  }
  function position(form, max) {
    const n = Number(form.elements.position?.value);
    if (!Number.isInteger(n) || n < 1) throw new FieldError('position', 'Position: enter a number from 1.');
    return Math.min(n, max);
  }
  function showError(err) {
    const box = $('#ed-error');
    $$('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    if (!box) { toast(err.message); return; }
    box.textContent = err.message; box.hidden = false;
    if (err.field) {
      const el = $(`[name="${err.field}"]`);
      if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    } else box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (err.status === 401) logout(err.message);
  }

  /* ---------------- Pantallas ---------------- */
  /* Login con Google (botón oficial de Google Identity Services) */
  let gisLoad = null, serverCfg = null;
  function loadGis() {
    if (!gisLoad) gisLoad = new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = ok;
      s.onerror = () => { gisLoad = null; ko(new Error('Could not load the Google button. Check your connection or disable the ad blocker on this page.')); };
      document.head.appendChild(s);
    });
    return gisLoad;
  }
  function loginError(msg) {
    const el = $('.login-error');
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
  }
  async function loginView(message = '') {
    document.title = MODE === 'team' ? 'Team — HORIZON RCRDS' : 'Panel — HORIZON RCRDS';
    app.innerHTML = `
      <main class="login">
        <div class="login-card">
          <img class="login-logo" src="${SITE}assets/logo.png" alt="">
          <h1>HORIZON <span>RCRDS</span></h1>
          <p class="login-sub">${MODE === 'team' ? 'Team' : 'Panel · Owners'}</p>
          <p class="login-text">${MODE === 'team' ? 'Sign in with the Google account or the email you were added to the team with.' : 'Owners only. Sign in with your Google account or your email.'}</p>
          <div id="g-btn" class="g-btn"></div>
          <form id="mail-login" class="mail-login" novalidate>
            <p class="login-or"><span>or sign in with email</span></p>
            <div class="field"><label for="ml-email" class="sr-only">Email</label><input id="ml-email" name="email" type="email" autocomplete="email" spellcheck="false" placeholder="Your email (Outlook, iCloud…)"></div>
            <div class="field" id="ml-code-f" hidden><label for="ml-code">Code from the email</label><input id="ml-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits"></div>
            <p class="ml-info" id="ml-info" hidden></p>
            <button class="btn ghost wide" type="submit" id="ml-btn">Email me a code</button>
          </form>
          <form id="dev-login" class="dev-login" hidden novalidate>
            <div class="field"><label for="dev-email">Local test · email</label><input id="dev-email" name="email" type="email" autocomplete="off" spellcheck="false"></div>
            <button class="btn ghost wide" type="submit">Entrar (prueba local)</button>
          </form>
          <label class="check"><input type="checkbox" id="remember" checked><span>Remember on this browser</span></label>
          <p class="login-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
        </div>
      </main>`;
    try {
      serverCfg = serverCfg || await api('GET', '/api/auth/config');
      if (serverCfg.dev) $('#dev-login').hidden = false;
      if (serverCfg.clientId) {
        await loadGis();
        if (!$('#g-btn')) return;
        google.accounts.id.initialize({ client_id: serverCfg.clientId, callback: r => login({ credential: r.credential }), auto_select: false, cancel_on_tap_outside: true });
        google.accounts.id.renderButton($('#g-btn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'en', width: 280 });
      } else if (!serverCfg.dev) throw new Error('The panel is not set up yet: the Google client ID is missing on the server.');
    } catch (e) { serverCfg = null; loginError(e.message); }
  }

  const VIEWS = ['releases', 'radio', 'playlists', 'player'];
  // secciones en el orden que eligen los owners
  const ORDER = () => (auth?.sections || []).map(x => x.id).concat(['releases', 'radio', 'playlists', 'player', 'forms', 'contracts', 'calendar']).filter((v, i, a) => a.indexOf(v) === i);
  const canTab = v => v === 'forms' ? showForms() : can(v);
  const firstView = () => ORDER().find(canTab) || (showForms() ? 'forms' : MODE === 'admin' && auth?.user?.owner && !preview ? 'team' : 'none');
  const emptyRepo = () => ({ head: '', treeSha: '', files: new Map(), truncated: false, releases: [], mixtapes: [], playlists: [], ignore: [] });
  function useSession(res) {
    auth = { token: res.token || auth?.token, user: res.user, sections: res.sections };
    checkUnseen();   // el aviso de respuestas nuevas se pide ya, a la vez que se carga el resto
  }
  async function login(cred) {
    const card = $('.login-card'), remember = $('#remember')?.checked !== false;
    loginError(''); card?.setAttribute('aria-busy', 'true');
    try {
      const res = cred.code ? await api('POST', '/api/auth/email/verify', { email: cred.mail, code: cred.code, area: MODE })
        : await api('POST', cred.email ? '/api/auth/dev' : '/api/auth/login', cred.email ? { email: cred.email, area: MODE } : { credential: cred.credential, area: MODE });
      useSession(res);
      repo = firstView() === 'none' ? emptyRepo() : await loadRepo();
      saveAuth(auth, remember);
      go(firstView());
    } catch (e) {
      if (auth?.token) api('POST', '/api/auth/logout').catch(() => {});
      auth = null; repo = null;
      loginError(e.message); card?.removeAttribute('aria-busy');
    }
  }
  function logout(message = '') {
    if (auth?.token) api('POST', '/api/auth/logout').catch(() => {});
    try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* nada */ }
    chatStop();
    preview = null;
    clearAuth(); auth = null; repo = null; editing = null; setDirtyBase(null); teamData = null; teamErr = '';
    watchId++; deploy();
    loginView(message);
  }

  function shell(inner) {
    const tab = (id, label) => `<button type="button" class="tab${view === id || (editing && editing.view === id) ? ' is-on' : ''}" data-view="${id}">${label}${id === 'forms' ? (() => { const n = badgeCount(); return `<span class="nbadge" id="forms-badge" ${n ? '' : 'hidden'}><span class="nb-n${n === 1 ? ' one' : ''}">${n > 99 ? '99+' : n}</span></span>`; })() : ''}${id === 'contracts' ? (() => { if (!ctPolled) { ctPolled = true; setTimeout(checkContracts, 0); } const n = ctBadgeCount(); return `<span class="nbadge" id="ct-badge" ${n ? '' : 'hidden'}><span class="nb-n${n === 1 ? ' one' : ''}">${n > 99 ? '99+' : n}</span></span>`; })() : ''}</button>`;
    const u = auth.user, names = { releases: 'Releases', radio: 'Mixtapes', playlists: 'Playlists', player: 'Player', forms: 'Forms', contracts: 'Contracts', calendar: 'Calendar' };
    const initials = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');
    return `
      <header class="top">
        <a class="brand" href="${SITE}" target="_blank" rel="noopener" aria-label="Open the site">
          <img src="${SITE}assets/logo.png" alt="">
          <span class="word">HORIZON<small>RCRDS</small></span>
        </a>
        <nav class="tabs" aria-label="Sections">
          ${ORDER().filter(canTab).map(v => tab(v, names[v])).join('')}${MODE === 'admin' && u.owner && !preview ? tab('team', 'Team') + tab('log', 'History') : ''}
        </nav>
        <div class="top-end">
          <span class="who" title="${esc(u.email)}">
            <button type="button" class="who-pic" data-act="me" title="Your profile" aria-label="Your profile" style="--c:${esc(u.color || '#ffffff')}">${u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="who-ini">${esc(initials)}</span>`}<span class="who-cam" aria-hidden="true">✎</span></button>
            <span class="who-txt"><b>${esc(u.name || u.email.split('@')[0])}</b><small>${esc(preview ? 'Testing: ' + preview.name : u.owner ? 'Owner' : u.role?.name || 'No role')}</small></span>
          </span>
          <a class="link" href="${SITE}" target="_blank" rel="noopener">View site ↗</a>
          <button type="button" class="link" data-act="logout">Sign out</button>
        </div>
      </header>
      <main id="main" class="main" tabindex="-1">${preview ? `<div class="preview-bar" role="status"><span>You are viewing the panel as <b>${esc(preview.name)}</b>. Changes are not saved.</span><button type="button" class="btn primary sm" data-act="preview-off">Leave test</button></div>` : ''}${inner}</main>`;
  }
  function noAccessView() {
    return `<div class="head"><div><p class="eyebrow">Team</p><h1>NO SECTIONS</h1></div></div>
      <p class="info">Your role (${esc(preview ? preview.name : auth.user.role?.name || 'no role')}) has no sections yet. When an owner gives you access, sign out and back in.</p>`;
  }

  /* ---------------- Equipo y roles (solo owners, en /admin) ---------------- */
  let teamData = null, teamErr = '', teamLoading = false;
  const ACTIONS = { view: 'View', edit: 'Edit', delete: 'Delete' };
  const fmtDate = t => t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
  async function loadTeam() {
    if (teamLoading) return;
    teamLoading = true;
    try {
      teamData = await api('GET', '/api/team'); teamErr = '';
    } catch (e) {
      teamErr = e.message;
      if (e.status === 401) { teamLoading = false; logout(e.message); return; }
    }
    teamLoading = false;
    if (view === 'team' && !editing) render();
  }
  /* Ventana (para añadir/editar personas y roles): así la página del equipo queda limpia */
  function sheet(html) {
    let d = $('#sheet');
    if (!d) { d = document.createElement('dialog'); d.id = 'sheet'; d.className = 'confirm sheet'; document.body.appendChild(d); d.addEventListener('click', e => { if (e.target === d) d.close(); }); }
    d.innerHTML = html;
    if (!d.open) d.showModal();
    d.querySelector('input:not([type=hidden]):not([type=color]), select')?.focus();
    return d;
  }
  const closeSheet = () => { const d = $('#sheet'); if (d?.open) d.close(); };
  const LEVELS = [['', 'None'], ['view', 'View'], ['edit', 'Edit']];
  const levelOf = (r, sec) => r.perms?.[sec.id]?.edit || r.perms?.[sec.id]?.delete ? 'edit' : r.perms?.[sec.id]?.view ? 'view' : '';
  function roleSummary(r) {
    const n = teamData.sections.filter(sec => levelOf(r, sec)).length;
    return n ? `${n} ${n === 1 ? 'section' : 'sections'}` : 'No sections';
  }
  // Forms en un rol: cada formulario con su nivel (None / View / Edit)
  const FORM_LEVELS = [['', 'None'], ['view', 'View'], ['edit', 'Edit']];
  function roleFormLevel(r, f) {
    const m = r.forms, base = r.perms?.forms?.edit ? 'edit' : r.perms?.forms?.view ? 'view' : '';
    if (!r.id) return ''; // rol nuevo: todos en None
    if (Array.isArray(m)) return m.includes(f.id) ? base : '';
    if (m && typeof m === 'object') return m[f.id] || '';
    return base;
  }
  function roleFormRows(r) {
    if (!formsData) return '<p class="muted sm-txt pf-wait">Loading forms…</p>';
    if (!formsData.forms.length) return '<p class="muted sm-txt">No forms yet.</p>';
    return formsData.forms.map(f => { const lv = roleFormLevel(r, f); return `
      <div class="perm-row pf-row" data-form="${esc(f.id)}"><span class="pf-name">${esc(f.title)}</span><span class="seg" role="radiogroup" aria-label="${esc(f.title)}">${FORM_LEVELS.map(([v, l]) => `
        <label><input type="radio" name="form:${esc(f.id)}" value="${v}" ${v === lv ? 'checked' : ''}><span>${l}</span></label>`).join('')}</span></div>`; }).join('');
  }
  // resumen en la fila «Forms» (la lista está plegada hasta que se pulsa)
  function roleFormsSummary(r) {
    if (!formsData) return 'Show forms';
    const n = formsData.forms.filter(f => roleFormLevel(r, f)).length;
    return n ? `${n} of ${formsData.forms.length} forms` : 'No forms';
  }
  function roleFormsPick(r) {
    if (!formsData) loadForms().then(() => { const box = $('#sheet .role-form .perm-forms'), sum = $('#sheet .role-form .pf-count'); if (box) box.innerHTML = roleFormRows(r); if (sum) sum.textContent = roleFormsSummary(r); });
    return `<div class="perm-forms" hidden>${roleFormRows(r)}</div>`;
  }
  function roleSheet(r) {
    const isNew = !r.id;
    return sheet(`
      <form class="role-form" data-role="${esc(r.id || '')}" novalidate>
        <div class="sheet-head"><h2>${isNew ? 'New role' : 'Edit role'}</h2><button type="button" class="ic" data-act="sheet-close" aria-label="Close">✕</button></div>
        <input name="name" class="role-name" value="${esc(r.name || '')}" maxlength="40" placeholder="Role name (e.g. A&R)" aria-label="Role name" autocomplete="off">
        <div class="perm-list">${teamData.sections.map(sec => { const lv = levelOf(r, sec); return `
          ${sec.id === 'forms' ? `<div class="perm-row pf-head" data-sec="forms"><span class="perm-name"><button type="button" class="grip" aria-label="Drag to reorder ${esc(sec.label)}" title="Drag to reorder">${GRIP_SVG}</button>${esc(sec.label)}<button type="button" class="pf-arrow" data-act="pf-toggle" aria-expanded="false" aria-label="Choose which forms" title="Choose which forms"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg></button><span class="pf-count muted sm-txt">${roleFormsSummary(r)}</span></span><span class="seg" role="radiogroup" aria-label="${esc(sec.label)}">${LEVELS.map(([v, l]) => `
            <label><input type="radio" name="forms" value="${v}" ${v === lv ? 'checked' : ''}><span>${l}</span></label>`).join('')}</span></div>${roleFormsPick(r)}` : `<div class="perm-row" data-sec="${esc(sec.id)}"><span class="perm-name"><button type="button" class="grip" aria-label="Drag to reorder ${esc(sec.label)}" title="Drag to reorder">${GRIP_SVG}</button>${esc(sec.label)}</span><span class="seg" role="radiogroup" aria-label="${esc(sec.label)}">${LEVELS.filter(([v]) => !v || sec.actions.includes(v)).map(([v, l]) => `
            <label><input type="radio" name="${esc(sec.id)}" value="${v}" ${v === lv ? 'checked' : ''}><span>${l}</span></label>`).join('')}</span></div>`}`; }).join('')}
        </div>
        <p class="info sm-txt"><b>View</b>: only look. <b>Edit</b>: create, change and delete. For Forms, use the arrow to choose which forms and what they can do in each. Drag ⋮⋮ to change the order of the sections. Owners always have everything.</p>
        <p class="ed-error" role="alert" hidden></p>
        <div class="confirm-actions">${isNew ? '' : '<button type="button" class="btn danger push-l" data-act="delete-role">Delete role</button>'}<button type="submit" class="btn primary">${isNew ? 'Create role' : 'Save'}</button></div>
      </form>`);
  }
  function memberSheet(m) {
    const roles = teamData.roles, isNew = !m;
    m = m || { email: '', label: '', color: '#4fc3f7', role_id: roles[0]?.id };
    return sheet(`
      <form class="member-form" data-email="${esc(m.email)}" novalidate>
        <div class="sheet-head"><h2>${isNew ? 'Add person' : esc(m.label || m.name || m.email)}</h2><button type="button" class="ic" data-act="sheet-close" aria-label="Close">✕</button></div>
        ${isNew ? `<div class="field"><label for="m-email">Google email</label><input id="m-email" name="email" type="email" autocomplete="off" spellcheck="false" placeholder="name@gmail.com"></div>` : `<p class="muted sm-txt">${esc(m.email)}</p>`}
        <div class="m-grid">
          <div class="field"><label for="m-label">Name</label><input id="m-label" name="label" value="${esc(m.label || '')}" maxlength="40" placeholder="${esc(m.name || 'e.g. Kris m')}" autocomplete="off"></div>
          <div class="field"><label for="m-color">Colour</label><label class="color-dot big" style="--c:${esc(m.color || '#ffffff')}"><input id="m-color" type="color" name="color" value="${esc(m.color || '#ffffff')}"></label></div>
        </div>
        <div class="field"><label for="m-sc">SoundCloud profile</label><input id="m-sc" name="soundcloud" value="${esc(m.soundcloud || '')}" placeholder="https://soundcloud.com/name" autocomplete="off" spellcheck="false"><p class="info sm-txt">Their photo is taken from SoundCloud and updates by itself when they change it.</p></div>
        <div class="field"><label for="m-role">Role</label>${roles.length ? `<select id="m-role" name="role_id">${roles.map(r => `<option value="${esc(r.id)}" ${r.id === m.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : '<p class="info">Create a role first.</p>'}</div>
        <p class="ed-error" role="alert" hidden></p>
        <div class="confirm-actions">${isNew ? '' : '<button type="button" class="btn danger push-l" data-act="remove-member">Remove from team</button>'}<button type="submit" class="btn primary" ${roles.length ? '' : 'disabled'}>${isNew ? 'Add' : 'Save'}</button></div>
      </form>`);
  }
  // tu perfil: foto y color (cada uno el suyo)
  const SWATCHES = ['#ffffff', '#ff5a5f', '#ff9f1c', '#ffd23f', '#3ddc84', '#2ec4b6', '#4fc3f7', '#5b7cfa', '#b388ff', '#ff6ec7'];
  function meSheet() {
    const u = auth.user, col = u.color || '#ffffff', nm = u.name || u.email.split('@')[0];
    return sheet(`
      <div class="me-form">
        <div class="sheet-head"><h2>Your profile</h2><button type="button" class="ic" data-act="sheet-close" aria-label="Close">✕</button></div>
        <div class="me-top">${avatar(u.picture, nm, col).replace('class="av"', 'class="av xl"')}
          <div><b class="me-name" style="color:${esc(col)}">${esc(nm)}</b><span class="muted sm-txt">${esc(u.email)}</span>
            ${!u.owner ? '' : `<div class="me-btns"><label class="btn ghost sm" for="me-photo">${u.picture ? 'Change photo' : 'Upload photo'}</label><input type="file" id="me-photo" accept="image/*" class="sr-only">${u.picture ? '<button type="button" class="btn ghost sm" data-act="me-nophoto">Remove</button>' : ''}</div>`}</div></div>
        ${u.owner ? `<p class="mini">SoundCloud</p>
        <form class="me-sc" id="me-sc" novalidate><input name="url" value="${esc(u.soundcloud || '')}" placeholder="https://soundcloud.com/your-name" aria-label="Your SoundCloud profile" autocomplete="off" spellcheck="false"><button type="submit" class="btn ghost sm">Save</button></form>
        <p class="info sm-txt">Your photo is taken from your SoundCloud profile and updates by itself when you change it there.</p>` : u.soundcloud ? '<p class="info sm-txt">Your photo comes from your SoundCloud profile and updates by itself.</p>' : ''}
        <p class="mini">Your colour</p>
        <div class="swatches">${SWATCHES.map(c => `<button type="button" class="sw${c === col ? ' on' : ''}" data-act="me-color" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}
          <label class="sw custom${SWATCHES.includes(col) ? '' : ' on'}" style="--c:${esc(col)}" title="Custom colour"><input type="color" id="me-color" value="${esc(col)}"><span>+</span></label></div>
        <p class="info sm-txt">Your name shows in this colour in the team, the chat and the history.</p>
      </div>`);
  }
  async function setMyColor(c) {
    try {
      const r = await api('POST', '/api/me/color', { color: c });
      auth.user.color = r.color; saveMe({ color: r.color });
      teamData = null; render(); meSheet(); toast('Colour saved');
    } catch (e) { toast(e.message); }
  }
  function saveMe(patch) {
    for (const st of [localStorage, sessionStorage]) { try { const saved = JSON.parse(st.getItem(AUTH_KEY) || 'null'); if (saved?.user) { Object.assign(saved.user, patch); st.setItem(AUTH_KEY, JSON.stringify(saved)); } } catch { /* nada */ } }
  }
  const avatar = (pic, name, color) => pic
    ? `<img class="av" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="av" style="--c:${esc(color || '#ffffff')}">${esc((name || '?')[0].toUpperCase())}</span>`;
  function teamView() {
    const head = `<div class="head"><div><p class="eyebrow">Access</p><h1>TEAM${teamData ? ` <span class="count">${teamData.owners.length + teamData.members.length}</span>` : ''}</h1></div>
      ${teamData ? '<div class="head-btns"><button type="button" class="btn ghost" data-act="add-member">+ Add person</button></div>' : ''}</div>`;
    if (!teamData) {
      if (!teamErr) setTimeout(loadTeam, 0);
      return head + (teamErr ? `<p class="login-error" role="alert">${esc(teamErr)}</p><button type="button" class="btn ghost" data-act="team-retry">Retry</button>` : '<p class="info">Loading…</p>');
    }
    const { owners, members, roles } = teamData, pics = teamData.ownerPics || {};
    const roleOf = m => roles.find(r => r.id === m.role_id);
    return `${head}
      <ol class="list team-list">
        ${owners.map(e => { const me = e === auth.user.email; const nm = me ? auth.user.name || e.split('@')[0] : e.split('@')[0], oc = (teamData.ownerColors || {})[e] || '#ffffff'; return `<li class="row tm">
            ${avatar(me ? auth.user.picture : pics[e], nm, oc)}
            <span class="meta"><b style="color:${esc(oc)}">${esc(nm)}</b><span>${esc(e)}</span></span>
            <span class="role-tag owner">Owner</span><span></span></li>`; }).join('')}
        ${members.map(m => { const r = roleOf(m), nm = m.label || m.name || m.email.split('@')[0]; return `
          <li class="row tm" data-email="${esc(m.email)}">
            ${avatar(m.picture, nm, m.color)}
            <span class="meta"><b style="color:${esc(m.color || '#ffffff')}">${esc(nm)}</b><span>${esc(m.email)}${m.last_login ? ' · signed in ' + esc(fmtDate(m.last_login)) : ' · never signed in'}</span></span>
            <span class="role-tag" style="--c:${esc(m.color || '#ffffff')}">${esc(r?.name || 'No role')}</span>
            <button type="button" class="btn ghost sm" data-act="edit-member">Edit</button>
          </li>`; }).join('')}
      </ol>

      <div class="head sub"><div><p class="eyebrow">Permissions</p><h2>ROLES <span class="count">${roles.length}</span></h2></div>
        <div class="head-btns"><button type="button" class="btn ghost" data-act="new-role">+ New role</button></div></div>
      <div class="roles">${roles.map(r => { const n = members.filter(m => m.role_id === r.id).length; return `
        <div class="role-line" data-role="${esc(r.id)}">
          <b>${esc(r.name)}</b>
          <span class="muted sm-txt">${roleSummary(r)} · ${n} ${n === 1 ? 'person' : 'people'}</span>
          <span class="role-btns"><button type="button" class="btn ghost sm" data-act="preview-role" title="View the panel as this role">Test</button><button type="button" class="btn ghost sm" data-act="open-role">Edit</button></span>
        </div>`; }).join('')}${!roles.length ? '<p class="info">No roles yet.</p>' : ''}</div>`;
  }
  /* ---------------- Historial (solo owners) ---------------- */
  const logState = { who: '', items: [], more: false, people: [], loading: false, err: '', loaded: false };
  async function loadLog(more) {
    if (logState.loading) return;
    logState.loading = true;
    try {
      const last = more && logState.items.length ? logState.items[logState.items.length - 1].id : '';
      const r = await api('GET', `/api/team/audit?email=${encodeURIComponent(logState.who)}${last ? '&before=' + last : ''}`);
      logState.items = more ? logState.items.concat(r.items) : r.items;
      logState.more = r.more; logState.people = r.people; logState.err = ''; logState.loaded = true;
    } catch (e) {
      if (e.status === 401) { logState.loading = false; logout(e.message); return; }
      logState.err = e.message;
    }
    logState.loading = false;
    if (view === 'log') render();
  }
  function logView() {
    if (!logState.loaded && !logState.err && !logState.loading) setTimeout(() => loadLog(false), 0);
    const opts = logState.people.slice().sort((a, b) => (b.owner ? 1 : 0) - (a.owner ? 1 : 0) || (a.name || a.email).localeCompare(b.name || b.email))
      .map(p => `<option value="${esc(p.email)}" ${p.email === logState.who ? 'selected' : ''}>${esc((p.name || p.email.split('@')[0]) + (p.owner ? ' (owner)' : '') + ' · ' + p.email)}</option>`).join('');
    let day = '';
    const rows = logState.items.map(x => {
      const d = new Date(x.at), k = d.toDateString();
      const head = k !== day ? `<li class="log-day">${esc(d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</li>` : '';
      day = k;
      const kind = /^(Entró|Signed in)/.test(x.action) ? 'in' : /(Añadió|Quitó|rol|Added|Removed|role)/.test(x.action) ? 'team' : 'web';
      return `${head}<li class="row lg ${kind}"><span class="muted">${esc(d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</span><b style="${x.color ? `color:${esc(x.color)}` : ''}" title="${esc(x.email)}">${esc(x.name || x.email)}</b><span>${esc(x.action)}</span></li>`;
    }).join('');
    return `<div class="head"><div><p class="eyebrow">Who did what</p><h1>HISTORY</h1></div>
        <select class="log-who" aria-label="View history of"><option value="">Whole team</option>${opts}</select></div>
      <p class="info lead">Everything that happens in the panel: who signs in, what they publish, what they delete and team changes. Only owners can see it.</p>
      ${logState.err ? `<p class="login-error" role="alert">${esc(logState.err)}</p>` : ''}
      <ol class="list log">${rows || `<li class="empty">${logState.loading || !logState.loaded ? 'Loading…' : 'Nothing yet.'}</li>`}</ol>
      ${logState.more ? `<button type="button" class="btn ghost log-more" data-act="log-more"${logState.loading ? ' disabled' : ''}>Show more</button>` : ''}`;
  }

  function rolePerms(form) {
    const perms = {}, rank = { '': 0, view: 1, edit: 2, delete: 2 }; // «Edit» incluye borrar
    for (const sec of teamData.sections) {
      const lv = rank[form.querySelector(`input[name="${sec.id}"]:checked`)?.value || ''];
      perms[sec.id] = {};
      for (const a of sec.actions) perms[sec.id][a] = lv >= rank[a];
    }
    return perms;
  }
  // tu foto de perfil: se recorta cuadrada (256 px) en el navegador y se sube
  async function setMyPhoto(file) {
    try {
      if (!/^image\//.test(file.type)) throw new GhError('Choose an image.');
      const img = await createImageBitmap(file);
      const side = Math.min(img.width, img.height), c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
      const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.88));
      const r = await (await authFetch('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob })).json();
      auth.user.picture = r.picture; saveMe({ picture: r.picture });
      toast('Photo updated'); teamData = null; render(); if ($('#sheet')?.open) meSheet();
    } catch (e) { toast(e.message); }
  }
  async function teamAction(fn, okMsg, errBox) {
    busy = true;
    try { await fn(); if (okMsg) toast(okMsg); closeSheet(); teamData = null; await loadTeam(); }
    catch (e) {
      if (e.status === 401) { logout(e.message); return; }
      if (errBox) { errBox.textContent = e.message; errBox.hidden = false; } else toast(e.message);
    } finally { busy = false; }
  }

  /* Qué enlaces tiene cada uno (encendido = puesto) */
  const CHIP = { spotify_link: 'Spotify', soundcloud_link: 'SoundCloud', youtube_link: 'YouTube', stream_link: 'Smart link' };
  const ICON = {
    spotify_link: '<circle cx="12" cy="12" r="9.5"/><path d="M7.2 9.6c3.3-.9 7-.5 9.8 1.1M7.7 12.8c2.7-.7 5.6-.4 7.9.9M8.2 15.8c2.1-.5 4.2-.3 6 .7"/>',
    soundcloud_link: '<path d="M3.5 15.5v-2M6.5 16.5v-5M9.5 16.5v-7"/><path d="M12.5 16.5V8.6a5 5 0 0 1 5.6 4 2.9 2.9 0 0 1 .4 5.9h-6"/>',
    youtube_link: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10.2 9.4v5.2l4.4-2.6z" fill="currentColor" stroke="none"/>',
    stream_link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.8.5l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/><path d="M14 10.5a4.5 4.5 0 0 0-6.8-.5l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>',
  };
  const ico = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  const linkChips = (x, keys) => `<span class="links">${keys.map(k => x[k]
    ? `<a class="lk on" href="${esc(x[k])}" target="_blank" rel="noopener" title="${CHIP[k]}" aria-label="${CHIP[k]}">${ico(k)}</a>`
    : `<span class="lk" title="No ${CHIP[k]}" aria-label="No ${CHIP[k]}">${ico(k)}</span>`).join('')}</span>`;

  /* Releases */
  function releaseRows() {
    const q = filter.trim().toLowerCase();
    const rows = repo.releases.map((r, i) => ({ r, i })).filter(({ r }) => !q || [r.title, r.artist, catOf(r)].join(' ').toLowerCase().includes(q));
    if (!rows.length) return `<li class="empty">Nothing matches “${esc(filter)}”.</li>`;
    return rows.map(({ r, i }) => `
      <li class="row item">
        <span class="pos">${i + 1}</span>
        ${imgTag(r.image, 'thumb')}
        <span class="meta"><b>${esc(r.title || 'Untitled')}</b><span>${esc(r.artist || '')}</span></span>
        <span class="cat">${esc(catOf(r))}</span>
        ${linkChips(r, ['spotify_link', 'soundcloud_link', 'youtube_link', 'stream_link'])}
        <span class="swatch" style="--c:${esc(hex6(r.color) || '#ffffff')}" title="${esc(r.color || '')}"></span>
        ${i === 0 ? '<span class="feat">Cover</span>' : '<span></span>'}
        ${can('releases', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-release" data-key="${esc(keyOf(r))}">Edit</button>` : '<span></span>'}
      </li>`).join('');
  }
  function releasesView() {
    return `
      <div class="head">
        <div><p class="eyebrow">Discography</p><h1>RELEASES <span class="count">${repo.releases.length}</span></h1></div>
        ${can('releases', 'edit') ? '<button type="button" class="btn primary" data-act="new-release">+ New release</button>' : ''}
      </div>
      <input class="search" type="search" id="rel-filter" placeholder="Search" aria-label="Search releases" value="${esc(filter)}">
      <ol class="list" id="rel-list">${releaseRows()}</ol>
      ${excludedHtml('release')}`;
  }

  function releaseEditor() {
    const r = editing.orig || {}, isNew = !editing.key, n = repo.releases.length;
    const cover = editing.cover?.url || (r.image ? assetSrc(r.image) : '');
    const color = hex6(editing.color ?? r.color) || '#ffffff';
    return `
      <form id="ed" class="editor" novalidate>
        <button type="button" class="back" data-act="back">← Releases</button>
        <h1>${isNew ? 'NEW RELEASE' : esc(r.title || 'Untitled')}</h1>
        <div class="ed-grid">
          <div class="ed-side">
            ${coverDrop(cover, r.image && !editing.cover ? P('assets/' + r.image) : '', 'Cover')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
            <div class="field">
              <label for="f-color">Colour</label>
              <div class="color-row">
                <input type="color" id="f-color-pick" value="${esc(color)}" aria-label="Pick colour">
                <input id="f-color" name="color" value="${esc(color)}" maxlength="7" spellcheck="false" autocomplete="off">
                <span class="badge-prev" id="color-prev" style="--c:${esc(color)}">${esc(catOf(r) || nextCatalog(repo.releases))}</span>
              </div>
            </div>
          </div>
          <div class="ed-main">
            <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" value="${esc(r.title || '')}" maxlength="120" autocomplete="off"></div>
            <div class="field"><label for="f-artist">Artists</label><input id="f-artist" name="artist" value="${esc(r.artist || '')}" maxlength="160" autocomplete="off"></div>
            <div class="row2">
              <div class="field"><label for="f-catalog">Catalogue no.</label><input id="f-catalog" name="catalog" value="${esc(catOf(r) || nextCatalog(repo.releases))}" maxlength="20" autocomplete="off" spellcheck="false"></div>
              <div class="field"><label for="f-position">Position</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? 1 : editing.index + 1}" inputmode="numeric"></div>
            </div>
            <p class="group">Links</p>
            <div class="field"><label for="f-stream">Stream (smart link)</label><input id="f-stream" name="stream_link" type="url" value="${esc(r.stream_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://"></div>
            <div class="field"><label for="f-spotify">Spotify</label><input id="f-spotify" name="spotify_link" type="url" value="${esc(r.spotify_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://open.spotify.com/…"></div>
            <div class="field"><label for="f-soundcloud">SoundCloud</label><input id="f-soundcloud" name="soundcloud_link" type="url" value="${esc(r.soundcloud_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://soundcloud.com/…"></div>
            <div class="field"><label for="f-youtube">YouTube</label><input id="f-youtube" name="youtube_link" type="url" value="${esc(r.youtube_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…"></div>
            <div class="field"><label for="f-desc">Description</label><textarea id="f-desc" name="description" rows="3" maxlength="400">${esc(r.description || '')}</textarea></div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publish' : 'Save changes'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancel</button>
          ${isNew || !can('releases', 'delete') ? '' : `${r.soundcloud_link ? '<button type="button" class="btn ghost push" data-act="exclude-release">Exclude</button>' : ''}<button type="button" class="btn danger${r.soundcloud_link ? '' : ' push'}" data-act="delete-release">Delete</button>`}
        </div>
      </form>`;
  }
  function coverDrop(src, repoPath, label) {
    return `
      <div class="drop" data-drop>
        <input type="file" id="ed-file" class="sr-only" accept="image/jpeg,image/png,image/webp">
        <label for="ed-file" class="drop-in">
          ${src ? `<img src="${esc(src)}" ${repoPath ? `data-repo="${esc(repoPath)}"` : ''} alt="">` : ''}
          <span class="drop-hint">${src ? 'Change ' + label.toLowerCase() : `${label}<small>Drag or click · JPG, PNG or WebP</small>`}</span>
        </label>
      </div>`;
  }
  function coverInfo() {
    const c = editing?.cover;
    if (!c) return '';
    const parts = [`${c.w}×${c.h} → ${Math.min(c.w, c.h, editing.px)}×${Math.min(c.w, c.h, editing.px)}`];
    if (c.w !== c.h) parts.push('cropped to centre');
    if (c.small) parts.push(`<span class="warn">small: ${editing.px} px or more is better</span>`);
    return parts.join(' · ');
  }

  async function saveRelease(form) {
    const isNew = !editing.key, orig = editing.orig || {};
    const v = {
      title: text(form, 'title', 'Title', { missing: 'Title missing.' }),
      artist: text(form, 'artist', 'Artistas', { max: 160, missing: 'Artists missing.' }),
      catalog: text(form, 'catalog', 'Catalogue no.', { max: 20, missing: 'Catalogue number missing.' }),
      stream_link: link(form, 'stream_link', 'Stream', null),
      spotify_link: link(form, 'spotify_link', 'Spotify', HOSTS.spotify),
      soundcloud_link: link(form, 'soundcloud_link', 'SoundCloud', HOSTS.soundcloud),
      youtube_link: link(form, 'youtube_link', 'YouTube', HOSTS.youtube),
      description: text(form, 'description', 'Description', { max: 400 }),
    };
    const color = hex6(form.elements.color.value);
    if (!color) throw new FieldError('color', 'Colour: enter a colour like #ff68b2.');
    if (!v.stream_link && !v.spotify_link && !v.soundcloud_link) throw new FieldError('stream_link', 'Add at least one link.');
    if (isNew && !editing.cover) throw new Error('Cover missing.');
    const pos = position(form, isNew ? repo.releases.length + 1 : repo.releases.length);

    const baseId = isNew ? (normCat(v.catalog) || v.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'release') : null;
    let image = orig.image;
    const uploads = [];
    if (editing.cover) {
      image = uniqueName(isNew ? baseId : (orig.id || normCat(catOf(orig)) || baseId || 'release'), 'jpg');
      uploads.push({ path: P('assets/' + image), blob: editing.cover.blob });
    }
    const build = fresh => {
      const list = fresh.releases.slice();
      const idx = isNew ? -1 : list.findIndex(r => keyOf(r) === editing.key);
      if (!isNew && idx < 0) throw new Error('This release is no longer on the site (deleted elsewhere). Go back to the list.');
      if (list.some((r, i) => i !== idx && normCat(catOf(r)) === normCat(v.catalog))) throw new FieldError('catalog', `There is already a release with no. ${v.catalog}.`);
      let entry;
      if (isNew) {
        let id = baseId, k = 2;
        while (list.some(r => r.id === id)) id = `${baseId}-${k++}`;
        entry = { id, catalog: v.catalog, artist: v.artist, title: v.title, image, color };
      } else {
        entry = { ...list[idx], artist: v.artist, title: v.title, image, color };
        if ('catalog_number' in entry && !('catalog' in entry)) entry.catalog_number = v.catalog; else entry.catalog = v.catalog;
      }
      for (const k of ['stream_link', 'spotify_link', 'soundcloud_link', 'youtube_link', 'description']) {
        if (v[k]) entry[k] = v[k]; else delete entry[k];
      }
      if (!isNew) list.splice(idx, 1);
      list.splice(Math.min(pos - 1, list.length), 0, entry);
      const old = idx >= 0 ? fresh.releases[idx].image : null;
      const remove = old && old !== image && safeFile(old) && !list.some(r => r.image === old) ? [P('assets/' + old)] : [];
      return { releases: list, remove };
    };
    const res = await publish(`${isNew ? 'Add' : 'Update'} release ${v.catalog} — ${v.title}`, uploads, build);
    afterPublish(res, isNew ? 'Release published' : 'Changes saved', [jsonProbe('releases.json', res.out.releases), ...uploads.map(u => fileProbe(image, u.blob))]);
    go('releases');
  }
  /* «Eliminar» only takes it off the site: if it is still on SoundCloud, the sync adds it again.
     «Excluir» also writes it to sync-ignore.json, so the SoundCloud sync (scripts/sync-soundcloud.mjs)
     never adds it again; «Allow again» in the Excluidos list undoes that. */
  const ignoreEntry = (fresh, item, name, kind) => item?.soundcloud_link
    ? [...fresh.ignore.filter(x => x.soundcloud_link !== item.soundcloud_link), { soundcloud_link: item.soundcloud_link, title: name, kind, removed: new Date().toISOString().slice(0, 10) }]
    : undefined;
  const ignoreKind = x => x.kind || (/mixtape/i.test(x.title || '') ? 'mixtape' : 'release');
  function excludedHtml(kind) {
    const list = (repo.ignore || []).filter(x => ignoreKind(x) === kind);
    if (!list.length) return '';
    return `
      <section class="excluded">
        <h2>Excluded <span class="count">${list.length}</span></h2>
        <ol class="list">${list.map(x => `
          <li class="row ex">
            <span class="meta"><b>${esc(x.title || x.soundcloud_link)}</b><span>${esc(x.removed ? 'Excluded on ' + x.removed : '')}</span></span>
            <a class="link" href="${esc(x.soundcloud_link)}" target="_blank" rel="noopener">SoundCloud ↗</a>
            ${can(kind === 'mixtape' ? 'radio' : 'releases', 'delete') ? `<button type="button" class="btn ghost sm" data-act="unexclude" data-link="${esc(x.soundcloud_link)}">Allow again</button>` : '<span></span>'}
          </li>`).join('')}
        </ol>
      </section>`;
  }
  async function unexclude(link) {
    const x = (repo.ignore || []).find(i => i.soundcloud_link === link);
    if (!x) return;
    if (!await confirmBox(`Allow “${x.title || link}” again? If it is still on SoundCloud, the sync will add it back to the site.`, 'Allow')) return;
    const res = await publish(`Allow again from SoundCloud — ${x.title || link}`, [], fresh => {
      const ignore = fresh.ignore.filter(i => i.soundcloud_link !== link);
      if (ignore.length === fresh.ignore.length) throw new Error('It was no longer excluded.');
      return { ignore };
    });
    if (res.unchanged) toast('Nothing to change'); else toast('Allowed again');
    render();
  }
  async function deleteRelease(exclude) {
    const r = editing.orig;
    if (repo.releases.length <= 1) throw new Error('The site needs at least one release.');
    const ask = exclude
      ? `Exclude “${r.title || catOf(r)}”? It is removed from the site and the SoundCloud sync won’t add it again (undo it in “Excluded”).`
      : `Delete “${r.title || catOf(r)}” from the site? Its cover is deleted too.${r.soundcloud_link ? ' If it is still on SoundCloud it will come back on the next sync (use “Exclude” to stop that).' : ''}`;
    if (!await confirmBox(ask, exclude ? 'Exclude' : 'Delete')) return false;
    const res = await publish(`${exclude ? 'Exclude' : 'Remove'} release ${catOf(r)} — ${r.title || ''}`, [], fresh => {
      const list = fresh.releases.filter(x => keyOf(x) !== editing.key);
      if (list.length === fresh.releases.length) throw new Error('This release was no longer on the site.');
      if (!list.length) throw new Error('The site needs at least one release.');
      const item = fresh.releases.find(x => keyOf(x) === editing.key), gone = item?.image;
      return {
        releases: list,
        remove: gone && safeFile(gone) && !list.some(x => x.image === gone) ? [P('assets/' + gone)] : [],
        ignore: exclude ? ignoreEntry(fresh, item, `${item?.artist || ''} - ${item?.title || ''}`, 'release') : undefined,
      };
    });
    afterPublish(res, exclude ? 'Release excluded' : 'Release deleted', [jsonProbe('releases.json', res.out.releases)]);
    go('releases');
    return true;
  }

  /* Radio (mixtapes.json): el enlace de SoundCloud rellena número, título, invitado, portada y color */
  function radioView() {
    const list = repo.mixtapes;
    return `
      <div class="head">
        <div><p class="eyebrow">Horizon Mixtapes</p><h1>MIXTAPES <span class="count">${list.length}</span></h1></div>
        ${can('radio', 'edit') ? '<button type="button" class="btn primary" data-act="new-mixtape">+ New mixtape</button>' : ''}
      </div>
      <ol class="list">${list.length ? list.map((m, i) => `
        <li class="row item">
          <span class="pos">${i + 1}</span>
          ${imgTag(m.image, 'thumb')}
          <span class="meta"><b>${esc(m.number ? 'Horizon Mixtape ' + m.number : m.title || 'Untitled')}</b><span>${esc(m.artist || '')}</span></span>
          <span class="cat">${m.preview ? '♪ Audio' : '<span class="muted">No audio</span>'}</span>
          ${linkChips(m, ['soundcloud_link', 'youtube_link'])}
          <span class="swatch" style="--c:${esc(hex6(m.color) || '#ffffff')}"></span>
          ${i === 0 ? '<span class="feat">Cover</span>' : '<span></span>'}
          ${can('radio', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-mixtape" data-key="${esc(keyOf(m))}">Edit</button>` : '<span></span>'}
        </li>`).join('') : '<li class="empty">No mixtapes yet.</li>'}
      </ol>
      ${excludedHtml('mixtape')}`;
  }
  function nextMixNumber() {
    let n = 0;
    for (const m of repo.mixtapes) { const d = String(m.number || m.title || '').match(/(\d+)/); if (d) n = Math.max(n, Number(d[1])); }
    return '#' + String(n + 1).padStart(3, '0');
  }
  const normNumber = v => { const d = String(v).match(/^\s*#?\s*(\d+)\s*$/); return d ? '#' + d[1].padStart(3, '0') : String(v).trim(); };
  function mixtapeEditor() {
    const m = editing.orig || {}, isNew = !editing.key, n = repo.mixtapes.length;
    const cover = editing.cover?.url || (m.image ? assetSrc(m.image) : '');
    const color = hex6(editing.color ?? m.color) || '#ffffff';
    const number = m.number || nextMixNumber();
    return `
      <form id="ed" class="editor" novalidate>
        <button type="button" class="back" data-act="back">← Mixtapes</button>
        <h1>${isNew ? 'NUEVO MIXTAPE' : esc('Horizon Mixtape ' + (m.number || ''))}</h1>
        <div class="ed-grid">
          <div class="ed-side">
            ${coverDrop(cover, m.image && !editing.cover ? P('assets/' + m.image) : '', 'Cover')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
            <div class="field">
              <label for="f-color">Colour</label>
              <div class="color-row">
                <input type="color" id="f-color-pick" value="${esc(color)}" aria-label="Pick colour">
                <input id="f-color" name="color" value="${esc(color)}" maxlength="7" spellcheck="false" autocomplete="off">
                <span class="badge-prev" id="color-prev" style="--c:${esc(color)}">RADIO</span>
              </div>
            </div>
          </div>
          <div class="ed-main">
            <div class="field">
              <label for="f-sc">SoundCloud link</label>
              <div class="sc-row">
                <input id="f-sc" name="soundcloud_link" type="url" value="${esc(m.soundcloud_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://soundcloud.com/horizonirecords/…">
                <button type="button" class="btn ghost" data-act="sc-fill">Fill in</button>
              </div>
              <p class="info sc-info" id="sc-info"></p>
            </div>
            <div class="field"><label for="f-yt">YouTube link</label><input id="f-yt" name="youtube_link" type="url" value="${esc(m.youtube_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…"></div>
            <div class="row2">
              <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" value="${esc(m.title || 'HORIZON RCRDS Mixtape ' + number)}" maxlength="120" autocomplete="off"></div>
              <div class="field"><label for="f-number">Nº</label><input id="f-number" name="number" value="${esc(number)}" maxlength="12" autocomplete="off" spellcheck="false"></div>
            </div>
            <div class="row2">
              <div class="field"><label for="f-artist">Guest artist</label><input id="f-artist" name="artist" value="${esc(m.artist || '')}" maxlength="120" autocomplete="off"></div>
              <div class="field"><label for="f-position">Position</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? 1 : editing.index + 1}" inputmode="numeric"></div>
            </div>
            <p class="group">Audio snippet</p>
            <div class="mx-audio" id="mx-audio">${mixAudioHtml()}</div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publish' : 'Save changes'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancel</button>
          ${isNew || !can('radio', 'delete') ? '' : `${m.soundcloud_link ? '<button type="button" class="btn ghost push" data-act="exclude-mixtape">Exclude</button>' : ''}<button type="button" class="btn danger${m.soundcloud_link ? '' : ' push'}" data-act="delete-mixtape">Delete</button>`}
        </div>
      </form>`;
  }
  function mixAudioHtml() {
    const a = editing.audio, cur = !editing.removeAudio && editing.orig?.preview;
    const src = a?.url || (cur ? assetSrc(cur) : '');
    return `
      ${src ? `<audio controls preload="metadata" src="${esc(src)}"></audio>` : ''}
      ${a ? `<p class="info">${esc(a.name)} · ${(a.blob.size / 1048576).toFixed(1)} MB</p>` : src ? '' : '<p class="info">No snippet: on the site the button opens the mix on SoundCloud.</p>'}
      <div class="card-actions">
        <input type="file" id="mx-file" class="sr-only" accept="audio/mpeg,.mp3">
        <label for="mx-file" class="btn ghost sm">${src ? 'Change MP3' : 'Choose MP3'}</label>
        ${src ? '<button type="button" class="btn ghost sm" data-act="mx-remove-audio">Remove</button>' : ''}
      </div>`;
  }
  async function setMixAudio(file) {
    try {
      await checkMp3(file);
      if (!editing) return;
      if (editing.audio) URL.revokeObjectURL(editing.audio.url);
      editing.audio = { blob: file, url: URL.createObjectURL(file), name: file.name };
      editing.removeAudio = false;
      $('#mx-audio').innerHTML = mixAudioHtml();
      $('#ed-error').hidden = true;
    } catch (e) { showError(e); }
  }
  let scSeq = 0;
  async function scFill(force) {
    const input = $('#f-sc'), info = $('#sc-info');
    if (!input || !editing) return;
    let u;
    try { u = new URL(input.value.trim()); } catch { if (force) showError(new FieldError('soundcloud_link', 'Paste the mixtape’s SoundCloud link first.')); return; }
    if (!HOSTS.soundcloud.some(h => h.test(u.hostname))) { if (force) showError(new FieldError('soundcloud_link', 'That is not a SoundCloud link.')); return; }
    const id = ++scSeq;
    info.textContent = 'Leyendo SoundCloud…';
    try {
      const res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u.href)}`).catch(() => null);
      if (!res?.ok) throw new Error('SoundCloud can’t find that link (is it public?).');
      const o = await res.json();
      if (id !== scSeq || !editing) return;
      let title = String(o.title || '').trim();
      const by = ` by ${o.author_name || ''}`;
      if (o.author_name && title.endsWith(by)) title = title.slice(0, -by.length).trim();
      const [main, guest = ''] = title.split('|').map(x => x.trim());
      const num = (main.match(/#\s*(\d+)/) || [])[1];
      const put = (name, v) => {
        const el = $(`[name="${name}"]`);
        if (el && v && (force || !el.value.trim())) el.value = v;
      };
      put('title', main.replace(/[<>]/g, ''));
      if (num) put('number', '#' + num.padStart(3, '0'));
      put('artist', guest.replace(/[<>]/g, ''));
      let gotCover = false;
      if (o.thumbnail_url && (force || (!editing.cover && !editing.orig?.image))) {
        const t = o.thumbnail_url;
        for (const url of [t.replace('-t500x500', '-original'), t.replace('-t500x500.jpg', '-original.png'), t]) {
          const r = await fetch(url).catch(() => null);
          const type = r?.headers.get('content-type') || '';
          if (r?.ok && /^image\/(jpeg|png|webp)/.test(type)) {
            const b = await r.blob();
            if (id !== scSeq || !editing) return;
            await setCover(new File([b], 'cover', { type: b.type || type.split(';')[0] }));
            gotCover = true;
            break;
          }
        }
      }
      info.textContent = gotCover || !force ? '✓ SoundCloud details' : '✓ SoundCloud details (no cover: upload it manually)';
    } catch (e) {
      if (id === scSeq) info.textContent = e.message;
    }
  }
  async function saveMixtape(form) {
    const isNew = !editing.key, orig = editing.orig || {};
    const v = {
      soundcloud_link: link(form, 'soundcloud_link', 'SoundCloud', HOSTS.soundcloud, 'SoundCloud link missing.'),
      title: text(form, 'title', 'Title', { missing: 'Title missing.' }),
      number: normNumber(text(form, 'number', 'Nº', { max: 12, missing: 'Number missing.' })),
      artist: text(form, 'artist', 'Guest artist', { max: 120 }),
      youtube_link: link(form, 'youtube_link', 'YouTube', HOSTS.youtube),
    };
    const color = hex6(form.elements.color.value);
    if (!color) throw new FieldError('color', 'Colour: enter a colour like #ff68b2.');
    if (isNew && !editing.cover) throw new Error('Cover missing (paste the SoundCloud link or upload it).');
    const pos = position(form, isNew ? repo.mixtapes.length + 1 : repo.mixtapes.length);
    const base = 'mix' + (normCat(v.number) || 'tape');
    let image = orig.image, preview = editing.removeAudio ? undefined : orig.preview;
    const uploads = [];
    if (editing.cover) { image = uniqueName(base, 'jpg'); uploads.push({ path: P('assets/' + image), blob: editing.cover.blob }); }
    if (editing.audio) { preview = uniqueName(base, 'mp3'); uploads.push({ path: P('assets/' + preview), blob: editing.audio.blob }); }
    const res = await publish(`${isNew ? 'Add' : 'Update'} mixtape ${v.number}${v.artist ? ' — ' + v.artist : ''}`, uploads, fresh => {
      const list = fresh.mixtapes.slice();
      const idx = isNew ? -1 : list.findIndex(m => keyOf(m) === editing.key);
      if (!isNew && idx < 0) throw new Error('This mixtape is no longer on the site (deleted elsewhere). Go back to the list.');
      if (list.some((m, i) => i !== idx && m.number && normCat(m.number) === normCat(v.number))) throw new FieldError('number', `There is already a mixtape ${v.number}.`);
      let entry;
      if (isNew) {
        let id = base, k = 2;
        while (list.some(m => m.id === id)) id = `${base}-${k++}`;
        entry = { id, number: v.number, title: v.title, artist: v.artist, image, color, preview, soundcloud_link: v.soundcloud_link };
      } else {
        entry = { ...list[idx], number: v.number, title: v.title, artist: v.artist, image, color, preview, soundcloud_link: v.soundcloud_link };
      }
      if (!entry.artist) delete entry.artist;
      if (!entry.preview) delete entry.preview;
      if (v.youtube_link) entry.youtube_link = v.youtube_link; else delete entry.youtube_link;
      if (!isNew) list.splice(idx, 1);
      list.splice(Math.min(pos - 1, list.length), 0, entry);
      const old = idx >= 0 ? fresh.mixtapes[idx] : {};
      const used = f => list.some(m => m.image === f || m.preview === f) || fresh.releases.some(r => r.image === f);
      const remove = [old.image !== image && old.image, old.preview !== preview && old.preview]
        .filter(f => f && safeFile(f) && !used(f)).map(f => P('assets/' + f));
      return { mixtapes: list, remove };
    });
    afterPublish(res, isNew ? 'Mixtape publicado' : 'Changes saved', [jsonProbe('mixtapes.json', res.out.mixtapes), ...uploads.map(u => fileProbe(u.path.split('/').pop(), u.blob))]);
    go('radio');
  }
  async function deleteMixtape(exclude) {
    const m = editing.orig;
    const ask = exclude
      ? `Exclude “Horizon Mixtape ${m.number || ''}”? It is removed from the site and the SoundCloud sync won’t add it again (undo it in “Excluded”).`
      : `Delete “Horizon Mixtape ${m.number || ''}” from the site? Its cover and audio are deleted too.${m.soundcloud_link ? ' If it is still on SoundCloud it will come back on the next sync (use “Exclude” to stop that).' : ''}`;
    if (!await confirmBox(ask, exclude ? 'Exclude' : 'Delete')) return false;
    const res = await publish(`${exclude ? 'Exclude' : 'Remove'} mixtape ${m.number || ''}`, [], fresh => {
      const list = fresh.mixtapes.filter(x => keyOf(x) !== editing.key);
      if (list.length === fresh.mixtapes.length) throw new Error('This mixtape was no longer on the site.');
      const gone = fresh.mixtapes.find(x => keyOf(x) === editing.key);
      const used = f => list.some(x => x.image === f || x.preview === f) || fresh.releases.some(r => r.image === f);
      return {
        mixtapes: list,
        remove: [gone.image, gone.preview].filter(f => f && safeFile(f) && !used(f)).map(f => P('assets/' + f)),
        ignore: exclude ? ignoreEntry(fresh, gone, gone.title || `Mixtape ${gone.number || ''}`, 'mixtape') : undefined,
      };
    });
    afterPublish(res, exclude ? 'Mixtape excluido' : 'Mixtape eliminado', [jsonProbe('mixtapes.json', res.out.mixtapes)]);
    go('radio');
    return true;
  }

  /* Playlists */
  function playlistsView() {
    const list = repo.playlists;
    return `
      <div class="head">
        <div><p class="eyebrow">Curated</p><h1>PLAYLISTS <span class="count">${list.length}</span></h1></div>
        ${can('playlists', 'edit') ? '<button type="button" class="btn primary" data-act="new-playlist">+ New playlist</button>' : ''}
      </div>
      <ol class="list">${list.length ? list.map((p, i) => `
        <li class="row pl">
          <span class="pos">${i + 1}</span>
          ${imgTag(p.image, 'thumb')}
          <span class="meta"><b>${esc(p.title || 'Untitled')}</b><span>${esc(p.description || '')}</span></span>
          ${can('playlists', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-playlist" data-index="${i}">Edit</button>` : '<span></span>'}
        </li>`).join('') : '<li class="empty">No playlists yet.</li>'}
      </ol>`;
  }
  function playlistEditor() {
    const p = editing.orig || {}, isNew = editing.index < 0, n = repo.playlists.length;
    const cover = editing.cover?.url || (p.image ? assetSrc(p.image) : '');
    return `
      <form id="ed" class="editor" novalidate>
        <button type="button" class="back" data-act="back">← Playlists</button>
        <h1>${isNew ? 'NEW PLAYLIST' : esc(p.title || 'Untitled')}</h1>
        <div class="ed-grid">
          <div class="ed-side">
            ${coverDrop(cover, p.image && !editing.cover ? P('assets/' + p.image) : '', 'Cover')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
          </div>
          <div class="ed-main">
            <div class="field"><label for="f-title">Title</label><input id="f-title" name="title" value="${esc(p.title || '')}" maxlength="80" autocomplete="off"></div>
            <div class="field"><label for="f-desc">Description</label><textarea id="f-desc" name="description" rows="3" maxlength="300">${esc(p.description || '')}</textarea></div>
            <div class="field"><label for="f-link">Link</label><input id="f-link" name="link" type="url" value="${esc(p.link || '')}" autocomplete="off" spellcheck="false" placeholder="https://open.spotify.com/playlist/…"></div>
            <div class="field narrow"><label for="f-position">Position</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? n + 1 : editing.index + 1}" inputmode="numeric"></div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publish' : 'Save changes'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancel</button>
          ${isNew || !can('playlists', 'delete') ? '' : '<button type="button" class="btn danger push" data-act="delete-playlist">Delete</button>'}
        </div>
      </form>`;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function findPlaylist(list) {
    if (same(list[editing.index], editing.orig)) return editing.index;
    const i = list.findIndex(p => same(p, editing.orig));
    if (i < 0) throw new Error('This playlist changed somewhere else. Go back to the list and open it again.');
    return i;
  }
  function nextPlaylistImage() {
    let n = 0;
    for (const path of [...repo.files.keys(), ...previews.keys()]) {
      const m = path.match(/(?:^|\/)assets\/playlist(\d+)\.jpg$/);
      if (m && path.startsWith(P('assets/'))) n = Math.max(n, Number(m[1]));
    }
    return `playlist${n + 1}.jpg`;
  }
  async function savePlaylist(form) {
    const isNew = editing.index < 0, orig = editing.orig || {};
    const v = {
      title: text(form, 'title', 'Title', { max: 80, missing: 'Title missing.' }),
      description: text(form, 'description', 'Description', { max: 300 }),
      link: link(form, 'link', 'Link', null, 'Link missing.'),
    };
    if (isNew && !editing.cover) throw new Error('Cover missing.');
    const pos = position(form, isNew ? repo.playlists.length + 1 : repo.playlists.length);
    let image = orig.image;
    const uploads = [];
    if (editing.cover) { image = nextPlaylistImage(); uploads.push({ path: P('assets/' + image), blob: editing.cover.blob }); }
    const res = await publish(`${isNew ? 'Add' : 'Update'} playlist — ${v.title}`, uploads, fresh => {
      const list = fresh.playlists.slice();
      const idx = isNew ? -1 : findPlaylist(list);
      const entry = isNew ? { title: v.title, description: v.description, link: v.link, image } : { ...list[idx], ...v, image };
      if (!entry.description) delete entry.description;
      if (!isNew) list.splice(idx, 1);
      list.splice(Math.min(pos - 1, list.length), 0, entry);
      const old = idx >= 0 ? fresh.playlists[idx].image : null;
      return { playlists: list, remove: old && old !== image && safeFile(old) && !list.some(p => p.image === old) && !fresh.releases.some(r => r.image === old) ? [P('assets/' + old)] : [] };
    });
    afterPublish(res, isNew ? 'Playlist publicada' : 'Changes saved', [jsonProbe('playlists.json', res.out.playlists), ...uploads.map(u => fileProbe(image, u.blob))]);
    go('playlists');
  }
  async function deletePlaylist() {
    const p = editing.orig;
    if (!await confirmBox(`Delete the playlist “${p.title || ''}” from the site?`)) return false;
    const res = await publish(`Remove playlist — ${p.title || ''}`, [], fresh => {
      const list = fresh.playlists.slice(), idx = findPlaylist(list);
      const [gone] = list.splice(idx, 1);
      return { playlists: list, remove: gone.image && safeFile(gone.image) && !list.some(x => x.image === gone.image) && !fresh.releases.some(r => r.image === gone.image) ? [P('assets/' + gone.image)] : [] };
    });
    afterPublish(res, 'Playlist eliminada', [jsonProbe('playlists.json', res.out.playlists)]);
    go('playlists');
    return true;
  }

  /* Reproductor y logo: archivos que se sustituyen tal cual */
  const FILES = {
    player: [{ file: 'release_preview.mp3', title: 'Player audio', kind: 'audio', accept: 'audio/mpeg,.mp3' }],
  };
  const pending = new Map();   // archivo → { blob, url }
  function fileCard(f, editable) {
    const path = P('assets/' + f.file), has = repo.files.has(path) || previews.has(path), nw = pending.get(f.file);
    const src = nw?.url || (has ? assetSrc(f.file) : '');
    const media = f.kind === 'audio'
      ? (src ? `<audio controls preload="metadata" src="${esc(src)}"></audio>` : '<p class="info">No audio yet.</p>')
      : `<div class="logo-prev">${src ? `<img src="${esc(src)}" ${nw ? '' : `data-repo="${esc(path)}"`} alt="">` : '<span class="info">No image</span>'}</div>`;
    return `
      <section class="card" data-file="${esc(f.file)}">
        <h2>${esc(f.title)}${nw ? ' <span class="tag">New, not published</span>' : ''}</h2>
        ${media}
        ${nw ? `<p class="info">${esc(nw.name)} · ${(nw.blob.size / 1048576).toFixed(1)} MB</p>` : ''}
        ${editable ? `<div class="card-actions">
          <input type="file" id="file-${esc(f.file)}" class="sr-only" accept="${esc(f.accept)}" data-pick="${esc(f.file)}">
          <label for="file-${esc(f.file)}" class="btn ghost">${nw ? 'Choose another' : f.kind === 'audio' ? 'Change audio' : 'Change image'}</label>
          ${nw ? `<button type="button" class="btn primary" data-act="publish-file" data-file="${esc(f.file)}">Publish</button>
                  <button type="button" class="btn ghost" data-act="discard-file" data-file="${esc(f.file)}">Discard</button>` : ''}
        </div>` : ''}
        <p class="ed-error" role="alert" hidden></p>
      </section>`;
  }
  function filesView(which) {
    const title = which === 'player' ? 'REPRODUCTOR' : 'LOGO';
    return `<div class="head"><div><p class="eyebrow">${which === 'player' ? 'Latest Release' : 'Brand'}</p><h1>${title}</h1></div></div>
      <div class="cards">${FILES[which].map(f => fileCard(f, can(which, 'edit'))).join('')}</div>`;
  }
  async function pickFile(name, file) {
    const f = Object.values(FILES).flat().find(x => x.file === name);
    const card = $(`.card[data-file="${CSS.escape(name)}"]`), err = card?.querySelector('.ed-error');
    try {
      if (f.kind === 'audio') {
        await checkMp3(file);
      } else {
        if (file.type !== 'image/png') throw new Error('Use a PNG image (with a transparent background if the current one has one).');
        if (file.size > 3 * 1048576) throw new Error('The image is too big (max 3 MB).');
        if (!await decodeImage(file).catch(() => null)) throw new Error('Could not read the image.');
      }
      const old = pending.get(name); if (old) URL.revokeObjectURL(old.url);
      pending.set(name, { blob: file, url: URL.createObjectURL(file), name: file.name });
      render();
      $(`[data-act="publish-file"][data-file="${CSS.escape(name)}"]`)?.focus();
    } catch (e) {
      if (err) { err.textContent = e.message; err.hidden = false; } else toast(e.message);
    }
  }
  async function checkMp3(file) {
    if (!(file.type === 'audio/mpeg' || /\.mp3$/i.test(file.name))) throw new Error('Use an MP3 file.');
    if (file.size > MAX_AUDIO) throw new Error('The audio is too big (max 25 MB).');
    await new Promise((ok, ko) => {
      const a = new Audio(), u = URL.createObjectURL(file), t = setTimeout(() => done(ko), 10000);
      const done = fn => { clearTimeout(t); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(u); fn(new Error('This file can’t be played. Try another MP3.')); };
      a.onloadedmetadata = () => { clearTimeout(t); URL.revokeObjectURL(u); ok(); };
      a.onerror = () => done(ko);
      a.preload = 'metadata'; a.src = u;
    });
  }
  async function publishFile(name, btn) {
    const nw = pending.get(name);
    if (!nw) return;
    const card = btn.closest('.card'), err = card.querySelector('.ed-error');
    busyOn(card, btn, 'Publicando…');
    try {
      const res = await publish(`Update ${name}`, [{ path: P('assets/' + name), blob: nw.blob }]);
      URL.revokeObjectURL(nw.url); pending.delete(name);
      afterPublish(res, 'Published', [fileProbe(name, nw.blob)]);
      render();
    } catch (e) {
      busyOff(card);
      err.textContent = e.message; err.hidden = false;
      if (e.status === 401) logout(e.message);
    } finally { busy = false; }
  }

  function afterPublish(res, msg, probes) {
    if (res.unchanged) { toast('Nothing to change'); return; }
    toast(msg); accent(); watchSite(probes);
  }

  /* ---------------- Navegación ---------------- */
  let dirtyBase = null;
  function formState() {
    const f = $('#ed');
    if (!f) return null;
    return JSON.stringify([[...new FormData(f)].filter(([k]) => k !== 'ed-file').map(([k, v]) => [k, typeof v === 'string' ? v : '']), !!editing?.cover, !!editing?.audio, !!editing?.removeAudio]);
  }
  function setDirtyBase(v) { dirtyBase = v; }
  const isDirty = () => !!(editing && dirtyBase !== null && formState() !== dirtyBase) || pending.size > 0;
  async function leaveOk() {
    if (!isDirty()) return true;
    const ok = await confirmBox('There are unpublished changes. Leave without publishing?', 'Leave without publishing');
    if (ok) { for (const p of pending.values()) URL.revokeObjectURL(p.url); pending.clear(); }
    return ok;
  }
  // la sección en la que estás se recuerda en esta pestaña (al refrescar no vuelve a Releases)
  const VIEW_KEY = 'hz_view_' + MODE;
  const lastView = () => { let v = ''; try { v = sessionStorage.getItem(VIEW_KEY) || ''; } catch { /* nada */ } return v && v !== 'none' ? v : firstView(); };
  function go(v, ed = null) {
    formOpen = null; ctOpen = null; calOpen = null;
    view = v; editing = ed; setDirtyBase(null);
    render();
    if (editing) setDirtyBase(formState());
    const main = $('#main');
    window.scrollTo(0, 0);
    if (editing) $('#f-title')?.focus({ preventScroll: true }); else main?.focus({ preventScroll: true });
  }
  function render() {
    if (!auth || !repo) return;
    accent();
    if (view === 'forms' && !showForms()) view = firstView();
    if (view !== 'team' && view !== 'log' && view !== 'none' && view !== 'forms' && view !== 'contracts' && !can(view)) { view = firstView(); editing = null; }
    if (view === 'contracts' && !can('contracts')) view = firstView();
    if (view === 'calendar' && !can('calendar')) view = firstView();
    if ((view === 'team' || view === 'log') && (preview || !(MODE === 'admin' && auth.user.owner))) view = firstView();
    if (!preview) try { sessionStorage.setItem(VIEW_KEY, view); } catch { /* nada */ }
    let inner;
    if (view === 'none') inner = noAccessView();
    else if (view === 'team') inner = teamView();
    else if (view === 'log') inner = logView();
    else if (view === 'forms') inner = formsPage();
    else if (view === 'contracts') inner = contractsPage();
    else if (view === 'calendar') inner = calendarPage();
    else if (editing?.view === 'releases') inner = releaseEditor();
    else if (editing?.view === 'playlists') inner = playlistEditor();
    else if (editing?.view === 'radio') inner = mixtapeEditor();
    else if (view === 'radio') inner = radioView();
    else if (view === 'playlists') inner = playlistsView();
    else if (view === 'player') inner = filesView(view);
    else inner = releasesView();
    app.innerHTML = shell(inner);
    chatStart();
    const names = { releases: 'Releases', radio: 'Mixtapes', playlists: 'Playlists', player: 'Player', team: 'Team', log: 'History', forms: 'Forms', contracts: 'Contracts', calendar: 'Calendar', none: 'Team' };
    document.title = `${unseen.total && !preview ? `(${unseen.total > 99 ? '99+' : unseen.total}) ` : ''}${editing ? (editing.orig?.title || 'New') + ' · ' : ''}${names[view] || ''} — Panel HORIZON RCRDS`;
  }
  function busyOn(scope, btn, label) {
    busy = true;
    $$('button, input, textarea, label.btn', scope).forEach(el => { el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; el.classList.add('is-disabled'); });
    btn.dataset.label = btn.textContent; btn.textContent = label;
    scope.setAttribute('aria-busy', 'true');
  }
  function busyOff(scope) {
    busy = false;
    $$('button, input, textarea, label.btn', scope).forEach(el => { el.disabled = el.dataset.wasDisabled === '1'; el.classList.remove('is-disabled'); });
    $$('[data-label]', scope).forEach(b => { b.textContent = b.dataset.label; delete b.dataset.label; });
    scope.removeAttribute('aria-busy');
  }

  async function setCover(file) {
    const info = $('#ed-cover-info');
    if (!file || !editing) return;
    if (info) info.textContent = 'Preparando…';
    try {
      const c = await processCover(file, editing.px);
      if (!editing) return;
      if (editing.cover) URL.revokeObjectURL(editing.cover.url);
      editing.cover = c;
      const drop = $('[data-drop] .drop-in');
      drop.querySelector('img')?.remove();
      const img = document.createElement('img'); img.src = c.url; img.alt = '';
      drop.prepend(img);
      drop.querySelector('.drop-hint').textContent = 'Change cover';
      if (info) info.innerHTML = coverInfo();
      if (editing.view !== 'playlists') setColor(c.color);
      $('#ed-error').hidden = true;
    } catch (e) {
      if (info) info.textContent = '';
      showError(e);
    }
  }
  function setColor(c) {
    const h = hex6(c);
    if (!h) return;
    editing.color = h;
    $('#f-color').value = h; $('#f-color-pick').value = h;
    $('#color-prev').style.setProperty('--c', h);
  }

  const GRIP_SVG = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
  /* Orden de las secciones: se arrastra por el asa (o flechas del teclado sobre ella) */
  const saveOrder = list => list.classList.contains('forms-list') ? saveFormOrder(list) : saveSectionOrder(list);
  async function saveFormOrder(list) {
    const ids = [...list.querySelectorAll('.row.fm')].map(x => x.dataset.form);
    if (ids.join() === formsData.forms.map(f => f.id).join()) return;
    formsData.forms.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    try { await api('POST', '/api/forms/order', { ids }); toast('Order saved'); } catch (err) { toast(err.message); loadForms(); }
  }
  // clic en un formulario de la lista: se abre (editor con vista previa, o sus respuestas)
  document.addEventListener('click', e => {
    const row = e.target.closest('.row.fm');
    if (!row || busy || e.target.closest('a, button, input, label')) return;
    const b = row.querySelector('[data-act="form-resp"]');
    b?.click();
  });
  async function saveSectionOrder(list) {
    const ids = [...list.querySelectorAll('.perm-row')].map(x => x.dataset.sec);
    if (ids.join() === (auth.sections || []).map(x => x.id).join()) return;
    try {
      const r = await api('POST', '/api/team/sections', { ids });
      teamData.sections = r.sections; auth.sections = r.sections;
      for (const st of [localStorage, sessionStorage]) { try { const sv = JSON.parse(st.getItem(AUTH_KEY) || 'null'); if (sv) { sv.sections = r.sections; st.setItem(AUTH_KEY, JSON.stringify(sv)); } } catch { /* nada */ } }
      render(); toast('Order saved');
    } catch (err) { toast(err.message); }
  }
  // arrastrar: la fila sigue al ratón por toda la lista (se escucha en window, así no se pierde al mover la fila)
  document.addEventListener('pointerdown', e => {
    const g = e.target.closest('.grip');
    if (!g || e.button) return;
    e.preventDefault();
    const row = g.closest('.perm-row, .row.fm'), list = row.parentElement, sel = row.classList.contains('fm') ? '.row.fm' : '.perm-row';
    row.classList.add('dragging'); list.classList.add('sorting');
    let lastY = e.clientY, raf = 0;
    const place = () => {
      raf = 0;
      const rows = [...list.querySelectorAll(sel + ':not(.dragging)')];
      const after = rows.find(r => { const b = r.getBoundingClientRect(); return lastY < b.top + b.height / 2; });
      if (after) { if (after !== row.nextElementSibling) list.insertBefore(row, after); } else if (rows.length && rows[rows.length - 1].nextElementSibling !== row) rows[rows.length - 1].after(row);
      // cerca del borde de la ventana: se desplaza sola para poder llegar arriba o abajo del todo
      if (lastY < 70) window.scrollBy(0, -12); else if (lastY > innerHeight - 70) window.scrollBy(0, 12);
    };
    const move = ev => { lastY = ev.clientY; if (!raf) raf = requestAnimationFrame(place); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      row.classList.remove('dragging'); list.classList.remove('sorting');
      saveOrder(list);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });
  document.addEventListener('keydown', e => {
    const g = e.target.closest?.('.grip');
    if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const row = g.closest('.perm-row, .row.fm'), list = row.parentElement;
    const sib = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    if (e.key === 'ArrowUp') list.insertBefore(row, sib); else list.insertBefore(sib, row);
    g.focus(); saveOrder(list);
  });

  /* ---------------- Eventos ---------------- */
  // «Atrás» del navegador no saca del panel: vuelve a la primera sección (Releases)
  try { history.replaceState({ hz: 0 }, ''); history.pushState({ hz: 1 }, ''); } catch { /* nada */ }
  window.addEventListener('popstate', async () => {
    history.pushState({ hz: 1 }, '');
    if (!auth || !repo) return;
    if ($('#sheet')?.open) { closeSheet(); return; }
    if (!await leaveOk()) return;
    filter = ''; go(firstView());
  });
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act], [data-view]');
    if (!t || busy) return;
    if (t.dataset.view) {
      if (t.dataset.view === view && !editing && !formOpen && !ctOpen && !calOpen) return;
      if (!await leaveOk()) return;
      filter = ''; go(t.dataset.view);
      return;
    }
    // El servidor también lo comprueba; aquí solo se evita abrir lo que el rol no puede usar
    const needs = { 'new-release': ['releases', 'edit'], 'edit-release': ['releases', 'edit'], 'delete-release': ['releases', 'delete'], 'exclude-release': ['releases', 'delete'],
      'new-mixtape': ['radio', 'edit'], 'edit-mixtape': ['radio', 'edit'], 'delete-mixtape': ['radio', 'delete'], 'exclude-mixtape': ['radio', 'delete'],
      'new-playlist': ['playlists', 'edit'], 'edit-playlist': ['playlists', 'edit'], 'delete-playlist': ['playlists', 'delete'] }[t.dataset.act];
    if (needs && !can(...needs)) { toast('Your role doesn’t have permission for this.'); return; }
    switch (t.dataset.act) {
      case 'team-retry': teamErr = ''; render(); break;
      case 'log-more': loadLog(true); break;
      case 'preview-role': {
        const r = teamData?.roles.find(x => x.id === t.closest('[data-role]')?.dataset.role);
        if (!r) return;
        preview = { id: r.id, name: r.name, perms: r.perms, forms: r.forms };
        if (!formsData) loadForms().then(() => render());
        filter = ''; go(firstView());
        break;
      }
      case 'preview-off': preview = null; go('team'); checkUnseen(); break;
      case 'open-role': { const r = teamData.roles.find(x => x.id === t.closest('[data-role]').dataset.role); if (r) roleSheet(r); break; }
      case 'new-role': roleSheet({ perms: {} }); break;
      case 'sheet-close': closeSheet(); break;
      case 'pf-toggle': {
        const box = t.closest('.role-form').querySelector('.perm-forms'), open = box.hidden;
        box.hidden = !open; t.setAttribute('aria-expanded', String(open)); t.classList.toggle('open', open);
        break;
      }
      case 'me': meSheet(); break;
      case 'me-color': setMyColor(t.dataset.c); break;
      case 'me-nophoto': try { await authFetch('/api/me/avatar', { method: 'DELETE' }); auth.user.picture = ''; saveMe({ picture: '' }); teamData = null; render(); meSheet(); } catch (err) { toast(err.message); } break;
      case 'add-member': memberSheet(null); break;
      case 'edit-member': { const m = teamData.members.find(x => x.email === t.closest('[data-email]').dataset.email); if (m) memberSheet(m); break; }
      case 'delete-role': {
        const form = t.closest('.role-form'), r = teamData.roles.find(x => x.id === form.dataset.role);
        closeSheet();
        if (!r || !await confirmBox(`Delete the role “${r.name}”?`)) { if (r) roleSheet(r); return; }
        teamAction(() => api('DELETE', `/api/team/roles?id=${encodeURIComponent(r.id)}`), 'Role deleted');
        break;
      }
      case 'remove-member': {
        const email = t.closest('.member-form').dataset.email;
        closeSheet();
        if (!await confirmBox(`Remove ${email} from the team? They will lose access to /team immediately.`, 'Remove')) return;
        teamAction(() => api('DELETE', `/api/team/members?email=${encodeURIComponent(email)}`), 'Removed from the team');
        break;
      }
      case 'logout':
        if (await leaveOk()) logout();
        break;
      case 'back':
        if (await leaveOk()) go(editing?.view || view);
        break;
      case 'new-release':
        go('releases', { view: 'releases', key: null, orig: null, index: -1, cover: null, px: COVER_PX });
        break;
      case 'edit-release': {
        const index = repo.releases.findIndex(r => keyOf(r) === t.dataset.key);
        if (index < 0) return;
        go('releases', { view: 'releases', key: t.dataset.key, orig: repo.releases[index], index, cover: null, px: COVER_PX });
        break;
      }
      case 'new-mixtape':
        go('radio', { view: 'radio', key: null, orig: null, index: -1, cover: null, px: COVER_PX });
        break;
      case 'edit-mixtape': {
        const index = repo.mixtapes.findIndex(m => keyOf(m) === t.dataset.key);
        if (index < 0) return;
        go('radio', { view: 'radio', key: t.dataset.key, orig: repo.mixtapes[index], index, cover: null, px: COVER_PX });
        break;
      }
      case 'sc-fill': scFill(true); break;
      case 'mx-remove-audio':
        if (editing.audio) URL.revokeObjectURL(editing.audio.url);
        editing.audio = null; editing.removeAudio = true;
        $('#mx-audio').innerHTML = mixAudioHtml();
        break;
      case 'new-playlist':
        go('playlists', { view: 'playlists', index: -1, orig: null, cover: null, px: COVER_PX });
        break;
      case 'edit-playlist': {
        const index = Number(t.dataset.index);
        if (!repo.playlists[index]) return;
        go('playlists', { view: 'playlists', index, orig: repo.playlists[index], cover: null, px: COVER_PX });
        break;
      }
      case 'delete-release':
      case 'delete-mixtape':
      case 'exclude-release':
      case 'exclude-mixtape':
      case 'delete-playlist': {
        const form = $('#ed'), act = t.dataset.act, exclude = act.startsWith('exclude');
        busyOn(form, t, exclude ? 'Excluyendo…' : 'Eliminando…');
        try {
          const done = await (/release$/.test(act) ? deleteRelease(exclude) : /mixtape$/.test(act) ? deleteMixtape(exclude) : deletePlaylist());
          if (!done) busyOff(form);
        } catch (err) { busyOff(form); showError(err); } finally { busy = false; }
        break;
      }
      case 'unexclude': {
        busy = true; t.disabled = true;
        try { await unexclude(t.dataset.link); } catch (err) { toast(err.message); if (err.status === 401) logout(err.message); }
        finally { busy = false; if (t.isConnected) t.disabled = false; }
        break;
      }
      case 'publish-file': publishFile(t.dataset.file, t); break;
      case 'discard-file': {
        const p = pending.get(t.dataset.file);
        if (p) URL.revokeObjectURL(p.url);
        pending.delete(t.dataset.file); render();
        break;
      }
    }
  });
  document.addEventListener('submit', async e => {
    const form = e.target;
    if (form.method === 'dialog') return;   // la ventana de confirmar se cierra sola
    e.preventDefault();
    if (form.id === 'me-sc') {
      try {
        const r = await api('POST', '/api/me/soundcloud', { url: form.elements.url.value.trim() });
        auth.user.soundcloud = r.soundcloud || ''; if (r.picture) auth.user.picture = r.picture;
        saveMe({ soundcloud: auth.user.soundcloud, picture: auth.user.picture }); teamData = null; render(); meSheet();
        toast(r.soundcloud ? 'Photo taken from SoundCloud' : 'SoundCloud link removed');
      } catch (err) { toast(err.message); }
      return;
    }
    if (form.id === 'dev-login') { const email = form.elements.email.value.trim(); if (email) login({ email }); return; }
    if (form.id === 'mail-login') {
      const mail = form.elements.email.value.trim().toLowerCase(), codeF = $('#ml-code-f'), info = $('#ml-info'), btn = $('#ml-btn');
      loginError('');
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(mail)) { loginError('Write a valid email.'); return; }
      if (codeF.hidden) {
        btn.disabled = true;
        try {
          await api('POST', '/api/auth/email/start', { email: mail, area: MODE });
          codeF.hidden = false; form.elements.email.readOnly = true; btn.textContent = 'Sign in';
          info.textContent = 'If this email is on the team, a 6-digit code is on its way. Check your inbox (and spam).'; info.hidden = false;
          $('#ml-code').focus();
        } catch (err) { loginError(err.message); }
        btn.disabled = false;
        return;
      }
      const code = form.elements.code.value.replace(/\D/g, '');
      if (code.length !== 6) { loginError('Write the 6-digit code from the email.'); return; }
      login({ mail, code });
      return;
    }
    if (busy) return;
    if (form.classList.contains('member-form')) {
      const box = form.querySelector('.ed-error'); box.hidden = true;
      const isNew = !form.dataset.email;
      const email = isNew ? form.elements.email.value.trim().toLowerCase() : form.dataset.email;
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { box.textContent = 'Enter a valid email.'; box.hidden = false; form.elements.email.focus(); return; }
      teamAction(() => api('POST', '/api/team/members', { email, label: form.elements.label.value.trim(), color: form.elements.color.value, role_id: form.elements.role_id?.value, soundcloud: form.elements.soundcloud.value.trim() }), isNew ? `${email} added to the team` : 'Saved', box);
      return;
    }
    if (form.classList.contains('role-form')) {
      const box = form.querySelector('.ed-error'); box.hidden = true;
      const name = form.elements.name.value.trim();
      if (!name) { box.textContent = 'Give the role a name.'; box.hidden = false; form.elements.name.focus(); return; }
      const id = form.dataset.role || undefined;
      const forms = {};
      form.querySelectorAll('.pf-row').forEach(row => { const v = row.querySelector('input:checked')?.value; if (v) forms[row.dataset.form] = v; });
      if (!form.querySelector('.pf-row') && !form.querySelector('.pf-wait')) { /* sin formularios */ }
      teamAction(() => api('POST', '/api/team/roles', { id, name, perms: rolePerms(form), forms }), id ? 'Role saved' : 'Role created', box);
      return;
    }
    if (form.id !== 'ed' || busy) return;
    const btn = form.querySelector('[type=submit]');
    $('#ed-error').hidden = true;
    busyOn(form, btn, 'Publicando…');
    try {
      if (editing.view === 'releases') await saveRelease(form);
      else if (editing.view === 'radio') await saveMixtape(form);
      else await savePlaylist(form);
    } catch (err) {
      busyOff(form);
      showError(err);
    } finally { busy = false; }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'rel-filter') { filter = t.value; $('#rel-list').innerHTML = releaseRows(); return; }
    if (t.id === 'resp-filter' && formOpen) { formOpen.q = t.value; clearTimeout(respTimer); respTimer = setTimeout(searchResponses, 250); return; }
    if (t.id === 'f-color-pick') setColor(t.value);
    if (t.type === 'color' && t.closest('.color-dot')) { t.closest('.color-dot').style.setProperty('--c', t.value); const n = t.dataset.member && $$('.name-in').find(i => i.dataset.member === t.dataset.member); if (n) n.style.color = t.value; }
    if (t.id === 'f-color' && hex6(t.value)) { editing.color = hex6(t.value); $('#f-color-pick').value = editing.color; $('#color-prev').style.setProperty('--c', editing.color); }
    if (t.id === 'f-catalog') $('#color-prev').textContent = t.value || ' ';
    if (t.matches('[aria-invalid]')) t.removeAttribute('aria-invalid');
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'ed-file' && t.files[0]) { setCover(t.files[0]); t.value = ''; }
    if (t.id === 'me-photo' && t.files[0]) { setMyPhoto(t.files[0]); t.value = ''; }
    if (t.id === 'me-color') setMyColor(t.value);
    if (t.name === 'forms' && t.closest?.('.role-form')) {
      const f = t.closest('.role-form'), arrow = f.querySelector('.pf-arrow'), box = f.querySelector('.perm-forms');
      if (t.value) { box.hidden = false; arrow.classList.add('open'); arrow.setAttribute('aria-expanded', 'true'); }
    }
    if (t.closest?.('.pf-row')) {
      const f = t.closest('.role-form'), sum = f?.querySelector('.pf-count'), rows = [...f.querySelectorAll('.pf-row')];
      if (sum) { const n = rows.filter(r => r.querySelector('input:checked')?.value).length; sum.textContent = n ? `${n} of ${rows.length} forms` : 'No forms'; }
    }
    if (t.id === 'mx-file' && t.files[0]) { setMixAudio(t.files[0]); t.value = ''; }
    if (t.id === 'f-sc') scFill(!editing?.key);
    if (t.classList.contains('log-who')) { logState.who = t.value; logState.items = []; logState.loaded = false; loadLog(false); render(); }
    if (t.classList.contains('color-in') && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, color: t.value }), 'Color guardado');
    if (t.classList.contains('name-in') && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, label: t.value.trim() }), 'Name saved');
    if (t.classList.contains('role-sel') && t.value && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, role_id: t.value }), 'Role changed');
    // Editar o Eliminar llevan Ver; sin Ver no hay nada más
    const pm = t.closest?.('.perm-table') && t.name?.match(/^(.+)\.(view|edit|delete)$/);
    if (pm) {
      const f = t.form, box = n => f.elements[`${pm[1]}.${n}`];
      if (pm[2] !== 'view' && t.checked && box('view')) box('view').checked = true;
      if (pm[2] === 'view' && !t.checked) for (const n of ['edit', 'delete']) if (box(n)) box(n).checked = false;
    }
    if (t.dataset.pick && t.files[0]) { pickFile(t.dataset.pick, t.files[0]); t.value = ''; }
  });
  // Arrastrar y soltar: portada en el editor, archivos en Reproductor/Logo. Fuera de esas zonas no se abre el archivo.
  document.addEventListener('dragover', e => {
    e.preventDefault();
    const z = e.target.closest?.('[data-drop], .card[data-file]');
    e.dataTransfer.dropEffect = z && !busy ? 'copy' : 'none';
    $$('.is-over').forEach(el => el !== z && el.classList.remove('is-over'));
    z?.classList.add('is-over');
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget || !e.currentTarget.contains?.(e.relatedTarget)) $$('.is-over').forEach(el => el.classList.remove('is-over')); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    $$('.is-over').forEach(el => el.classList.remove('is-over'));
    const file = e.dataTransfer?.files?.[0];
    if (!file || busy) return;
    if (e.target.closest?.('[data-drop]')) setCover(file);
    const card = e.target.closest?.('.card[data-file]');
    if (card) pickFile(card.dataset.file, file);
  });
  window.addEventListener('beforeunload', e => { if (isDirty() || busy) e.preventDefault(); });

  /* ---------------- Formularios ---------------- */
  // Los owners los ven todos; el resto, solo los que tengan su rol o su email en «Who can see the responses».
  let formsData = null, formsErr = '', formsLoading = false, formOpen = null;
  const FTYPES = { text: 'Short text', textarea: 'Long text', email: 'Email', url: 'Link', radio: 'Single choice', checkbox: 'Varias opciones', select: 'Dropdown', section: 'Section (title)' };
  const isOwnerNow = () => !!auth?.user?.owner && !preview;
  const visibleForms = () => (formsData?.forms || []).filter(f => !preview || roleFormLevel(preview, f) || f.access?.roles?.includes(preview.id));
  // puede editar este formulario (owner, o su rol tiene «Edit» en él)
  const canEditForm = f => !!f && (preview ? roleFormLevel(preview, f) === 'edit' : (auth?.user?.owner || f.level === 'edit'));
  /* Aviso de respuestas nuevas: número en «Forms» y en cada formulario; se mira cada minuto */
  let unseen = { total: 0, forms: {} };
  // al probar un rol, el aviso cuenta solo lo nuevo de los formularios que ese rol puede ver
  const badgeCount = () => preview ? visibleForms().reduce((a, f) => a + (f.unseen || 0), 0) : unseen.total;
  const ctBadgeCount = () => (preview || !can('contracts') ? 0 : ctNew().length);
  let unseenReady = false;
  let ctSeen = (() => { try { return JSON.parse(localStorage.getItem('hz_ct_seen') || 'null'); } catch { return null; } })(), ctPolled = false;   // la primera vez solo se apunta lo que hay (sin avisos)
  function paintBadge() {
    const n = badgeCount(), b = $('#forms-badge'), k = ctBadgeCount(), cb = $('#ct-badge');
    if (b) { b.hidden = !n; b.innerHTML = `<span class="nb-n${n === 1 ? ' one' : ''}">${n > 99 ? '99+' : n}</span>`; }
    if (cb) { cb.hidden = !k; cb.innerHTML = `<span class="nb-n${k === 1 ? ' one' : ''}">${k > 99 ? '99+' : k}</span>`; }
    const all = n + k;
    document.title = document.title.replace(/^\(\d+\+?\) /, '');
    if (all) document.title = `(${all > 99 ? '99+' : all}) ${document.title}`;
  }
  // la lista de formularios trae sus «nuevas»: el número rojo sale de los mismos datos (siempre coinciden)
  function unseenFromForms() {
    if (!formsData || preview) return;
    const forms = {}; let total = 0;
    for (const f of formsData.forms) if (f.unseen) { forms[f.id] = f.unseen; total += f.unseen; }
    unseen = { total, forms }; paintBadge();
  }
  async function checkUnseen() {
    if (!auth || preview || !showForms()) return;
    try {
      const r = await api('GET', '/api/forms/unseen'), old = unseen;
      const grown = Object.keys(r.forms || {}).filter(id => (r.forms[id] || 0) > ((old.forms || {})[id] || 0));
      const grew = r.total > old.total || grown.length > 0;
      unseen = r;
      paintBadge();
      const first = !unseenReady; unseenReady = true;
      if (!grew || first) return;
      // aviso en pantalla, aunque estés en otra sección
      const names = grown.map(id => formsData?.forms.find(f => f.id === id)?.title).filter(Boolean);
      toast(names.length ? `New response · ${names.join(', ')}` : 'New form response');
      if (!formsData) return;
      // los datos de los formularios (números) se refrescan por detrás, sin «Loading…» ni redibujar (no parpadea)
      const fresh = await api('GET', '/api/forms').catch(() => null);
      if (fresh) { formsData = fresh; unseenFromForms(); }
      if (view !== 'forms') return;
      if (!formOpen) { render(); return; }
      // respuestas de ese formulario abiertas: las nuevas aparecen solas en la lista
      if (formOpen.mode === 'responses' && grown.includes(formOpen.id)) {
        await searchResponses();
        const f = formsData.forms.find(x => x.id === formOpen.id), cnt = document.querySelector('h1 .count');
        if (f && cnt) cnt.textContent = f.total;
        patchResps([]);   // botón «Mark all as seen»
      }
    } catch { /* sin aviso */ }
  }
  setInterval(checkUnseen, 15e3);
  // todo lo demás se pone al día solo (lo que publica otro miembro, la sincronización con SoundCloud, el equipo, el historial)
  let live = null;
  async function checkLive() {
    if (!auth || !repo || busy) return;
    try {
      const r = await api('GET', '/api/live'), old = live; live = r;
      if (!old) return;
      if (r.v !== old.v && !editing && !isDirty()) {
        repo = await loadRepo();
        if (['releases', 'radio', 'playlists', 'player'].includes(view) && !editing && !$('#sheet')?.open) render();
      }
      if (r.audit !== old.audit && view === 'log' && !$('#sheet')?.open) { logState.loaded = false; loadLog(false); }
      if (r.team !== old.team) { teamData = null; if (view === 'team' && !$('#sheet')?.open) loadTeam(); }
    } catch { /* sin aviso */ }
  }
  setInterval(checkLive, 20e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkLive(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUnseen(); });
  const showForms = () => can('forms') || (preview ? visibleForms().length > 0 : auth?.user?.formsCount > 0);
  async function loadForms() {
    if (formsLoading) return;
    formsLoading = true;
    try { formsData = await api('GET', '/api/forms'); formsErr = ''; unseenFromForms(); }
    catch (e) { formsErr = e.message; if (e.status === 401) { formsLoading = false; logout(e.message); return; } }
    formsLoading = false;
    if (view === 'forms') render();
  }
  const publicUrl = f => `${location.origin}/forms/${f.slug}`;
  function formsPage() {
    if (!formsData) {
      if (!formsErr) setTimeout(loadForms, 0);
      return `<div class="head"><div><p class="eyebrow">Forms</p><h1>FORMS</h1></div></div>${formsErr ? `<p class="login-error" role="alert">${esc(formsErr)}</p>` : '<p class="info">Loading…</p>'}`;
    }
    if (formOpen?.mode === 'edit') return formEditor();
    if (formOpen?.mode === 'responses') return formResponses();
    const list = visibleForms(), own = isOwnerNow();
    return `
      <div class="head"><div><p class="eyebrow">Responses and links</p><h1>FORMS <span class="count">${list.length}</span></h1></div>
        ${own ? '<button type="button" class="btn primary" data-act="form-new">+ New form</button>' : ''}</div>
      <p class="info lead">${own ? 'Click a form to see its responses; “Edit” changes it with a live preview of how it looks on the site. Owners drag ⋮⋮ to set the order everyone sees. Each form has its own public link (when open) and can appear as a button in “Send your demo” on the site.' : 'The forms you have access to.'}</p>
      <ol class="list forms-list">${list.length ? list.map((f, i) => `
        <li class="row fm" data-form="${esc(f.id)}" title="See responses">
          ${isOwnerNow() ? `<button type="button" class="grip" aria-label="Drag to reorder ${esc(f.title)}" title="Drag to reorder">${GRIP_SVG}</button>` : '<span></span>'}
          <span class="meta"><b>${esc(f.title)}</b><span>${f.public ? `<a href="${esc(publicUrl(f))}" target="_blank" rel="noopener">/forms/${esc(f.slug)}</a>` : `/forms/${esc(f.slug)}`}</span></span>
          <span class="resp-n"><b>${f.total}</b> ${f.total === 1 ? 'response' : 'responses'}</span>
          ${f.unseen ? `<span class="new-pill">${f.unseen} new</span>` : '<span></span>'}
          <span class="fm-site">${f.on_site ? '<span class="tag">On the site</span>' : ''}</span>
          <span class="fm-state">${isOwnerNow() ? `<button type="button" class="pub-sw${f.public ? ' on' : ''}" data-act="form-public" aria-pressed="${f.public}" title="${f.public ? 'Open: anyone with the link can send it. Click to close it.' : 'Closed: nobody can send it. Click to open it.'}"><span class="pub-knob" aria-hidden="true"></span>${f.public ? 'Open' : 'Closed'}</button>` : f.public ? '<span class="tag">Open</span>' : '<span class="tag off">Closed</span>'}</span>
          <span class="fm-btns"><a class="btn ghost sm${f.public ? '' : ' is-off'}" href="${esc(publicUrl(f))}" target="_blank" rel="noopener" ${f.public ? '' : 'tabindex="-1" aria-hidden="true"'}>View ↗</a><button type="button" class="btn ghost sm" data-act="form-resp">Responses</button>${canEditForm(f) ? '<button type="button" class="btn primary sm" data-act="form-edit">Edit</button>' : ''}</span>
        </li>`).join('') : '<li class="empty">No forms.</li>'}
      </ol>`;
  }
  /* Respuestas */
  async function openResponses(id) {
    formOpen = { mode: 'responses', id, responses: null, more: false, err: '' };
    render();
    try {
      const r = await api('GET', `/api/forms/${encodeURIComponent(id)}/responses`);
      if (formOpen?.id !== id) return;
      formOpen.responses = r.responses; formOpen.more = r.more;
    } catch (e) { if (formOpen) formOpen.err = e.message; }
    if (view === 'forms') render();
  }
  function answerHtml(v) {
    if (Array.isArray(v)) return v.length ? v.map(esc).join('<br>') : '<span class="muted">—</span>';
    if (!v) return '<span class="muted">—</span>';
    return esc(v).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, '<br>');
  }
  function formResponses() {
    const f = formsData.forms.find(x => x.id === formOpen.id);
    if (!f) { formOpen = null; return formsPage(); }
    const qs = f.fields.filter(x => x.type !== 'section'), own = canEditForm(f);
    const rs = formOpen.responses;
    return `
      <button type="button" class="back" data-act="form-back">← Forms</button>
      <div class="head"><div><p class="eyebrow">Responses</p><h1>${esc(f.title)} <span class="count">${f.total}</span></h1></div>
        <div class="head-btns" data-form="${esc(f.id)}">${rs && rs.some(r => !r.seen) && !preview ? '<button type="button" class="btn ghost" data-act="resp-all-seen">Mark all as seen</button>' : ''}${f.invite && !preview ? '<button type="button" class="btn ghost" data-act="form-links">Generate link</button>' : ''}${f.total ? '<button type="button" class="btn ghost" data-act="form-csv">Download (Excel / CSV)</button>' : ''}${canEditForm(f) && !preview ? '<button type="button" class="btn primary" data-act="form-edit">Edit form</button>' : ''}</div></div>
      ${formOpen.err ? `<p class="login-error" role="alert">${esc(formOpen.err)}</p>` : ''}
      ${f.total ? `<div class="resp-search"><input class="search" type="search" id="resp-filter" placeholder="Search by #number, name, track, email…" aria-label="Search responses" value="${esc(formOpen.q || '')}" autocomplete="off"></div>` : ''}
      <div id="resp-list">${respList(f)}</div>`;
  }
  // nombre del artista (y título del track) para la cabecera de cada respuesta
  function respWho(f, r) {
    const qs = f.fields.filter(x => x.type !== 'section'), val = x => (Array.isArray(r.data[x.id]) ? r.data[x.id].join(', ') : String(r.data[x.id] || '')).trim();
    const who = qs.find(x => /artist|team/i.test(x.label) && val(x)) || qs.find(x => /name/i.test(x.label) && val(x));
    const what = qs.find(x => /track|song|title/i.test(x.label) && x !== who && val(x));
    return { who: who ? val(who) : '', what: what ? val(what) : '' };
  }
  // cerradas por defecto (solo nombre y track); se abren con un clic. Si la búsqueda da una sola, se abre sola.
  const respOpen = (r, rs) => formOpen.openIds?.has(r.id) || (rs.length === 1 && !!(formOpen.q || '').trim());
  function respList(f) {
    const qs = f.fields.filter(x => x.type !== 'section'), own = canEditForm(f), rs = formOpen.responses, q = (formOpen.q || '').trim();
    return `${!rs ? '<p class="info">Loading…</p>' : rs.length ? `${q ? `<p class="info">${rs.length}${formOpen.more ? '+' : ''} ${rs.length === 1 ? 'response matches' : 'responses match'} “${esc(q)}”</p>` : ''}<div class="resps">${rs.map(r => respItem(f, r, rs, q, qs, own)).join('')}</div>
        ${formOpen.more ? '<button type="button" class="btn ghost log-more" data-act="resp-more">Show more</button>' : ''}` : `<p class="info">${q ? `Nothing matches “${esc(q)}”.` : 'No responses yet.'}</p>`}`;
  }
  function respItem(f, r, rs, q, qs, own) {
    return `
        <article class="resp${r.seen ? '' : ' is-new'}${respOpen(r, rs) ? ' is-open' : ''}" data-resp="${r.id}">
          <header data-act="resp-toggle" title="Show / hide the answers"><span class="resp-num">#${r.n || ''}</span>${(() => { const w = respWho(f, r); return w.who ? `<span class="resp-who"><b>${mark(esc(w.who), q)}</b>${w.what ? `<span>${mark(esc(w.what), q)}</span>` : ''}</span>` : ''; })()}${r.seen ? '' : '<span class="new-pill">New</span>'}<span class="resp-date">${esc(fmtDate(r.at))}</span>
            <span class="resp-btns">${preview ? '' : r.seen ? '<button type="button" class="btn ghost sm" data-act="resp-unseen">Mark as new</button>' : '<button type="button" class="btn primary sm" data-act="resp-seen">Mark as seen</button>'}${own ? '<button type="button" class="btn ghost sm" data-act="resp-del">Delete</button>' : ''}</span></header>
          ${respOpen(r, rs) ? `<dl>${qs.map(x => `<dt>${esc(x.label)}</dt><dd>${mark(answerHtml(r.data[x.id]), q)}</dd>`).join('')}</dl>` : ''}
        </article>`;
  }
  // cambia solo esas respuestas y el botón «Mark all as seen» (sin redibujar la página: no parpadea)
  function patchResps(ids) {
    const f = formsData?.forms.find(x => x.id === formOpen?.id), rs = formOpen?.responses;
    if (!f || !rs) return;
    const qs = f.fields.filter(x => x.type !== 'section'), own = canEditForm(f), q = (formOpen.q || '').trim();
    for (const r of rs) if (ids.includes(r.id)) { const el = document.querySelector(`.resp[data-resp="${r.id}"]`); if (el) el.outerHTML = respItem(f, r, rs, q, qs, own).trim(); }
    const hb = document.querySelector('.head-btns[data-form]'), allBtn = hb?.querySelector('[data-act="resp-all-seen"]'), need = rs.some(r => !r.seen) && !preview;
    if (hb && need && !allBtn) hb.insertAdjacentHTML('afterbegin', '<button type="button" class="btn ghost" data-act="resp-all-seen">Mark all as seen</button>');
    if (allBtn && !need) allBtn.remove();
  }
  // resalta lo buscado dentro de las respuestas (sin tocar las etiquetas HTML)
  function mark(html, q) {
    if (!q) return html;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return html.replace(/(^|>)([^<]+)/g, (m, a, txt) => a + txt.replace(re, s => `<mark>${s}</mark>`));
  }
  // buscar en las respuestas (en el servidor: también las que aún no se han cargado)
  let respTimer = 0;
  async function searchResponses() {
    const id = formOpen?.id, q = (formOpen?.q || '').trim();
    try {
      const r = await api('GET', `/api/forms/${encodeURIComponent(id)}/responses${q ? '?q=' + encodeURIComponent(q) : ''}`);
      if (formOpen?.id !== id || (formOpen.q || '').trim() !== q) return;
      formOpen.responses = r.responses; formOpen.more = r.more;
      const f = formsData.forms.find(x => x.id === id), box = $('#resp-list');
      if (f && box) box.innerHTML = respList(f);
    } catch (err) { toast(err.message); }
  }
  /* Editor (owners) */
  function openEditor(f) {
    formOpen = { mode: 'edit', id: f?.id || null, draft: f ? JSON.parse(JSON.stringify({ title: f.title, slug: f.slug, description: f.description, public: f.public, on_site: f.on_site, button: f.button, access: f.access || { roles: [], emails: [] }, fields: f.fields }))
      : { title: '', slug: '', description: '', public: false, on_site: false, button: '', access: { roles: [], emails: [] }, fields: [{ id: 'q1', type: 'text', label: '', help: '', required: true }] } };
    if (!teamData && isOwnerNow()) loadTeam().then(() => view === 'forms' && formOpen?.mode === 'edit' && (syncDraft(), render()));
    render();
    $('#fe-title')?.focus();
  }
  function syncDraft() {
    const f = $('#form-ed'), d = formOpen?.draft;
    if (!f || !d) return;
    d.title = f.elements.title.value; d.slug = f.elements.slug.value.trim().toLowerCase(); d.description = f.elements.description.value;
    if (f.elements.public) d.public = f.elements.public.checked;   // solo owners
    if (f.elements.on_site) { d.on_site = f.elements.on_site.checked; d.button = f.elements.button.value; }   // solo owners
    d.access = { roles: [], emails: $$('input[name="acc-email"]:checked', f).map(i => i.value) };
    d.fields = $$('.qe', f).map(q => {
      const type = q.querySelector('[name=type]').value;
      const x = { id: q.dataset.id, type, label: q.querySelector('[name=label]').value, help: q.querySelector('[name=help]').value };
      if (type !== 'section') x.required = q.querySelector('[name=required]')?.checked ?? false;
      if (['radio', 'checkbox', 'select'].includes(type)) {
        x.options = (q.querySelector('[name=options]')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
        x.other = !!q.querySelector('[name=other]')?.checked;
      }
      return x;
    });
  }
  function questionEditor(x, i, n) {
    const choice = ['radio', 'checkbox', 'select'].includes(x.type);
    return `
      <div class="qe${x.type === 'section' ? ' is-sec' : ''}" data-id="${esc(x.id)}">
        <div class="qe-top">
          <select name="type" aria-label="Question type">${Object.entries(FTYPES).map(([k, v]) => `<option value="${k}" ${k === x.type ? 'selected' : ''}>${v}</option>`).join('')}</select>
          ${x.type === 'section' ? '' : `<label class="check sm"><input type="checkbox" name="required" ${x.required ? 'checked' : ''}><span>Required</span></label>`}
          <span class="qe-btns"><button type="button" class="ic" data-act="q-up" aria-label="Move up" ${i ? '' : 'disabled'}>▲</button><button type="button" class="ic" data-act="q-down" aria-label="Move down" ${i < n - 1 ? '' : 'disabled'}>▼</button><button type="button" class="ic danger" data-act="q-del" aria-label="Remove question">✕</button></span>
        </div>
        <input name="label" value="${esc(x.label)}" placeholder="${x.type === 'section' ? 'Section title' : 'Question'}" maxlength="300" aria-label="Question text">
        <input name="help" value="${esc(x.help || '')}" placeholder="Help text (optional)" maxlength="600" aria-label="Help text">
        ${choice ? `<textarea name="options" rows="${Math.max(2, (x.options || []).length)}" placeholder="One option per line" aria-label="Options">${esc((x.options || []).join('\n'))}</textarea>
          ${x.type !== 'select' ? `<label class="check sm"><input type="checkbox" name="other" ${x.other ? 'checked' : ''}><span>Add an “Other” option with free text</span></label>` : ''}` : ''}
      </div>`;
  }
  function formEditor() {
    const d = formOpen.draft, isNew = !formOpen.id;
    const roles = teamData?.roles || [], members = teamData?.members || [];
    return `
      <form id="form-ed" class="editor fe" novalidate>
        <button type="button" class="back" data-act="form-back">← Forms</button>
        <h1>${isNew ? 'NEW FORM' : esc(d.title || 'Form')}</h1>
        <div class="fe-grid">
          <div class="fe-main">
            <div class="field"><label for="fe-title">Title</label><input id="fe-title" name="title" value="${esc(d.title)}" maxlength="140" autocomplete="off"></div>
            <div class="field"><label for="fe-slug">Link</label><div class="slug-row"><span>${esc(location.host)}/forms/</span><input id="fe-slug" name="slug" value="${esc(d.slug)}" maxlength="60" placeholder="demo-submission" autocomplete="off" spellcheck="false"></div></div>
            <div class="field"><label for="fe-desc">Description</label><textarea id="fe-desc" name="description" rows="4" maxlength="4000">${esc(d.description || '')}</textarea></div>
          <div class="fe-side">
              <div class="fe-box">
                ${isOwnerNow() ? `<label class="switch"><input type="checkbox" name="public" ${d.public ? 'checked' : ''}><span></span><b>Public link</b></label>
                <p class="info">Open: anyone with the link can fill it in. Closed: nobody can send responses.</p>` : `<p class="badges">${d.public ? '<span class="tag">Open</span>' : '<span class="tag off">Closed</span>'}</p>`}
                ${!isNew && d.public ? `<p class="copy-row"><a href="${esc(publicUrl(d))}" target="_blank" rel="noopener">${esc(publicUrl(d).replace(/^https?:\/\//, ''))}</a> <button type="button" class="btn ghost sm" data-act="copy-link">Copy</button></p>` : ''}
                ${isOwnerNow() ? `<label class="switch"><input type="checkbox" name="on_site" ${d.on_site ? 'checked' : ''}><span></span><b>On the site</b></label>
                <p class="info">Shows as a button in “Send your demo” on the homepage (it has to be open).</p>
                <div class="field"><label for="fe-btn">Button text</label><input id="fe-btn" name="button" value="${esc(d.button || '')}" maxlength="60" placeholder="Submit via Form" autocomplete="off"></div>`
                  : `<p class="info">${d.on_site ? 'It shows on the homepage. ' : ''}Only owners can open or close a form and put it on horizonrcrds.com.</p>`}
              </div>
              ${isOwnerNow() ? `<div class="fe-box">
                <b class="fe-h">Who sees the responses</b>
                <p class="info">Owners always. Tap the people who also see them:</p>
                ${!teamData ? '<p class="info">Loading team…</p>' : members.length ? `<div class="who-chips">${members.map(m => { const on = d.access.emails.includes(m.email) || d.access.roles.includes(m.role_id), nm = m.label || m.name || m.email.split('@')[0]; return `
                  <label class="who-chip" style="--c:${esc(m.color || '#ffffff')}"><input type="checkbox" name="acc-email" value="${esc(m.email)}" ${on ? 'checked' : ''}>${avatar(m.picture, nm, m.color)}<span>${esc(nm)}</span></label>`; }).join('')}</div>` : '<p class="info">No team yet.</p>'}
              </div>` : ''}
            </div>
            <p class="group">Questions</p>
            <div class="qes">${d.fields.map((x, i) => questionEditor(x, i, d.fields.length)).join('')}</div>
            <div class="card-actions"><button type="button" class="btn ghost sm" data-act="q-add">+ Question</button><button type="button" class="btn ghost sm" data-act="q-sec">+ Section</button></div>
            <p class="ed-error" id="ed-error" role="alert" hidden></p>
            <div class="ed-actions fe-actions">
              <button type="submit" class="btn primary">${isNew ? 'Create form' : 'Save changes'}</button>
              <button type="button" class="btn ghost" data-act="form-back">Cancel</button>
              ${isNew || !isOwnerNow() ? '' : '<button type="button" class="btn danger push" data-act="form-del">Delete form</button>'}
            </div>
          </div>
          <aside class="fe-prev">
            <div class="prev-head"><b>Preview</b><span class="seg prev-size" role="radiogroup" aria-label="Preview size"><label><input type="radio" name="prev-size" value="desktop" ${prevSize === 'desktop' ? 'checked' : ''}><span>Desktop</span></label><label><input type="radio" name="prev-size" value="phone" ${prevSize === 'phone' ? 'checked' : ''}><span>Phone</span></label></span><span class="muted sm-txt">How people see it on the site${d.public ? '' : ' (closed right now)'}</span>${!isNew && d.public ? `<a class="btn ghost sm" href="${esc(publicUrl(d))}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>
            <div class="prev-stage"><iframe id="fe-prev" src="/form?preview=1" title="Form preview"></iframe></div>
          </aside>
        </div>
      </form>`;
  }
  // vista previa en vivo: se manda el borrador a la página real del formulario (iframe)
  let prevTimer = 0, prevSize = 'desktop';
  // la vista previa se dibuja al ancho real (escritorio 1280 px o móvil 390 px) y se escala para caber
  function fitPreview() {
    const st = $('.prev-stage'), fr = $('#fe-prev');
    if (!st || !fr) return;
    const W = prevSize === 'phone' ? 390 : 1280, k = Math.min(1, st.clientWidth / W);
    fr.style.width = W + 'px'; fr.style.height = (st.clientHeight / k) + 'px';
    fr.style.transform = `scale(${k})`;
    fr.style.left = prevSize === 'phone' ? `${Math.max(0, (st.clientWidth - W * k) / 2)}px` : '0';
  }
  window.addEventListener('resize', fitPreview);
  document.addEventListener('change', e => { if (e.target.name === 'prev-size') { prevSize = e.target.value; fitPreview(); } });
  new MutationObserver(() => { if ($('.prev-stage') && !$('.prev-stage').dataset.fit) { $('.prev-stage').dataset.fit = 1; fitPreview(); } }).observe(document.body, { childList: true, subtree: true });
  function sendPreview(focus) {
    const fr = $('#fe-prev'), d = formOpen?.draft;
    if (!fr?.contentWindow || !d) return;
    fr.contentWindow.postMessage({ type: 'hz-form', form: { title: d.title, description: d.description, public: d.public, fields: d.fields }, focus }, location.origin);
  }
  window.addEventListener('message', e => { if (e.origin === location.origin && e.data?.type === 'hz-form-ready' && view === 'forms' && formOpen?.mode === 'edit') sendPreview(); });
  document.addEventListener('input', e => {
    if (view !== 'forms' || formOpen?.mode !== 'edit' || !e.target.closest('#form-ed')) return;
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => { syncDraft(); sendPreview(e.target.closest('.qe')?.dataset.id); }, 150);
  });
  document.addEventListener('focusin', e => { const q = view === 'forms' && e.target.closest?.('#form-ed .qe'); if (q) sendPreview(q.dataset.id); });
  /* Enlaces personales de un formulario privado (Release Form): cada enlace es para una persona, vale para un solo
     envío, solo en el primer dispositivo que lo abre y durante 30 días */
  const LINK_STATE = { unused: ['Not opened yet', 'off'], opened: ['Opened', ''], sent: ['Sent', 'ok'], expired: ['Expired', 'off'] };
  async function linksSheet(f, made = null) {
    const d = sheet(`<h2 class="sheet-t">Personal link · ${esc(f.title)}</h2>
      <p class="info">Each link is for one artist: it only works on the first device that opens it, only to send the form once, and for 30 days.</p>
      <form id="link-new" class="link-new" novalidate>
        <input name="note" maxlength="120" placeholder="Who is it for? (e.g. artist name) — optional" aria-label="Who is it for" autocomplete="off">
        <button type="submit" class="btn primary">Generate link</button>
      </form>
      ${made ? `<div class="link-made"><input readonly value="${esc(made.url)}" aria-label="New link"><button type="button" class="btn ghost sm" data-link-copy>Copy</button></div>
        <p class="sm-txt link-ok">Copied. Send it to the artist. It works until ${esc(new Date(made.expires_at).toLocaleDateString('en-GB', { dateStyle: 'long' }))}.</p>` : ''}
      <p class="mini">Recent links</p><ol class="link-list"><li class="muted">Loading…</li></ol>
      <div class="confirm-actions"><button type="button" class="btn ghost" data-link-close>Close</button></div>`);
    d.querySelector('[data-link-close]').onclick = closeSheet;
    d.querySelector('[data-link-copy]')?.addEventListener('click', () => { navigator.clipboard?.writeText(made.url).then(() => toast('Link copied')).catch(() => {}); d.querySelector('.link-made input').select(); });
    d.querySelector('#link-new').onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await api('POST', `/api/forms/${encodeURIComponent(f.id)}/links`, { note: e.target.elements.note.value.trim() });
        try { await navigator.clipboard.writeText(r.url); } catch { /* se copia a mano */ }
        linksSheet(f, r);
      } catch (x) { toast(x.message); btn.disabled = false; }
    };
    try {
      const r = await api('GET', `/api/forms/${encodeURIComponent(f.id)}/links`);
      const ol = d.querySelector('.link-list');
      if (ol) ol.innerHTML = r.links.length ? r.links.map(l => `<li><span><b>${esc(l.note || 'Link')}</b><small>${esc(fmtDate(l.created_at))} · ${esc(l.by || '')}</small></span><span class="tag ${LINK_STATE[l.state]?.[1] || ''}">${LINK_STATE[l.state]?.[0] || l.state}</span></li>`).join('') : '<li class="muted">No links yet.</li>';
    } catch { /* sin lista */ }
  }
  async function formAction(fn, ok) {
    busy = true;
    try { await fn(); if (ok) toast(ok); }
    catch (e) { if (e.status === 401) { busy = false; logout(e.message); return; } const box = $('#ed-error'); if (box) { box.textContent = e.message; box.hidden = false; box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } else toast(e.message); throw e; }
    finally { busy = false; }
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (!t || busy || view !== 'forms') return;
    const id = t.closest('[data-form]')?.dataset.form;
    const act = t.dataset.act;
    if (act === 'form-new') openEditor(null);
    else if (act === 'form-edit') openEditor(formsData.forms.find(f => f.id === id));
    else if (act === 'form-resp') openResponses(id);
    else if (act === 'form-public') {
      // abrir / cerrar el formulario desde la lista (no cambia nada más)
      const f = formsData.forms.find(x => x.id === id), open = !f.public;
      busy = true;
      try {
        await api('POST', '/api/forms', { id: f.id, title: f.title, slug: f.slug, description: f.description, fields: f.fields, public: open, on_site: f.on_site, button: f.button, access: f.access });
        f.public = open; render();
        toast(open ? `${f.title} is open: ${publicUrl(f).replace(/^https?:\/\//, '')}` : `${f.title} is closed`);
      } catch (err) { toast(err.message); }
      finally { busy = false; }
    }
    else if (act === 'form-back') { formOpen = null; render(); loadForms(); }
    else if (act === 'form-up' || act === 'form-down') {
      const ids = formsData.forms.map(f => f.id), i = ids.indexOf(id), j = act === 'form-up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      formsData.forms.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      render();
      try { await formAction(() => api('POST', '/api/forms/order', { ids })); } catch { loadForms(); }
    } else if (act === 'form-links') {
      linksSheet(formsData.forms.find(x => x.id === formOpen.id));
    } else if (act === 'form-csv') {
      const f = formsData.forms.find(x => x.id === formOpen.id);
      try {
        const r = await fetch(`/api/forms/${encodeURIComponent(f.id)}/csv`, { headers: { Authorization: `Bearer ${auth.token}` }, cache: 'no-store' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Could not download.');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `${f.slug}.csv`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (err) { toast(err.message); }
    } else if (act === 'resp-more') {
      const last = formOpen.responses.at(-1)?.id;
      const q = (formOpen.q || '').trim();
      try { const r = await api('GET', `/api/forms/${encodeURIComponent(formOpen.id)}/responses?from=${last}${q ? '&q=' + encodeURIComponent(q) : ''}`); formOpen.responses.push(...r.responses); formOpen.more = r.more; const f = formsData.forms.find(x => x.id === formOpen.id); $('#resp-list').innerHTML = respList(f); } catch (err) { toast(err.message); }
    } else if (act === 'resp-toggle') {
      if (e.target.closest('button, a')) return;
      const rid = Number(t.closest('[data-resp]').dataset.resp);
      formOpen.openIds = formOpen.openIds || new Set();
      if (formOpen.openIds.has(rid)) formOpen.openIds.delete(rid); else formOpen.openIds.add(rid);
      patchResps([rid]);
    } else if (act === 'resp-seen' || act === 'resp-unseen' || act === 'resp-all-seen') {
      const all = act === 'resp-all-seen', seen = act !== 'resp-unseen';
      const ids = all ? formOpen.responses.filter(r => !r.seen).map(r => r.id) : [Number(t.closest('[data-resp]').dataset.resp)];
      if (!ids.length) return;
      const fid = formOpen.id, f = formsData?.forms.find(x => x.id === fid);
      const set = v => { for (const r of formOpen.responses) if (ids.includes(r.id)) r.seen = v; if (f) f.unseen = Math.max(0, (f.unseen || 0) + (v === seen ? 1 : -1) * (seen ? -ids.length : ids.length)); patchResps(ids); };
      set(seen);
      try {
        await Promise.all(ids.map(rid => api('POST', `/api/forms/${encodeURIComponent(fid)}/responses/${rid}`, { seen })));
        // lo cambias tú: se cuenta ya, para que no salte el aviso de «respuesta nueva»
        const d = seen ? -ids.length : ids.length;
        unseen = { total: Math.max(0, unseen.total + d), forms: { ...(unseen.forms || {}), [fid]: Math.max(0, ((unseen.forms || {})[fid] || 0) + d) } };
        checkUnseen();
      }
      catch (err) { if (formOpen?.id === fid) set(!seen); toast(err.message); }
    } else if (act === 'resp-del') {
      const rid = Number(t.closest('[data-resp]').dataset.resp);
      if (!await confirmBox('Delete this response? This can’t be undone.', 'Delete')) return;
      try { await formAction(() => api('DELETE', `/api/forms/${encodeURIComponent(formOpen.id)}/responses/${rid}`), 'Response deleted'); formOpen.responses = formOpen.responses.filter(r => r.id !== rid); const f = formsData.forms.find(x => x.id === formOpen.id); if (f) f.total--; render(); } catch { /* aviso ya mostrado */ }
    } else if (act === 'copy-link') {
      try { await navigator.clipboard.writeText(publicUrl(formOpen.draft)); toast('Link copied'); } catch { toast(publicUrl(formOpen.draft)); }
    } else if (['q-add', 'q-sec', 'q-up', 'q-down', 'q-del'].includes(act)) {
      syncDraft();
      const fs = formOpen.draft.fields, qi = fs.findIndex(x => x.id === t.closest('.qe')?.dataset.id);
      const nid = () => { let k = fs.length + 1; while (fs.some(x => x.id === 'q' + k)) k++; return 'q' + k; };
      if (act === 'q-add') fs.push({ id: nid(), type: 'text', label: '', help: '', required: false });
      if (act === 'q-sec') fs.push({ id: nid(), type: 'section', label: '', help: '' });
      if (act === 'q-del') fs.splice(qi, 1);
      if (act === 'q-up' && qi > 0) [fs[qi - 1], fs[qi]] = [fs[qi], fs[qi - 1]];
      if (act === 'q-down' && qi < fs.length - 1) [fs[qi + 1], fs[qi]] = [fs[qi], fs[qi + 1]];
      render();
      if (act === 'q-add' || act === 'q-sec') $$('.qe').at(-1)?.querySelector('[name=label]')?.focus();
    } else if (act === 'form-del') {
      const f = formsData.forms.find(x => x.id === formOpen.id);
      if (!await confirmBox(`Delete “${f?.title}” and its ${f?.total || 0} responses? This can’t be undone.`, 'Delete')) return;
      try { await formAction(() => api('DELETE', `/api/forms/${encodeURIComponent(formOpen.id)}`), 'Form deleted'); formOpen = null; formsData = null; render(); } catch { /* aviso ya mostrado */ }
    }
  });
  document.addEventListener('change', e => {
    // cambiar el tipo de pregunta redibuja (aparecen o desaparecen las opciones)
    if (view === 'forms' && e.target.matches('.qe [name=type]')) { syncDraft(); render(); }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'form-ed') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (busy) return;
    syncDraft();
    const d = formOpen.draft;
    if (!d.slug && d.title) d.slug = d.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    try {
      const r = await formAction(() => api('POST', '/api/forms', { id: formOpen.id || undefined, ...d }), formOpen.id ? 'Formulario guardado' : 'Formulario creado');
      formOpen = null; formsData = null; render();
    } catch { /* aviso ya mostrado */ }
  }, true);

  /* ---------------- Contratos (PDF exacto del Google Doc) ---------------- */
  // Cada contrato es el PDF descargado del Google Doc del sello, sin tocar. Aquí se sube, se marca dónde firma el
  // artista, se crea el enlace de firma y se guarda/descarga el contrato firmado.
  const CONTRACTS_DOC = 'https://docs.google.com/document/d/1rUCOAySY2XHqnmgFeH9fjF3xgXDa9cg0vy8qWJVN274/edit?authuser=contacthorizonids@gmail.com';
  let ctData = null, ctErr = '', ctLoading = false, ctOpen = null, ctTab = 'contracts';
  const CT_STATUS = { draft: ['Not sent', 'off'], sent: ['Sent', ''], signed: ['Signed', 'ok'], void: ['Cancelled', 'off'] };
  const ctCanEdit = () => !!ctData?.canEdit && can('contracts', 'edit');
  async function loadContracts() {
    if (ctLoading) return;
    ctLoading = true;
    try { ctData = await api('GET', '/api/contracts'); ctErr = ''; paintBadge(); autoDrive(); }
    catch (e) { ctErr = e.message; if (e.status === 401) { ctLoading = false; logout(e.message); return; } }
    ctLoading = false;
    if (view === 'contracts') render();
  }
  async function authFetch(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${auth.token}` }, cache: 'no-store' });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new GhError(j.message || `Error ${r.status}`, r.status); }
    return r;
  }
  const signerUrl = sg => `${location.origin}/sign/${sg.token}`;
  const ctName = c => {
    const kind = c.kind === 'draft' || /draft/i.test(c.title || '') ? 'DRAFT CONTRACT' : /remix/i.test(c.title || '') ? 'REMIX AUTHORIZATION' : 'RELEASE CONTRACT';
    const who = [String(c.artist || '').split(/\s*(?:,|&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean).join(' & '), String(c.release_name || c.vars?.Track || '').trim()].filter(Boolean).join(' - ');
    return `HORIZON RCRDS ${kind}${who ? ' | ' + who : ''}`;
  };
  const pdfName = (c, extra = '') => `${ctName(c).replace(/\|/g, '｜').replace(/[\\/:*?"<>]+/g, '')}${extra}.pdf`;
  // contratos con firmas nuevas (número rojo en «Contracts» hasta que abres ese contrato)
  const ctLast = c => Math.max(0, ...c.signers.map(x => x.signed_at || 0));
  const ctSaveSeen = () => { try { localStorage.setItem('hz_ct_seen', JSON.stringify(ctSeen)); } catch { /* nada */ } };
  function ctNew() {
    if (!ctData) return [];
    if (!ctSeen) { ctSeen = {}; for (const c of ctData.contracts) ctSeen[c.id] = ctLast(c); ctSaveSeen(); }   // la primera vez: lo que ya había no cuenta
    return ctData.contracts.filter(c => !isTpl(c) && ctLast(c) > (ctSeen[c.id] || 0));
  }
  function ctMarkSeen(c) { if (!c || !ctSeen) return; const t = ctLast(c); if (t > (ctSeen[c.id] || 0)) { ctSeen[c.id] = t; ctSaveSeen(); paintBadge(); } }
  // cada 15 s: contratos al día (firmas nuevas → aviso, número y lista sin recargar)
  async function checkContracts() {
    if (!auth || preview || !can('contracts') || busy) return;
    try {
      const r = await api('GET', '/api/contracts'), before = new Map((ctData?.contracts || []).map(c => [c.id, c]));
      const sig = c => `${c.status}|${c.signers.map(x => (x.signed_at || 0) + ':' + (x.emailed_at || 0)).join(',')}|${c.drive_url}|${c.title}`;
      const changed = !ctData || r.contracts.length !== ctData.contracts.length || r.contracts.some(c => !before.get(c.id) || sig(before.get(c.id)) !== sig(c));
      if (ctData) for (const c of r.contracts) {
        const o = before.get(c.id);
        if (o) for (const x of c.signers) if (x.signed_at && !o.signers.find(y => y.id === x.id)?.signed_at) toast(`${x.name || x.label} signed “${c.title}”`);
      }
      if (!changed) { autoDrive(); return; }
      ctData = r; paintBadge(); autoDrive();
      if (view !== 'contracts' || busy) return;
      if (!ctOpen) render();
      else if (ctOpen.mode === 'contract' && ctOpen.contract) {
        const now = r.contracts.find(c => c.id === ctOpen.id), was = before.get(ctOpen.id);
        if (now && was && sig(now) !== sig(was) && !document.activeElement?.closest?.('#ct-ed')) ctRefresh();
      }
    } catch { /* sin aviso */ }
  }
  setInterval(checkContracts, 15e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkContracts(); });
  const isTpl = c => c?.kind === 'template';
  function ctList() {
    const all = ctData.contracts, ed = ctCanEdit(), tab = ctTab, fresh = new Set(ctNew().map(c => c.id));
    const tpls = all.filter(isTpl), list = all.filter(c => !isTpl(c) && c.status !== 'signed'), done = all.filter(c => !isTpl(c) && c.status === 'signed').sort((a, b) => (b.signed_at || 0) - (a.signed_at || 0));
    const noDrive = done.filter(c => !c.drive_url);
    const state = c => isTpl(c) ? (!c.pdf ? 'PDF missing' : !c.doc_url ? 'No Google Doc' : c.signers.some(x => !x.box) ? 'Signatures not placed' : 'Ready')
      : isDraft(c) ? (c.sent_at ? `Sent for review · ${esc(fmtDate(c.sent_at))}` : 'Not sent')
      : c.status === 'signed' ? 'Signed ' + esc(fmtDate(c.signed_at)) + (c.drive_url ? ' · In Drive' : '')
      : c.status === 'void' ? 'Links don’t work' : !c.pdf ? 'PDF missing' : c.signers.some(x => !x.box) ? 'Signatures not placed'
      : c.sent_at ? `Signed ${c.signers.filter(x => x.signed).length} of ${c.signers.length}` : 'Ready to send';
    const row = c => `
        <li class="row ct${fresh.has(c.id) ? ' is-new' : ''}" data-ctid="${esc(c.id)}">
          <span class="meta"><b>${esc(c.title)}</b><span>${isTpl(c) ? `${c.signers.length} signer${c.signers.length > 1 ? 's' : ''}` : (c.release_cat ? esc(c.release_cat) + ' · ' : '') + esc(c.artist || '') + (c.email ? ' · ' + esc(c.email) : '')}</span></span>
          ${isTpl(c) ? '<span class="tag off">Template</span>' : isDraft(c) ? '<span class="tag off">Draft</span>' : `<span class="tag ${CT_STATUS[c.status]?.[1] || ''}">${CT_STATUS[c.status]?.[0] || c.status}</span>`}
          <span class="muted sm-txt">${fresh.has(c.id) ? '<b class="ct-new">New signature</b> · ' : ''}${state(c)}</span>
          <span class="row-btns">${isTpl(c) && ed && c.pdf && (c.doc_url || isDraftTpl(c)) ? '<button type="button" class="btn primary sm" data-ct="use">Use</button>' : ''}${c.drive_url ? `<a class="btn ghost sm" href="${esc(c.drive_url)}" target="_blank" rel="noopener">Drive ↗</a>` : ''}<button type="button" class="btn ghost sm" data-ct="open">Open</button></span>
        </li>`;
    const group = (name, rows, empty) => rows.length || empty ? `<h2 class="ct-group-h">${name} <span>${rows.length}</span></h2><ol class="list">${rows.length ? rows.map(row).join('') : `<li class="empty">${empty}</li>`}</ol>` : '';
    const byNew = (a, b) => (b.sent_at || b.created_at || 0) - (a.sent_at || a.created_at || 0);
    const body = tab === 'activity' ? ctActivityAll() : tab === 'templates' ? `<ol class="list">${tpls.length ? tpls.map(row).join('') : '<li class="empty">No templates yet.</li>'}</ol>`
      : tab === 'signed' ? `<ol class="list">${done.length ? done.map(row).join('') : '<li class="empty">No signed contracts yet.</li>'}</ol>`
      : list.length ? [
        group('Waiting for signatures', list.filter(c => !isDraft(c) && c.status === 'sent').sort(byNew)),
        group('Not sent yet', list.filter(c => !isDraft(c) && c.status === 'draft').sort(byNew)),
        group('Drafts sent for review', list.filter(isDraft).sort(byNew)),
        group('Cancelled', list.filter(c => !isDraft(c) && c.status === 'void').sort(byNew)),
      ].join('') : '<ol class="list"><li class="empty">No contracts waiting.</li></ol>';
    return `
      <div class="head"><div><p class="eyebrow">Signatures</p><h1>CONTRACTS</h1></div>
        <div class="head-btns">${ed ? (tab === 'templates' ? '<button type="button" class="btn primary" data-ct="new-tpl">+ New template</button>' : '<button type="button" class="btn primary" data-ct="new">+ New contract</button>') : ''}</div></div>
      <div class="ct-tabs" role="tablist">
        <button type="button" role="tab" class="${tab === 'contracts' ? 'on' : ''}" data-ct="tab-contracts">Contracts <span>${list.length}</span></button>
        <button type="button" role="tab" class="${tab === 'signed' ? 'on' : ''}" data-ct="tab-signed">Signed <span>${done.length}</span>${done.some(c => fresh.has(c.id)) ? '<i class="ct-dot"></i>' : ''}</button>
        <button type="button" role="tab" class="${tab === 'templates' ? 'on' : ''}" data-ct="tab-templates">Templates <span>${tpls.length}</span></button>
        <button type="button" role="tab" class="${tab === 'activity' ? 'on' : ''}" data-ct="tab-activity">Activity</button>
      </div>
      ${tab === 'signed' ? driveBox(ed, noDrive) : ''}
      ${tab === 'templates' ? `<p class="info lead">Templates are your Google Docs contracts. The panel finds the artist details by itself (names, track, date…), or write a name between double braces in the Doc: <b>{{Nombre real}}</b>, <b>{{Nombre artístico}}</b>, <b>{{Track}}</b>, <b>{{Fecha}}</b>… When you create a contract the panel asks for those details and Google puts them in place (the text reflows by itself).</p>` : ''}
      ${body}`;
  }
  // elegir plantilla para un contrato nuevo
  function ctPick() {
    const tpls = ctData.contracts.filter(c => isTpl(c) && c.pdf && (c.doc_url || isDraftTpl(c)));
    return `
      <div class="editor ct-ed">
        <button type="button" class="back" data-ct="back">← Contracts</button>
        <h1>NEW CONTRACT</h1>
        <p class="info lead">Choose the template:</p>
        <ol class="list">${tpls.length ? tpls.map(c => `
          <li class="row ct" data-ctid="${esc(c.id)}"><span class="meta"><b>${esc(c.title)}</b><span>${c.signers.map(x => esc(x.label)).join(' · ')}</span></span><span></span><span></span>
            <span class="row-btns"><button type="button" class="btn primary sm" data-ct="use">Use</button></span></li>`).join('') : '<li class="empty">No templates ready (with Google Doc and PDF).</li>'}
        </ol>
        <details class="ct-other"><summary>…or upload a finished PDF</summary>${ctNewForm()}</details>
      </div>`;
  }
  function ctNewForm() {
    return `
      <form id="ct-new" class="ct-new" novalidate>
        <div class="field"><label for="ct-title">Title</label><input id="ct-title" name="title" maxlength="160" placeholder="e.g. Release Contract — Artist — Track" autocomplete="off"></div>
        <div class="row2 wide"><div class="field"><label for="ct-artist">Artist</label><input id="ct-artist" name="artist" maxlength="160" autocomplete="off"></div>
          <div class="field"><label for="ct-email">Artist email</label><input id="ct-email" name="email" type="email" maxlength="160" autocomplete="off"></div></div>
        <div class="field"><label for="ct-file">Contract PDF</label><input id="ct-file" name="file" type="file" accept="application/pdf"></div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions"><button type="submit" class="btn primary">Create contract</button></div>
      </form>`;
  }
  function ctNewTpl() {
    return `
      <form id="ct-tpl" class="editor ct-ed" novalidate>
        <button type="button" class="back" data-ct="back">← Templates</button>
        <h1>NEW TEMPLATE</h1>
        <p class="info lead">Create a new tab in your contracts Google Doc with the template text and paste its link here (with the tab open, copy the browser address).</p>
        <div class="field"><label for="tp-title">Template name</label><input id="tp-title" name="title" maxlength="160" placeholder="e.g. Release — 1 artist" autocomplete="off"></div>
        <div class="field"><label for="tp-doc">Google Doc tab link</label><input id="tp-doc" name="doc" placeholder="https://docs.google.com/document/d/…/edit?tab=t.…" spellcheck="false" autocomplete="off"></div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions"><button type="submit" class="btn primary">Create template</button><a class="btn ghost" href="${CONTRACTS_DOC}" target="_blank" rel="noopener">Open the Google Doc ↗</a></div>
      </form>`;
  }
  // rellenar los datos de un contrato nuevo a partir de una plantilla
  const isDraftTpl = t => /draft/i.test(t?.title || '');
  const isDraft = c => c?.kind === 'draft';
  const sendBtn = c => isDraft(c) ? '<button type="button" class="btn primary" data-ct="send">Send for review</button>' : '<button type="button" class="btn primary" data-ct="send" title="Each artist gets an email with their private link to read and sign">Send to sign</button>';
  // cuántos artistas tiene el contrato (firmantes del mismo contrato, o una copia por artista)
  const artistsOf = t => t.signers.length > 1 ? t.signers.length : copiesOf();
  // a qué artista pertenece cada dato («Artist 2 legal name» → 2; en contratos de 1 artista, los datos personales → 1)
  const PERSONAL = /^(artist name|legal name|e-?mail|age|address|city)/i;
  const SMALL = /^(de|del|la|las|los|el|y|e|da|das|do|dos|di|van|von|der|of|the|and)$/i;
  // «nune nunito» → «Nune Nunito», «benito juares, 000111» → «Benito Juares, 000111», «mexico» → «Mexico» (lo que ya va en mayúsculas no se toca)
  const titleCase = v => String(v || '').replace(/\S+/g, (w, at) => at && SMALL.test(w) ? w.toLowerCase() : w.replace(/^(\p{Ll})/u, c => c.toUpperCase()));
  const needsCaps = name => /legal|address|city|country/i.test(name);
  const fieldArtist = (name, n, copies) => { const k = Number((String(name).match(/^artist (\d)/i) || [])[1]) || 0; if (k) return k; if (!PERSONAL.test(name)) return 0; return copies ? 'each' : n === 1 ? 1 : 0; };
  const isCopies = t => t.signers.length === 1 && artistsOf(t) > 1;
  // nombre del campo en el formulario (los «each» van una vez por artista)
  const fieldInput = (i, who, k) => who === 'each' ? `f${i}_${k}` : `f${i}`;
  // el nombre y el email de cada artista se escriben una vez (arriba de su bloque) y van también al contrato
  const isDupField = name => /^artist( \d)? name$|^(artist \d )?e-?mail$/i.test(name);
  const fieldDefault = f => /date/i.test(f.name) && !/original/i.test(f.name) ? today() : /^label (representative|signatory)$/i.test(f.name) ? f.current : '';
  function ctUse() {
    const t = ctOpen.tpl, fields = ctOpen.fields, rf = ctOpen.rf;
    if (isDraftTpl(t)) return `
      <form id="ct-use" class="editor ct-ed ct-draft" novalidate>
        <button type="button" class="back" data-ct="back">← Contracts</button>
        <p class="eyebrow">Contract draft</p>
        <h1>SEND A DRAFT</h1>
        <p class="info lead">The artist gets an email with a private link to read the draft online. They can’t sign it or download it.</p>
        <div class="field"><label for="u-em0">Send it to (email)</label><input id="u-em0" name="em0" type="email" maxlength="160" autocomplete="off" placeholder="artist@email.com"></div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions"><button type="submit" class="btn primary">Send draft</button><button type="button" class="btn ghost" data-ct="back">Cancel</button></div>
      </form>`;
    const n = artistsOf(t), copies = isCopies(t);
    const label = f => esc(f.name.replace(/^Artist \d /i, '').replace(/^./, x => x.toUpperCase()));
    const fieldHtml = (f, i, k = 0) => { const nm = fieldInput(i, fieldArtist(f.name, n, copies), k); return `<div class="field"><label for="u-${nm}">${label(f)}</label><input id="u-${nm}" name="${nm}" maxlength="500" value="${esc(fieldDefault(f))}" autocomplete="off"></div>`; };
    const all = (fields || []).map((f, i) => [f, i, fieldArtist(f.name, n, copies)]);
    const isLabel = f => /^label /i.test(f.name);
    const general = all.filter(([f, , w]) => w === 0 && !isLabel(f)), labelF = all.filter(([f, , w]) => w === 0 && isLabel(f)), mine = k => all.filter(([f, , w]) => (w === k || w === 'each') && !isDupField(f.name));
    const picker = k => rf?.list?.length ? `<div class="field"><label for="u-from${k}">${n > 1 ? 'Fill from this artist’s Release Form' : 'Fill from a Release Form response'}</label><select id="u-from${k}" class="u-from" data-k="${k}"><option value="">Choose a response…</option>${rf.list.map(r => `<option value="${r.id}">${esc(rfLabel(r))}</option>`).join('')}</select></div>` : '';
    const who = k => `<div class="row2 wide"><div class="field"><label for="u-cn${k - 1}">Artist name</label><input id="u-cn${k - 1}" name="cn${k - 1}" maxlength="60" autocomplete="off"></div>
          <div class="field"><label for="u-em${k - 1}">Email (the signing link goes here)</label><input id="u-em${k - 1}" name="em${k - 1}" type="email" maxlength="160" autocomplete="off"></div></div>`;
    const grid = l => l.length ? `<div class="ct-fields">${l.join('')}</div>` : '';
    const head = `
        <button type="button" class="back" data-ct="back">← Contracts</button>
        <p class="eyebrow">New contract · template “${esc(t.title)}”</p>
        <h1>CONTRACT DETAILS</h1>`;
    const release = `
        <div class="row2 wide"><div class="field"><label for="u-cat">Release number</label><input id="u-cat" name="release_cat" maxlength="40" value="${esc(ctOpen.cat || '')}" autocomplete="off"></div>
          <div class="field"><label for="u-rel">Release name</label><input id="u-rel" name="release_name" maxlength="160" autocomplete="off" placeholder="Track title"></div></div>
        <div class="field"><label for="u-title">Contract title</label><input id="u-title" name="title" maxlength="160" value="${esc(t.title)} — " autocomplete="off"></div>`;
    const end = `
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions"><button type="submit" class="btn primary" ${fields ? '' : 'disabled'}>Create contract</button><button type="button" class="btn ghost" data-ct="back">Cancel</button></div>`;
    const reading = !fields ? '<p class="info">Reading the template…</p>' : '';
    // 1 artista: todo seguido, sin recuadros
    if (n === 1) return `
      <form id="ct-use" class="editor ct-ed" novalidate>${head}
        ${picker(1)}
        <h2 class="ct-sub">Release</h2>
        ${release}${reading}${grid(general.map(([f, i]) => fieldHtml(f, i)))}
        ${labelF.length ? `<h2 class="ct-sub">Label</h2>${grid(labelF.map(([f, i]) => fieldHtml(f, i)))}` : ''}
        <h2 class="ct-sub">Artist</h2>
        ${who(1)}${grid(mine(1).map(([f, i]) => fieldHtml(f, i, 1)))}
        ${t.signers.length === 1 ? '<div class="copy-btns"><button type="button" class="btn ghost sm" data-ct="copy-add">+ Add artist (own copy)</button></div>' : ''}
        ${fields ? '<p class="info">Everything goes into the contract in every place it appears. A field left empty keeps what the template says.</p>' : ''}${end}
      </form>`;
    // varios artistas: un recuadro por artista con su Release Form, su nombre, su email y sus datos
    return `
      <form id="ct-use" class="editor ct-ed" novalidate>${head}
        <h2 class="ct-sub">Release</h2>
        ${release}${reading}${grid(general.map(([f, i]) => fieldHtml(f, i)))}
        ${labelF.length ? `<h2 class="ct-sub">Label</h2>${grid(labelF.map(([f, i]) => fieldHtml(f, i)))}` : ''}
        <h2 class="ct-sub">Artists · ${copies ? 'each one gets their own copy, with their own details, and signs it' : 'all of them sign this contract'}</h2>
        ${Array.from({ length: n }, (_, x) => `
        <fieldset class="ct-artist">
          <legend>Artist ${x + 1}</legend>
          ${picker(x + 1)}${who(x + 1)}${grid(mine(x + 1).map(([f, i]) => fieldHtml(f, i, x + 1)))}
        </fieldset>`).join('')}
        ${t.signers.length === 1 ? '<div class="copy-btns"><button type="button" class="btn ghost sm" data-ct="copy-add">+ Add artist (own copy)</button><button type="button" class="btn ghost sm" data-ct="copy-del">Remove last</button></div>' : ''}
        ${fields ? '<p class="info">Everything goes into the contract in every place it appears. A field left empty keeps what the template says.</p>' : ''}${end}
      </form>`;
  }
  /* Un contrato, una copia por artista (p. ej. «3 Artists»): mismos datos, cada uno firma la suya */
  const copiesOf = () => ctOpen?.copies || Number((String(ctOpen?.tpl?.title || '').match(/(\d+)\s*artists/i) || [])[1]) || 1;
  const today = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };
  /* Release Form → datos del contrato (nombres artísticos, nombres reales, email, país, track) */
  const RF_KEYS = { artist: /^artist name/i, legal: /^legal full name/i, email: /^contact email/i, country: /^country/i, track: /^track title/i, age: /^(age\b|date of birth|birth)/i, address: /address/i, city: /^city/i };
  function rfRead(r) {
    const o = {};
    for (const f of ctOpen.rf.fields) for (const [k, re] of Object.entries(RF_KEYS)) if (re.test(f.label || '') && !o[k]) o[k] = String(r.data?.[f.id] ?? '').trim();
    return o;
  }
  const rfLabel = r => { const o = rfRead(r); return `#${r.n} · ${o.artist || '—'} — ${o.track || '—'} · ${new Date(r.at).toLocaleDateString('en-GB')}`; };
  const splitNames = v => String(v || '').split(/\s*(?:,|&|\/|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
  async function rfLoad() {
    try {
      const fs = await api('GET', '/api/forms');
      const forms = (fs.forms || []).filter(f => /^release-form/.test(f.slug));
      if (!forms.length) return;
      const lists = await Promise.all(forms.map(f => api('GET', `/api/forms/${encodeURIComponent(f.id)}/responses`).then(r => r.responses).catch(() => [])));
      if (ctOpen?.mode !== 'use') return;
      ctOpen.rf = { fields: forms.flatMap(f => f.fields || []), list: lists.flat().sort((a, b) => b.at - a.at).slice(0, 100) };
      const keep = ctFormValues();
      render(); ctFormRestore(keep);
    } catch { /* sin acceso a formularios: se rellena a mano */ }
  }
  const ctFormValues = () => { const f = $('#ct-use'); return f ? [...f.elements].filter(x => x.name).map(x => [x.name, x.value]) : []; };
  const ctFormRestore = vals => { const f = $('#ct-use'); if (f) for (const [n, v] of vals) if (f.elements[n] && n !== 'from') f.elements[n].value = v; };
  // la respuesta del Release Form de un artista → sus datos (bloque «Artist k») y los del release si faltan
  function rfFill(k, id) {
    const r = ctOpen.rf?.list.find(x => String(x.id) === String(id)), f = $('#ct-use');
    if (!r || !f) return;
    const o = rfRead(r), n = artistsOf(ctOpen.tpl), copies = isCopies(ctOpen.tpl);
    const set = (name, v, force) => { const el = f.elements[name]; if (el && v && (force || !el.value.trim() || /—\s*$/.test(el.value))) el.value = v; };
    set('cn' + (k - 1), o.artist, true); set('em' + (k - 1), o.email, true); set('release_name', o.track);
    (ctOpen.fields || []).forEach((x, i) => {
      const nm = x.name.toLowerCase(), who = fieldArtist(x.name, n, copies), el = f.elements[fieldInput(i, who, k)];
      if (!el) return;
      if (who === k || who === 'each') {
        const v = /legal/.test(nm) ? o.legal : /e-?mail/.test(nm) ? o.email : /\bage\b/.test(nm) ? o.age : /address/.test(nm) ? o.address
          : /city/.test(nm) ? [o.city, o.country].filter(Boolean).join(', ') : /country/.test(nm) ? o.country : /name/.test(nm) ? o.artist : undefined;
        if (v !== undefined) el.value = needsCaps(x.name) ? titleCase(v || '') : v || '';
      } else if (!who && /^track$/.test(nm) && !el.value.trim()) el.value = o.track || '';
    });
    const names = Array.from({ length: n }, (_, i) => (f.elements['cn' + i]?.value || '').trim()).filter(Boolean);
    const track = f.elements.release_name.value.trim();
    if (names.length && track) f.elements.title.value = `${ctOpen.tpl.title} — ${names.join(' & ')} — ${track}`;
    toast(`Artist ${k}: details filled from the Release Form — check them`);
  }
  function ctDetail() {
    const c = ctOpen.contract;
    if (!c) return '<p class="info">Loading…</p>';
    const ed = ctCanEdit(), signed = c.status === 'signed', st = CT_STATUS[c.status] || [c.status, ''], tpl = isTpl(c);
    const vars = Object.entries(c.vars || {});
    return `
      <form id="ct-ed" class="editor ct-ed" novalidate>
        <button type="button" class="back" data-ct="back">← ${tpl ? 'Templates' : 'Contracts'}</button>
        <div class="head"><div><p class="eyebrow">${tpl ? 'Template' : 'Contract'}</p><h1>${esc(c.title)}</h1></div>${tpl ? (ed && c.pdf && c.doc_url ? '<button type="button" class="btn primary" data-ct="use">Create contract from this template</button>' : '') : `<span class="tag big ${st[1]}">${st[0]}</span>`}</div>
        ${tpl || isDraft(c) ? '' : ctSteps(c)}
        ${!signed && ed ? `
          <div class="row2 wide"><div class="field"><label for="c-title">${tpl ? 'Template name' : 'Title'}</label><input id="c-title" name="title" value="${esc(c.title)}" maxlength="160" autocomplete="off"></div>
            ${tpl ? '' : `<div class="field"><label for="c-artist">Artist</label><input id="c-artist" name="artist" value="${esc(c.artist)}" maxlength="160" autocomplete="off"></div>`}</div>
          ` : ''}
        ${!tpl && ed ? `<div class="row2 wide"><div class="field"><label for="c-cat">Release number</label><input id="c-cat" name="release_cat" value="${esc(c.release_cat)}" maxlength="40" autocomplete="off"></div>
            <div class="field"><label for="c-rel">Release name</label><input id="c-rel" name="release_name" value="${esc(c.release_name)}" maxlength="160" autocomplete="off"></div></div>
          <p class="info sm-txt ct-help">Release number and name are only used to file the signed contract in Drive: Year → Release number - Name.</p>` : ''}
        ${signed && !tpl ? ctDoneBlock(c, ed) : ''}
        ${!tpl && vars.length ? ctDataBlock(vars) : ''}
        ${docBlock(c, ed && !signed)}
        ${c.pdf ? signersBlock(c, ed && !signed) : ''}
        ${tpl ? '' : ctActivity(ctOpen.events)}
        ${c.pdf ? `
          <div class="pdf-viewer" id="pdf-viewer"><p class="info">Loading PDF…</p></div>` : `<p class="ct-step">Upload the contract PDF (downloaded from Google Docs).</p>`}
        <div class="field" style="margin-top:18px"><label for="c-notes">Internal notes (the artist can’t see them)</label><textarea id="c-notes" name="notes" rows="2" maxlength="2000" ${ed ? '' : 'readonly'}>${esc(c.notes)}</textarea></div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          ${ed ? '<button type="submit" class="btn primary">Save changes</button>' : ''}
          ${!tpl && ed && !signed && c.status !== 'void' && c.pdf && (isDraft(c) || c.signers.every(x => x.box)) && c.signers.some(x => !x.emailed_at && !x.signed) ? sendBtn(c) : ''}
          ${c.signers.some(x => x.signed) && !(signed && c.file && !c.signed_pdf) ? `<button type="button" class="btn ghost" data-ct="dl-signed">${signed ? 'Download signed PDF' : 'Download PDF (signatures so far)'}</button>` : c.pdf ? '<button type="button" class="btn ghost" data-ct="dl-orig">Download PDF</button>' : ''}
          ${!tpl && signed && ed ? (c.drive_url ? `<a class="btn ghost" href="${esc(c.drive_url)}" target="_blank" rel="noopener">Open in Drive ↗</a>` : '<button type="button" class="btn ghost" data-ct="drive-one" title="Saves the signed PDF in Drive: Year → Release number - Name">Save to Drive</button>') : ''}
          ${ctMoreMenu(c, ed, signed, tpl)}
        </div>
        ${ed && !signed ? '<input type="file" id="ct-pdf" class="sr-only" accept="application/pdf">' : ''}
        ${!tpl && ed && !signed ? '<input type="file" id="ct-arch" class="sr-only" accept="application/pdf">' : ''}
      </form>`;
  }
  // en qué punto está el contrato
  function ctSteps(c) {
    const n = c.signers.length, done = c.signers.filter(x => x.signed).length, sent = !!c.sent_at || c.signers.some(x => x.emailed_at), signed = c.status === 'signed';
    const at = signed ? (c.drive_url ? 5 : 4) : sent ? 3 : 1;
    const steps = ['Details', 'Send to sign', 'Signed', 'Saved in Drive'];
    const note = c.status === 'void' ? 'Cancelled: the signing links don’t work. Reactivate it from “More”.'
      : signed ? (c.drive_url ? 'Done: signed by everyone and saved in Drive. It is in Contracts → Signed.' : 'Signed by everyone. It is in Contracts → Signed. Press “Save to Drive” to keep a copy in your Drive.')
      : sent ? `Waiting for signatures: ${done} of ${n} signed. When everyone signs, it moves to Contracts → Signed and each artist gets their copy by email.`
      : 'Check the details and where each artist signs (the boxes on the document), then press “Send to sign”: each artist gets an email with their private link.';
    return `<ol class="ct-steps">${steps.map((t, i) => `<li class="${i + 1 < at ? 'done' : i + 1 === at ? 'on' : ''}"><button type="button" data-ct="step" data-step="${i + 1}"><span>${i + 1 < at ? '✓' : i + 1}</span>${t}</button></li>`).join('')}</ol>
      <p class="info ct-steps-note">${note}</p>`;
  }
  // Contracts → Activity: lo que hacen los artistas en todos los contratos (abrir, leer, firmar, descargar)
  let ctAct = null;
  const evWhat = e => e.replace(/^opened$/, 'Opened').replace(/^read to the end$/, 'Read it to the end').replace(/^signed as (.+)$/, 'Signed as $1')
    .replace(/^downloaded the signed PDF$/, 'Downloaded the signed PDF').replace(/^downloaded the PDF$/, 'Downloaded the PDF').replace(/^code sent$/, 'Asked for a code');
  function ctActivityAll() {
    if (!ctAct) { api('GET', '/api/contracts/activity').then(r => { ctAct = r.events; if (view === 'contracts' && !ctOpen && ctTab === 'activity') render(); }).catch(e => toast(e.message)); return '<p class="info">Loading…</p>'; }
    if (!ctAct.length) return '<ol class="list"><li class="empty">Nothing yet. When an artist opens their link, reads, signs or downloads a contract, it shows here.</li></ol>';
    return `<div class="ct-log ct-log-all"><ol>${ctAct.map(e => `<li><time>${esc(fmtDate(e.at))}</time><b>${esc(e.label || e.email || 'Artist')}</b><span>${esc(evWhat(e.event))} · <button type="button" class="link" data-ct="act-open" data-id="${esc(e.contract_id)}">${esc(e.title ? ctName(e) : 'Deleted contract')}</button></span></li>`).join('')}</ol></div>`;
  }
  // lo que hace cada artista con su enlace (abrir, leer, firmar, descargar)
  function ctActivity(evs) {
    if (!evs) return '';
    const what = e => e.replace(/^opened$/, 'Opened the contract').replace(/^code sent$/, 'Asked for the access code').replace(/^read to the end$/, 'Read it to the end')
      .replace(/^signed as (.+)$/, 'Signed as $1').replace(/^signed$/, 'Signed').replace(/^downloaded the PDF$/, 'Downloaded the PDF').replace(/^downloaded the signed PDF$/, 'Downloaded the signed PDF');
    const dev = ua => /iphone|ipad/i.test(ua) ? 'iPhone/iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : '';
    return `<div class="ct-log"><div class="signers-head"><b>Activity</b><span class="muted">What each artist does with their link.</span></div>
      ${evs.length ? `<ol>${evs.map(e => `<li><time>${esc(fmtDate(e.at))}</time><b>${esc(e.label || e.email || 'Artist')}</b><span>${esc(what(e.event))}</span><span class="muted">${esc([dev(e.ua || ''), e.ip].filter(Boolean).join(' · '))}</span></li>`).join('')}</ol>`
        : '<p class="info">Nothing yet. When an artist opens their link, reads, signs or downloads the contract, it shows here.</p>'}</div>`;
  }
  function ctDoneBlock(c, ed) {
    const online = c.signers.length && c.signers.every(x => x.signed), mailOk = !!c.done_mail_at;
    if (!online && !c.file) return '';
    return `
      <div class="ct-step done ct-done">
        <span>${online ? `Signed by everyone · ${mailOk ? `download link emailed to ${c.signers.length > 1 ? 'each signer' : 'the artist'}` : 'signed copy not emailed yet'}` : 'Signed outside the site'}${c.drive_url ? ' · saved in Drive' : ''}</span>
        <span class="docbox-btns">
          ${ed && online && !mailOk ? `<button type="button" class="btn ghost sm" data-ct="finish">${c.finish_error ? 'Try again' : 'Send now'}</button>` : ''}
          ${c.drive_url ? `<a class="btn ghost sm" href="${esc(c.drive_url)}" target="_blank" rel="noopener">Open in Drive ↗</a>` : ed ? '<button type="button" class="btn ghost sm" data-ct="drive-one">Save to Drive</button>' : ''}
        </span>
      </div>
      ${c.finish_error ? `<p class="login-error" role="alert">${esc(c.finish_error)}</p>` : ''}`;
  }
  /* Google Drive: carpeta raíz (donde están las de cada año) → Año → «HRZ#xxx - Nombre» → PDF firmado */
  let ctDrive = null, ctDriveReady = false;
  const ctDriveLoad = async () => { const r = await api('GET', '/api/contracts/settings').catch(() => ({})); ctDrive = r.drive_folder || ''; ctDriveReady = !!r.ready; };
  const driveId = u => (String(u).match(/(?:folders\/|[?&]id=)([\w-]{10,})/) || String(u).match(/^([\w-]{10,})$/) || [])[1] || '';
  function driveBox(ed, pending) {
    if (!isOwnerNow()) return '';   // la carpeta de Drive solo la ven y cambian los owners
    if (ctDrive === null) { ctDriveLoad().then(() => { if (view === 'contracts' && !ctOpen && ctTab === 'signed') render(); }); return ''; }
    return `
      <div class="docbox">
        <div class="docbox-head">
          <b>Google Drive</b>
          <input class="drive-url" value="${ctDrive ? esc(`https://drive.google.com/drive/folders/${ctDrive}`) : ''}" placeholder="Link of the Drive folder that holds the year folders" aria-label="Drive folder link" spellcheck="false">
          <span class="docbox-btns">
            ${ctDrive ? `<a class="btn ghost sm" href="https://drive.google.com/drive/folders/${esc(ctDrive)}?authuser=contacthorizonids@gmail.com" target="_blank" rel="noopener">Open ↗</a>` : ''}
            ${ctDrive && pending.length ? `<button type="button" class="btn primary sm" data-ct="drive-all">Save ${pending.length} to Drive</button>` : ''}
          </span>
        </div>
        <p class="info">${!ctDrive ? 'Paste the link of your contracts folder in Drive. Each signed contract goes to <b>Year → Release number - Name</b> (the folders are created if they don’t exist).' : pending.length ? `${pending.length} signed contract${pending.length > 1 ? 's are' : ' is'} not in Drive yet.` : 'All signed contracts are in Drive.'}</p>
      </div>`;
  }
  async function ensureSigned(c, orig) {
    if (c.signed_pdf || !c.signers.length || !c.signers.every(x => x.signed)) return;
    if (!c.signers[0].signature) c = (await api('GET', `/api/contracts/${encodeURIComponent(c.id)}`)).contract;
    const bytes = orig || new Uint8Array(await (await authFetch(`/api/contracts/${encodeURIComponent(c.id)}/pdf`)).arrayBuffer());
    const out = await HZPDF.signed(bytes, { title: ctName(c), hash: c.pdf_hash,
      signers: c.signers.map(x => ({ label: x.label, box: x.box, signed: { name: x.name, email: x.signer_email, at: x.signed_at, ip: x.ip, ua: x.ua, signature: x.signature, hash: c.pdf_hash } })) });
    await authFetch(`/api/contracts/${encodeURIComponent(c.id)}/signed`, { method: 'POST', body: out });
    c.signed_pdf = true;
  }
  // en cuanto firman todos, el contrato se guarda solo en Drive (con el panel abierto por alguien que puede editar contratos)
  const AUTO_DRIVE_FROM = Date.parse('2026-11-15T20:00:00Z');   // los firmados antes se guardan a mano
  let autoDriving = false;
  const autoDriveFailed = new Set();
  async function autoDrive() {
    if (autoDriving || !ctData || !ctCanEdit() || preview) return;
    const todo = ctData.contracts.filter(c => !isTpl(c) && !isDraft(c) && c.status === 'signed' && !c.drive_url && !c.file && (c.signed_at || 0) >= AUTO_DRIVE_FROM && !autoDriveFailed.has(c.id));
    if (!todo.length) return;
    autoDriving = true;
    try {
      if (ctDrive === null || !ctDriveReady) await ctDriveLoad();
      if (!ctDriveReady) return;
      for (const c of todo) {
        try {
          await ensureSigned(c);
          const r = await api('POST', `/api/contracts/${encodeURIComponent(c.id)}/drive-save`);
          c.drive_url = r.drive_url;
          toast(`Saved in Drive: ${c.title}`);
          if (view === 'contracts' && (!ctOpen || ctOpen.id === c.id)) { if (ctOpen) ctRefresh(); else render(); }
        } catch (e) { autoDriveFailed.add(c.id); console.warn('Drive', c.id, e.message); }
      }
    } finally { autoDriving = false; }
  }
  // guardar en Drive: lo hace el servidor con la cuenta de Horizon (antes se asegura el PDF firmado oficial)
  async function saveToDrive(list) {
    if (ctDrive === null) await ctDriveLoad();
    if (!ctDriveReady) { toast(isOwnerNow() ? 'Paste the Drive folder link first (Contracts → Signed).' : 'The Drive folder is not set yet. An owner sets it.'); return; }
    busy = true;
    try {
      let ok = 0;
      for (const c of list) {
        if (c.signers.length && c.signers.every(x => x.signed)) await ensureSigned(c);
        const r = await api('POST', `/api/contracts/${encodeURIComponent(c.id)}/drive-save`);
        c.drive_url = r.drive_url; ok++;
      }
      toast(ok === 1 ? 'Saved in Drive' : `${ok} contracts saved in Drive`);
    } catch (e) { toast(e.message); }
    finally { busy = false; }
  }
  /* Google Doc dentro del panel (editor de Google tal cual); si el navegador no lo deja, «Open in a new window» */
  function docEditor(c) {
    $('#doc-ov')?.remove();
    const ed = ctCanEdit() && c.status !== 'signed' && !c.signers.some(x => x.signed);
    document.body.insertAdjacentHTML('beforeend', `
      <div class="doc-ov" id="doc-ov" role="dialog" aria-modal="true" aria-label="Google Doc">
        <div class="doc-ov-bar">
          <b>${esc(c.title)}</b>
          <span class="docbox-btns">
            <a class="btn ghost sm" href="${esc(docEditUrl(c.doc_url))}" target="_blank" rel="noopener">Open in a new window ↗</a>
            ${ed ? '<button type="button" class="btn primary sm" data-doc="done">Done · update PDF</button>' : ''}
            <button type="button" class="btn ghost sm" data-doc="close">Close</button>
          </span>
        </div>
        <iframe src="${esc(docEditUrl(c.doc_url))}" title="Google Doc" allow="clipboard-read; clipboard-write"></iframe>
      </div>`);
    document.body.style.overflow = 'hidden';
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-doc]');
    if (!b) return;
    $('#doc-ov')?.remove(); document.body.style.overflow = '';
    if (b.dataset.doc === 'done') $('[data-ct="doc-pdf"]')?.click();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#doc-ov')) { $('#doc-ov').remove(); document.body.style.overflow = ''; } });
  // opciones que casi no se usan, explicadas
  function ctMoreMenu(c, ed, signed, tpl) {
    const items = [];
    if (ed && !signed) items.push(`<label class="ct-mi" for="ct-pdf"><b>${c.pdf ? 'Upload a different PDF' : 'Upload the PDF'}</b><span>${c.pdf ? 'Replaces the contract document with a PDF from your computer.' : 'The contract document, exported from Google Docs.'}</span></label>`);
    if (c.pdf && c.signers.some(x => x.signed)) items.push('<button type="button" class="ct-mi" data-ct="dl-orig"><b>Download PDF without signatures</b><span>The document as it was sent to sign.</span></button>');
    if (c.file) items.push('<button type="button" class="ct-mi" data-ct="dl-file"><b>View the copy signed on paper</b><span>The signed PDF you uploaded.</span></button>');
    if (!tpl && ed && !signed) items.push('<label class="ct-mi" for="ct-arch"><b>Upload a copy signed on paper</b><span>If the artist signed outside the web, upload that PDF: the contract is marked as signed.</span></label>');
    if (!tpl && ed && !signed) items.push(`<button type="button" class="ct-mi" data-ct="${c.status === 'void' ? 'unvoid' : 'void'}"><b>${c.status === 'void' ? 'Reactivate contract' : 'Cancel contract'}</b><span>${c.status === 'void' ? 'The signing links work again.' : 'The signing links stop working. You can reactivate it later.'}</span></button>`);
    if (ed && (!signed || auth.user.owner)) items.push(`<button type="button" class="ct-mi danger" data-ct="del"><b>Delete ${tpl ? 'template' : 'contract'}</b><span>Deletes it and its PDF for good.</span></button>`);
    return items.length ? `<details class="ct-more"><summary class="btn ghost">More ▾</summary><div class="ct-menu">${items.join('')}</div></details>` : '';
  }
  /* El texto del contrato se edita en su pestaña del Google Doc, dentro del panel; el PDF lo genera Google. */
  const docEditUrl = u => { try { const x = new URL(u); x.searchParams.set('authuser', 'contacthorizonids@gmail.com'); x.pathname = x.pathname.replace(/\/(edit|view|preview)?$/, '/edit'); return x.href; } catch { return ''; } };
  function docBlock(c, ed) {
    const tpl = isTpl(c);
    if (!isOwnerNow() || (!ed && !c.doc_url) || (!tpl && !c.doc_url)) return '';   // solo owners (y si el contrato tiene su Google Doc)
    return `
      <div class="docbox">
        <div class="docbox-head">
          <b>${tpl ? 'Template text' : 'Contract text'}</b>
          ${ed && tpl ? `<input class="doc-url" value="${esc(c.doc_url)}" placeholder="Google Doc tab link (docs.google.com/document/d/…?tab=…)" aria-label="Google Doc tab link" spellcheck="false">` : '<span></span>'}
          <span class="docbox-btns">
            ${c.doc_url ? '<button type="button" class="btn ghost sm" data-ct="doc-open">Edit in Google Docs</button>' : ''}
            ${ed && c.doc_url ? '<button type="button" class="btn primary sm" data-ct="doc-pdf">Update PDF from Doc</button>' : ''}
          </span>
        </div>
        ${tpl ? `<div class="tpl-fields">${tplFieldsHtml(ctOpen.fields)}</div>` : c.doc_url && ed ? '<p class="info">Only if you need to change the wording of this contract: edit it in Google Docs (it opens here), then press <b>Done · update PDF</b>.</p>' : ''}
      </div>`;
  }
  function tplFieldsHtml(fields) {
    if (!fields) return '<p class="info">Reading the template…</p>';
    return fields.length
      ? `<p class="info">When you create a contract from this template you fill in:</p><div class="chips">${fields.map(f => `<span class="chip" title="${esc(f.current)}">${esc(f.name)}</span>`).join('')}</div>`
      : '<p class="info">No details found in this template. Write <b>{{Name}}</b> in the Doc where a detail goes and press <b>Update PDF from Doc</b>.</p>';
  }

  /* Datos de una plantilla: se reconocen solos en el texto (XXXXXXXX, ____, o lo que ya ponga) y cada contrato los cambia */
  const DATA_NAMES = { 'artist name': 'Artist name', 'legal name': 'Legal name', 'e-mail address': 'Email', 'age': 'Age', 'street address, zip code': 'Address & zip code', 'city, country': 'City & country' };
  const BLANK_RULES = [
    [/(\{\{\s*([^{}]{1,60}?)\s*\}\})/gd, m => [[1, m[2].replace(/\s+/g, ' ').trim()]]],
    [/represented herein by\s+(.+?),\s*and hereinafter referred to as the\s*[“"]Label/gd, () => [[1, 'Label representative']]],
    [/(?:^|\n|\.\s)\s*(?:\d+\.\d+\.\s*)?([^\n:.]+?),\s*also known as\s+(.+?),\s*and hereinafter referred to as the\s*[“"]Artists?[”"]/gd, () => [[1, 'Artist name'], [2, 'Legal name']]],
    [/Artist (\d):\s*(.+?)\s+also known as\s+(.+?)\.(?=\s|$)/gd, m => [[2, `Artist ${m[1]} name`], [3, `Artist ${m[1]} legal name`]]],
    [/musical work titled\s*["“]\s*(.+?)\s*["”]\s*recorded/gd, () => [[1, 'Track']]],
    [/sound recording titled\s*["“](.+?)["”]/gd, () => [[1, 'Track']]],
    [/AUTHORIZATION\s*[–-]\s*["“](.+?)["”]/gd, () => [[1, 'Header title']]],
    [/Title:\s*["“](.+?)["”]/gd, () => [[1, 'Remix title']]],
    [/Remixer:\s*["“](.+?)["”]/gd, () => [[1, 'Remixer']]],
    [/(?:^|\n|\s)Artist:\s*(.+?)(?=\s*(?:\n|This Authorization))/gd, () => [[1, 'Artist name']]],
    [/entered into on\s+(\d\d\.\d\d\.\d{4}|XX\.XX\.XXXX)/gd, () => [[1, 'Date']]],
    [/entered into by the parties on\s+(\d\d\.\d\d\.\d{4}|XX\.XX\.XXXX)/gd, () => [[1, 'Original agreement date']]],
    [/EFFECTIVE DATE\s+(\d\d\.\d\d\.\d{4}|XX\.XX\.XXXX)/gd, () => [[1, 'Date']]],
    [/Signed By HORIZON RCRDS\s*\((.+?)\)/gd, () => [[1, 'Label signatory']]],
    [/(Artist (\d) Name|Artist Name|Legal Name|E-Mail Address|Age|Street Address, Zip Code|City, Country):\s*(_{6,})/gd, (m, ctx) => {
      if (m[2]) { ctx.who = `Artist ${m[2]} `; return [[3, `Artist ${m[2]} name`]]; }
      const n = DATA_NAMES[m[1].toLowerCase()];
      return [[3, ctx.who ? ctx.who + n.toLowerCase().replace(/^email$/, 'email') : n]];
    }],
  ];
  const isBlank = v => /^(X{3,}|XX\.XX\.XXXX|_+)$/.test(v.trim());
  function findBlanks(text) {
    const out = [], ctx = {};
    for (const [re, fn] of BLANK_RULES) for (const m of text.matchAll(re)) for (const [g, name] of fn(m, ctx)) {
      const [start, end] = m.indices[g] || [];
      if (start == null || end <= start || !name || out.some(b => start < b.end && end > b.start)) continue;
      out.push({ name, start, end, value: m[g] });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  // los datos de una plantilla, leídos de su PDF (nombre + lo que pone ahora, si no es un hueco)
  async function pdfFields(bytes) {
    const pdf = await HZPDF.load(bytes);
    let txt = '';
    for (let i = 1; i <= pdf.numPages; i++) txt += (await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str + (x.hasEOL ? ' ' : '')).join('') + ' ';
    const map = new Map();
    for (const b of findBlanks(txt.replace(/[ \t]+/g, ' '))) {
      const v = b.value.replace(/\s+/g, ' ').trim();
      if (!map.has(b.name)) map.set(b.name, { name: b.name, current: '' });
      if (!map.get(b.name).current && !isBlank(v) && !/^\{\{/.test(v)) map.get(b.name).current = v;
    }
    return [...map.values()];
  }
  const docParts = u => { const m = String(u).match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/), t = String(u).match(/[?&#]tab=(t\.[\w]+)/); return m ? { id: m[1], tab: t ? t[1] : '' } : null; };
  function signersBlock(c, ed) {
    const act = ctOpen.placing ?? -1, tpl = isTpl(c);
    return `
      <div class="signers${act >= 0 ? ' is-placing' : ''}">
        <div class="signers-head"><b>${isDraft(c) ? 'Sent to (review only)' : 'Who signs'}</b><span class="muted">${isDraft(c) ? 'A draft is only to read online: no signing and no download.' : act >= 0 ? `Click on the document where <b>${esc(c.signers[act]?.label || 'this person')}</b> signs, or press Cancel.` : ed ? 'Each person gets their own private link by email and signs in their box on the document.' : ''}</span></div>
        ${c.signers.map((x, i) => `
          <div class="signer${i === act ? ' is-on' : ''}" data-sg="${esc(x.id)}" data-i="${i}">
            <span class="sg-n">${i + 1}</span>
            ${ed && !x.signed ? `<label class="sg-f"><span>Name</span><input class="sg-label" value="${esc(x.label)}" maxlength="60" placeholder="Artist name"></label>
              ${tpl ? '<span></span>' : `<label class="sg-f"><span>Signing link is sent to</span><input class="sg-email" type="email" value="${esc(x.email)}" maxlength="160" placeholder="artist@email.com"></label>`}`
              : `<span class="sg-txt"><b>${esc(x.label)}</b><span>${esc(x.email || '')}</span></span><span></span>`}
            <span class="sg-state ${x.signed ? 'ok' : x.email_error && !x.emailed_at ? '' : x.box ? 'set' : ''}" ${x.email_error && !x.signed ? `title="${esc(x.email_error)}"` : ''}>${x.signed ? `✓ Signed · ${esc(x.name)} · ${esc(fmtDate(x.signed_at))}` : x.email_error && !x.emailed_at ? 'Email not sent' : x.emailed_at ? `Emailed · ${esc(fmtDate(x.emailed_at))}` : isDraft(c) ? 'Review only' : x.box ? `Signs on page ${x.box.page + 1}` : 'Signature spot not set'}</span>
            <span class="sg-btns">
              ${ed && !x.signed && !isDraft(c) ? (i === act ? '<button type="button" class="btn primary sm" data-ct="sg-cancel">Cancel</button>' : `<button type="button" class="btn ghost sm" data-ct="sg-pick" ${act >= 0 ? 'disabled' : ''}>${x.box ? 'Move signature' : 'Place signature'}</button>`) : ''}
              ${x.token && !x.signed && c.status !== 'void' ? `<button type="button" class="btn ghost sm" data-ct="sg-copy" title="${esc(signerUrl(x))}">Copy link</button>${ed ? `<button type="button" class="btn ghost sm" data-ct="sg-mail">${x.emailed_at ? 'Resend email' : 'Send email'}</button>` : ''}` : ''}
              ${x.signed && x.token ? `<a class="btn ghost sm" href="${esc(signerUrl(x))}" target="_blank" rel="noopener">View</a>` : ''}
              ${ed && !x.signed && c.signers.length > 1 ? '<button type="button" class="ic danger" data-ct="sg-del" aria-label="Remove signer">✕</button>' : ''}
            </span>
          </div>`).join('')}
        ${ed ? '<button type="button" class="btn ghost sm" data-ct="sg-add">+ Add signer</button>' : ''}
      </div>`;
  }
  // datos del contrato, ordenados en grupos
  function ctDataBlock(vars) {
    const groups = { Artist: [], Release: [], Label: [] };
    for (const [k, v] of vars) (/label|signatory|representative/i.test(k) ? groups.Label : /track|date|title|remix/i.test(k) ? groups.Release : groups.Artist).push([k, v]);
    return `<div class="ct-data">${Object.entries(groups).filter(([, l]) => l.length).map(([g, l]) => `
      <div class="ct-group"><p class="mini">${g}</p><dl>${l.map(([k, v]) => `<dt>${esc(k.replace(/^Artist (\d) /, 'A$1 · '))}</dt><dd>${esc(v) || '<span class="muted">—</span>'}</dd>`).join('')}</dl></div>`).join('')}</div>`;
  }
  function contractsPage() {
    if (!ctData) {
      if (!ctErr) setTimeout(loadContracts, 0);
      return `<div class="head"><div><p class="eyebrow">Signatures</p><h1>CONTRACTS</h1></div></div>${ctErr ? `<p class="login-error" role="alert">${esc(ctErr)}</p>` : '<p class="info">Loading…</p>'}`;
    }
    if (ctOpen?.mode === 'new') return ctPick();
    if (ctOpen?.mode === 'new-tpl') return ctNewTpl();
    if (ctOpen?.mode === 'use') return ctUse();
    if (ctOpen?.mode === 'contract') { if (ctOpen.contract?.pdf) setTimeout(ctPaint, 0); return ctDetail(); }
    return ctList();
  }
  // tras dibujar la ficha, se pinta el PDF (pdf.js) con el recuadro de la firma
  async function ctPaint() {
    const c = ctOpen?.contract, box = $('#pdf-viewer');
    if (!c || !box || !c.pdf) return;
    try {
      if (!ctOpen.bytes) ctOpen.bytes = new Uint8Array(await (await authFetch(`/api/contracts/${encodeURIComponent(c.id)}/pdf`)).arrayBuffer());
      const ed = ctCanEdit() && c.status !== 'signed' && !isDraft(c);
      ctOpen.view = await HZPDF.render(box, ctOpen.bytes, { marks: ctMarks(), maxWidth: 820, onPage: ed ? (page, x, y) => placeBox(page, x, y) : null });
      if (ctCanEdit() && c.status === 'signed' && !c.signed_pdf) ensureSigned(c, ctOpen.bytes).catch(() => { /* se reintenta la próxima vez */ });
      if (ed && !c.signers.some(x => x.signed)) { autoPlaceFor = null; autoPlace(c).catch(() => { /* se colocan a mano */ }); }
      if (isTpl(c) && !ctOpen.fields) { ctOpen.fields = await pdfFields(ctOpen.bytes); const el = $('.tpl-fields'); if (el) el.innerHTML = tplFieldsHtml(ctOpen.fields); }
    } catch (e) { box.innerHTML = `<p class="login-error">${esc(e.message)}</p>`; }
  }
  /* Dónde firma cada artista: encima de la línea «______» que tiene debajo «Signed By Artist» (o «Artist 1», «Artist 2»…) */
  let autoPlaceFor = null;
  async function signSpots(bytes) {
    const pdf = await HZPDF.load(bytes), spots = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), vp = page.getViewport({ scale: 1 }), W = vp.width, H = vp.height;
      const items = (await page.getTextContent()).items.map(it => ({ s: it.str, x: it.transform[4], y: H - it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height }));
      const lines = items.filter(it => /^[\s_]*_{8,}[\s_]*$/.test(it.s));
      let ink = null;   // la página dibujada, para encontrar la raya de verdad
      for (const lb of items) {
        // solo la etiqueta de la firma («Signed By Artist 1 (Or legal guardian)»), no frases del contrato
        const m = lb.s.trim().match(/^signed by\s+(?:the\s+)?artist\s*(\d)?\s*(?:\(|$)/i);
        if (!m || lb.s.trim().length > 60) continue;
        const mid = lb.x + lb.w / 2;
        // la línea justo encima de la etiqueta (la más cercana que la cubra)
        const ln = lines.filter(l => l.y < lb.y && lb.y - l.y < 40 && l.x - 20 < mid && l.x + l.w + 20 > mid).sort((a, b) => b.y - a.y)[0];
        let cx = ln ? ln.x + ln.w / 2 : mid, lineW = ln ? ln.w : lb.w, bottom = ln ? ln.y - 1 : lb.y - 14;
        // ajuste fino con los píxeles: la raya horizontal más cercana encima de la etiqueta (borde de arriba y centro exactos)
        try {
          ink = ink || await pageInk(page);
          const r = findRule(ink, mid, lb.y - (lb.h || 8), 40);
          if (r) { cx = (r.x0 + r.x1) / 2; lineW = r.x1 - r.x0; bottom = r.top; }
        } catch { /* se queda con la posición del texto */ }
        const w = Math.max(0.3 * W, lineW), h = 0.07 * H;
        const x = Math.min(Math.max(0, cx - w / 2), W - w);
        spots.push({ n: m[1] ? Number(m[1]) : null, box: { page: i - 1, x: x / W, y: Math.max(0, (bottom - h) / H), w: w / W, h: h / H } });
      }
    }
    for (let i = spots.length - 1; i >= 0; i--) if (spots.slice(i + 1).some(o => o.n === spots[i].n)) spots.splice(i, 1);
    // dos firmas en la misma fila (DUO): que los recuadros no se toquen
    for (const a of spots) {
      const cx = a.box.x + a.box.w / 2;
      for (const b of spots) if (b !== a && b.box.page === a.box.page && Math.abs(b.box.y - a.box.y) < 0.03) {
        const d = Math.abs(b.box.x + b.box.w / 2 - cx) - 0.015;
        if (a.box.w > d) { a.box.w = d; a.box.x = cx - d / 2; }
      }
    }
    return spots;
  }
  // página en píxeles (3 por punto) para medir rayas
  async function pageInk(page) {
    const k = 3, vp = page.getViewport({ scale: k }), c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp, intent: 'print' }).promise;
    return { k, w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data };
  }
  // la raya horizontal (oscura, ≥ 50 pt) más cercana por encima de «above», que pase por «cx»; en puntos
  function findRule(ink, cx, above, maxUp) {
    const { k, w, d } = ink, dark = (x, y) => { const i = (y * w + x) * 4; return d[i] + d[i + 1] + d[i + 2] < 200; };
    const px = Math.round(cx * k);
    for (let y = Math.round(above * k); y > Math.round((above - maxUp) * k) && y > 0; y--) {
      if (!dark(px, y)) continue;
      let x0 = px, x1 = px;
      while (x0 > 0 && (dark(x0 - 1, y) || dark(x0 - 2, y) || dark(x0 - 3, y))) x0--;
      while (x1 < w - 1 && (dark(x1 + 1, y) || dark(x1 + 2, y) || dark(x1 + 3, y))) x1++;
      if ((x1 - x0) / k < 50) continue;   // no es una raya (letra, etc.)
      let top = y; while (top > 0 && dark(px, top - 1)) top--;   // grosor: borde de arriba
      return { x0: x0 / k, x1: (x1 + 1) / k, top: top / k };
    }
    return null;
  }
  async function autoPlace(c) {
    const spots = await signSpots(ctOpen.bytes);
    if (!spots.length) return;
    const free = spots.filter(x => x.n === null), done = [];
    for (const [i, sg] of c.signers.entries()) {
      const sp = spots.find(x => x.n === i + 1) || (i === 0 ? spots.find(x => x.n === 1) : null) || free.shift();
      if (!sp || sg.signed || sg.box?.manual) continue;
      const b = sp.box, old = sg.box;
      if (old && Math.abs(old.page - b.page) + Math.abs(old.x - b.x) + Math.abs(old.y - b.y) + Math.abs(old.w - b.w) < 0.005) continue;
      await api('POST', `/api/contracts/${encodeURIComponent(c.id)}/box`, { signer: sg.id, box: b });
      sg.box = b; done.push(sg.label || `Artist ${i + 1}`);
    }
    if (!done.length || ctOpen?.contract !== c) return;
    ctOpen.placing = null;
    ctSoftUpdate();
    toast(`Signature placed above “Signed By Artist” (${done.join(', ')}). Use Place signature to move it.`);
  }
  // actualiza la lista de firmantes, los botones y los recuadros sin volver a pintar la página
  function ctSoftUpdate() {
    const c = ctOpen?.contract;
    if (!c) return;
    const ed = ctCanEdit() && c.status !== 'signed';
    const keep = [...document.querySelectorAll('.signer')].map(el => ({ id: el.dataset.sg, label: el.querySelector('.sg-label')?.value, email: el.querySelector('.sg-email')?.value }));
    for (const k of keep) { const x = c.signers.find(y => y.id === k.id); if (x && k.label !== undefined) { x.label = k.label; x.email = k.email; } }
    const el = $('.signers');
    if (el) el.outerHTML = signersBlock(c, ed);
    if (ctOpen.view) HZPDF.drawMarks(ctOpen.view.pages, ctMarks());
    $('#pdf-viewer')?.classList.toggle('placing', ctOpen.placing != null);
    const send = $('[data-ct=send]'), canSend = ed && !isTpl(c) && c.status !== 'void' && c.pdf && c.signers.every(x => x.box) && c.signers.some(x => !x.emailed_at && !x.signed);
    if (canSend && !send) { const at = $('.ed-actions [type=submit]'); const html = sendBtn(c); if (at) at.insertAdjacentHTML('afterend', html); else $('.ed-actions')?.insertAdjacentHTML('afterbegin', html); }
  }
  function ctMarks() {
    const c = ctOpen.contract, act = ctOpen.placing ?? -1;
    return c.signers.map((x, i) => x.signed
      ? { box: x.box, sign: x.signature, label: `Signed electronically by ${x.name}` }
      : { box: x.box, title: x.label || `Artist ${i + 1}`, active: i === act });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && view === 'contracts' && ctOpen?.placing != null) { ctOpen.placing = null; ctSoftUpdate(); } });
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && view === 'contracts' && $('#ct-ed')) { e.preventDefault(); $('#ct-ed').requestSubmit(); } });
  async function placeBox(page, x, y) {
    const c = ctOpen.contract, act = ctOpen.placing ?? -1;
    if (act < 0) return;   // solo después de pulsar «Place signature» (un clic suelto en el documento no mueve nada)
    const sg = c.signers[act];
    if (!sg || sg.signed) return;
    const old = sg.box;
    const w = old?.w || (c.signers.length > 2 ? 0.24 : 0.3), h = old?.h || 0.07;
    const b = { page, x: Math.min(Math.max(0, x - w / 2), 1 - w), y: Math.min(Math.max(0, y - h * 0.75), 1 - h), w, h, manual: 1 };   // movida a mano: no se recoloca sola
    sg.box = b;
    HZPDF.drawMarks(ctOpen.view.pages, ctMarks());
    try {
      await api('POST', `/api/contracts/${encodeURIComponent(c.id)}/box`, { signer: sg.id, box: b });
      toast(`Signature placed for ${sg.label || 'the signer'}`);
      ctOpen.placing = null;
      ctSoftUpdate();   // sin redibujar la página ni el PDF (no se pierde la posición)
    } catch (e) { toast(e.message); sg.box = old; HZPDF.drawMarks(ctOpen.view.pages, ctMarks()); }
  }
  async function pdfInfo(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await HZPDF.load(bytes);
    return { bytes, hash: await HZPDF.sha256(bytes), pages: pdf.numPages };
  }
  async function uploadPdf(id, file) {
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new GhError('Upload a PDF file.');
    const info = await pdfInfo(file);
    await authFetch(`/api/contracts/${encodeURIComponent(id)}/pdf?hash=${info.hash}&pages=${info.pages}`, { method: 'POST', body: info.bytes });
  }
  async function openContract(id) {
    ctOpen = { mode: 'contract', id, contract: null };
    render();
    try { const r = await api('GET', `/api/contracts/${encodeURIComponent(id)}`); if (ctOpen?.id === id) { ctOpen.contract = r.contract; ctOpen.events = r.events || []; ctMarkSeen(r.contract); render(); } }
    catch (e) { toast(e.message); ctOpen = null; render(); }
  }
  async function ctRefresh() { const keep = ctOpen?.bytes; const id = ctOpen.id; const r = await api('GET', `/api/contracts/${encodeURIComponent(id)}`); ctOpen = { mode: 'contract', id, contract: r.contract, events: r.events || [], bytes: keep, placing: null, fields: keep ? ctOpen.fields : null }; ctMarkSeen(r.contract); render(); }
  async function ctAction(fn, ok) {
    busy = true;
    try { const r = await fn(); if (ok) toast(ok); return r; }
    catch (e) { if (e.status === 401) { busy = false; logout(e.message); return; } const b = $('#ed-error'); if (b) { b.textContent = e.message; b.hidden = false; b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } else toast(e.message); throw e; }
    finally { busy = false; }
  }
  document.addEventListener('click', async e => {
    if (view !== 'contracts') return;
    const t = e.target.closest('[data-ct]');
    if (!t || busy) return;
    const a = t.dataset.ct, c = ctOpen?.contract;
    if (a === 'back') { ctOpen = null; render(); loadContracts(); }
    else if (a === 'new') { ctOpen = { mode: 'new' }; render(); }
    else if (a === 'new-tpl') { ctOpen = { mode: 'new-tpl' }; render(); $('#tp-title')?.focus(); }
    else if (a === 'copy-add' || a === 'copy-del') { const keep = ctFormValues(); ctOpen.copies = Math.max(1, Math.min(8, copiesOf() + (a === 'copy-add' ? 1 : -1))); render(); ctFormRestore(keep); }
    else if (a === 'tab-contracts' || a === 'tab-templates' || a === 'tab-signed' || a === 'tab-activity') { ctTab = a.slice(4); if (a === 'tab-activity') ctAct = null; render(); }
    else if (a === 'act-open') openContract(t.dataset.id);
    else if (a === 'step') {
      // cada paso lleva a su sitio
      const n = Number(t.dataset.step), signed = c.status === 'signed';
      const go = el => { if (!el) return; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); };
      if (n === 1) { go($('.ct-data') || $('#c-title')?.closest('.row2')); $('#c-title')?.focus({ preventScroll: true }); }
      else if (n === 2) go($('.signers'));
      else if (n === 3) { if (signed) { ctOpen = null; ctTab = 'signed'; render(); loadContracts(); } else go($('.signers')); }
      else if (c.drive_url) window.open(c.drive_url, '_blank', 'noopener');
      else if (signed) go($('[data-ct="drive-one"]'));
      else toast('It can be saved in Drive when everyone has signed.');
    }
    else if (a === 'drive-all') { const list = ctData.contracts.filter(x => !isTpl(x) && x.status === 'signed' && !x.drive_url); await saveToDrive(list); ctData = null; loadContracts(); }
    else if (a === 'drive-one') { await saveToDrive([c]); ctRefresh(); }
    else if (a === 'finish') { try { const r = await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/finish`)); toast(r?.ok ? 'Signed copy emailed' : r?.error || 'The email could not be sent'); ctRefresh(); } catch { /* aviso ya mostrado */ } }
    else if (a === 'sg-mail') {
      const sg = c.signers[Number(t.closest('[data-i]').dataset.i)];
      try { const r = await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/send`, { signer: sg.id })); toast(r?.ok ? `Email sent to ${sg.email}` : r?.error || 'The email could not be sent'); ctRefresh(); } catch { /* aviso ya mostrado */ }
    }
    else if (a === 'use') {
      const id = t.closest('[data-ctid]')?.dataset.ctid || c?.id;
      const tpl = ctData.contracts.find(x => x.id === id) || c;
      const bytes = c?.id === id ? ctOpen.bytes : null, known = c?.id === id ? ctOpen.fields : null;
      const used = ctData.contracts.filter(x => x.release_cat).map(x => ({ catalog: x.release_cat })).concat((ctData.cats || []).map(x => ({ catalog: x })));
      ctOpen = { mode: 'use', tpl, fields: known, cat: nextCatalog([...(repo?.releases || []), ...used]) };
      render(); rfLoad();
      if (!known) try {
        const b = bytes || new Uint8Array(await (await authFetch(`/api/contracts/${encodeURIComponent(id)}/pdf`)).arrayBuffer());
        ctOpen.fields = await pdfFields(b);
        if (ctOpen?.mode === 'use') { const keep = ctFormValues(); render(); ctFormRestore(keep.filter(([n]) => !/^f\d+$/.test(n))); $('#u-artist')?.focus(); }
      } catch (err) { toast(err.message); }
    }
    else if (a === 'doc-open') docEditor(c);
    else if (a === 'open') openContract(t.closest('[data-ctid]').dataset.ctid);
    else if (a === 'doc-pdf') {
      try {
        const r = await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/from-doc`, {}), 'PDF updated from the Doc');
        ctOpen.bytes = null; ctOpen.fields = null;
        autoPlaceFor = c.id;
        ctRefresh();
      } catch (err) { toast(err.message); }
    }
    else if (a === 'sg-pick') { ctOpen.placing = Number(t.closest('[data-i]').dataset.i); ctSoftUpdate(); }
    else if (a === 'sg-cancel') { ctOpen.placing = null; ctSoftUpdate(); }
    else if (a === 'sg-copy') { const sg = c.signers[Number(t.closest('[data-i]').dataset.i)]; try { await navigator.clipboard.writeText(signerUrl(sg)); toast('Link copied'); } catch { toast(signerUrl(sg)); } }
    else if (a === 'sg-add') { try { await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/signers`, { action: 'add' }), 'Signer added'); ctOpen.placing = null; ctRefresh(); } catch { /* aviso ya mostrado */ } }
    else if (a === 'sg-del') {
      const sg = c.signers[Number(t.closest('[data-i]').dataset.i)];
      if (!await confirmBox(`Remove ${sg.label || 'this signer'}?`, 'Remove')) return;
      try { await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/signers`, { action: 'remove', signer: sg.id }), 'Signer removed'); ctOpen.placing = null; ctRefresh(); } catch { /* aviso ya mostrado */ }
    }
    else if (a === 'send') {
      // guarda antes los emails escritos y luego envía a cada firmante su enlace por correo
      const f = $('#ct-ed'), signers = $$('.signer', f).map(el => ({ id: el.dataset.sg, label: el.querySelector('.sg-label')?.value, email: el.querySelector('.sg-email')?.value })).filter(x => x.label !== undefined);
      try {
        if (signers.length) await ctAction(() => api('POST', '/api/contracts', { id: c.id, title: f.elements.title?.value ?? c.title, artist: f.elements.artist?.value ?? c.artist, email: signers[0]?.email ?? c.email, notes: f.elements.notes.value, signers }));
        if (!await confirmBox(isDraft(c) ? `Send this draft to ${c.signers[0]?.email || 'the artist'}? They can only read it online.` : `Send “${c.title}” to sign? ${c.signers.length > 1 ? 'Each signer gets' : 'The artist gets'} an email with a private link.`, 'Send')) return;
        const r = await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/send`));
        toast(r?.ok ? `Sent: ${r.sent} email${r.sent === 1 ? '' : 's'}` : r?.error || 'The email could not be sent');
        if (r?.ok) { ctOpen = null; ctTab = 'contracts'; ctData = null; render(); loadContracts(); } else ctRefresh();
      } catch { /* aviso ya mostrado */ }
    }
    else if (a === 'void' || a === 'unvoid') {
      if (a === 'void' && !await confirmBox('Cancel this contract? The signing links will stop working (you can reactivate it).', 'Cancel contract')) return;
      try { await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/${a}`), a === 'void' ? 'Contract cancelled' : 'Contract reactivated'); ctRefresh(); } catch { /* aviso ya mostrado */ }
    } else if (a === 'del') {
      if (!await confirmBox(`Delete “${c.title}”${c.status === 'signed' ? ' (SIGNED)' : ''}? Its PDF is deleted too. This can’t be undone.`, 'Delete')) return;
      try { await ctAction(() => api('DELETE', `/api/contracts/${encodeURIComponent(c.id)}`), 'Contract deleted'); ctOpen = null; ctData = null; render(); } catch { /* aviso ya mostrado */ }
    } else if (a === 'dl-orig') { HZPDF.download(ctOpen.bytes, pdfName(c, ' (not signed)')); }
    else if (a === 'dl-file') { try { const r = await authFetch(`/api/contracts/${encodeURIComponent(c.id)}/file`); HZPDF.download(new Uint8Array(await r.arrayBuffer()), pdfName(c, ' (signed on paper)')); } catch (err) { toast(err.message); } }
    else if (a === 'dl-signed') {
      try {
        if (c.signed_pdf) { const r = await authFetch(`/api/contracts/${encodeURIComponent(c.id)}/signed`); HZPDF.download(new Uint8Array(await r.arrayBuffer()), pdfName(c)); return; }
        const out = await HZPDF.signed(ctOpen.bytes, { title: ctName(c), hash: c.pdf_hash,
          signers: c.signers.map(x => ({ label: x.label, box: x.box, signed: x.signed ? { name: x.name, email: x.signer_email, at: x.signed_at, ip: x.ip, ua: x.ua, signature: x.signature, hash: c.pdf_hash } : null })) });
        HZPDF.download(out, pdfName(c, c.status === 'signed' ? '' : ' (signatures so far)'));
      } catch (err) { toast('Could not create the signed PDF: ' + err.message); }
    }
  });
  document.addEventListener('change', async e => {
    if (view !== 'contracts' || busy) return;
    if (e.target.classList?.contains('u-from')) { rfFill(Number(e.target.dataset.k), e.target.value); return; }
    if (e.target.classList?.contains('drive-url')) {
      const v = e.target.value.trim(), id = driveId(v);
      if (v && !id) { toast('Paste the link of a Drive folder (drive.google.com/drive/folders/…).'); return; }
      try { await ctAction(() => api('POST', '/api/contracts/settings', { drive_folder: id }), id ? 'Drive folder saved' : 'Drive folder removed'); ctDrive = id; ctDriveReady = !!id; render(); } catch { /* aviso ya mostrado */ }
      return;
    }
    if (e.target.classList?.contains('doc-url')) {
      const c = ctOpen?.contract;
      try { await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(c.id)}/doc`, { url: e.target.value.trim() }), 'Doc link saved'); c.doc_url = e.target.value.trim(); const el = $('.docbox'); if (el) el.outerHTML = docBlock(c, true); } catch { /* aviso ya mostrado */ }
      return;
    }
    const f = e.target.files?.[0];
    if (!f) return;
    const id = ctOpen?.contract?.id;
    if (e.target.id === 'ct-pdf') {
      e.target.value = '';
      try { await ctAction(() => uploadPdf(id, f), 'PDF uploaded'); ctOpen.bytes = null; ctRefresh(); } catch { /* aviso ya mostrado */ }
    }
    if (e.target.id === 'ct-arch') {
      e.target.value = '';
      if (!await confirmBox('Upload this PDF as an ALREADY SIGNED contract (signed outside the site)? The contract will be marked as signed.', 'Move up')) return;
      try { await ctAction(() => authFetch(`/api/contracts/${encodeURIComponent(id)}/file`, { method: 'POST', body: f }), 'Signed PDF saved'); ctRefresh(); } catch { /* aviso ya mostrado */ }
    }
  });
  document.addEventListener('submit', async e => {
    const f = e.target;
    if (!['ct-new', 'ct-ed', 'ct-tpl', 'ct-use'].includes(f.id)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (busy) return;
    try {
      const fail = m => { const b = $('#ed-error', f) || $('#ed-error'); b.textContent = m; b.hidden = false; };
      if (f.id === 'ct-new') {
        const file = f.elements.file.files[0];
        if (!file) return fail('Choose the contract PDF.');
        const r = await ctAction(() => api('POST', '/api/contracts', { title: f.elements.title.value, artist: f.elements.artist.value, email: f.elements.email.value }));
        await ctAction(() => uploadPdf(r.id, file), 'Contract created');
        openContract(r.id); loadContracts();
      } else if (f.id === 'ct-tpl') {
        const doc = f.elements.doc.value.trim();
        if (!f.elements.title.value.trim()) return fail('Give the template a name.');
        if (!docParts(doc)) return fail('Paste the Google Doc tab link.');
        const r = await ctAction(() => api('POST', '/api/contracts', { kind: 'template', title: f.elements.title.value }));
        await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(r.id)}/doc`, { url: doc }));
        try { await ctAction(() => api('POST', `/api/contracts/${encodeURIComponent(r.id)}/from-doc`, {}), 'Template created'); } catch { /* aviso ya mostrado */ }
        ctTab = 'templates'; ctData = null; autoPlaceFor = r.id; openContract(r.id); loadContracts();
      } else if (f.id === 'ct-use') {
        const tpl = ctOpen.tpl, fields = ctOpen.fields || [], btn = $('button[type=submit]', f);
        const stage = t => { btn.textContent = t; };   // en qué va
        if (isDraftTpl(tpl)) {
          const em = f.elements.em0.value.trim();
          if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em)) return fail('Write the email the draft is sent to.');
          btn.disabled = true; stage('Sending…');
          try {
            const r = await ctAction(() => api('POST', '/api/contracts/make', { template: tpl.id, copies: [{ title: 'Contract Draft', artist: '', signers: [{ email: em }] }], send: true }));
            toast(r.ok ? `Draft sent to ${em}` : r.error || 'The email could not be sent');
            ctTab = 'contracts'; ctData = null; ctOpen = null; render(); loadContracts();
          } catch (err) { if (!$('#ed-error:not([hidden])')) fail(err.message); btn.disabled = false; stage('Send draft'); }
          return;
        }
        const title = f.elements.title.value.trim();
        if (!title || /—\s*$/.test(title)) return fail('Complete the contract title.');
        const n = artistsOf(tpl), copiesMode = isCopies(tpl);
        const people = Array.from({ length: n }, (_, i) => ({ name: (f.elements['cn' + i]?.value || '').trim(), email: (f.elements['em' + i]?.value || '').trim() }));
        const valuesFor = k => {
          const v = {};
          fields.forEach((x, i) => {
            const who = fieldArtist(x.name, n, copiesMode);
            if (who === 'each' && !k) return;
            const a = who === 'each' ? k : who;
            const raw = a && isDupField(x.name) ? (people[a - 1]?.[/mail/i.test(x.name) ? 'email' : 'name'] || '') : (f.elements[fieldInput(i, who, k)]?.value || '').trim();
            v[x.name] = needsCaps(x.name) ? titleCase(raw) : raw;
          });
          return v;
        };
        if (people.some(p => !p.name)) return fail(`Write the name of ${n > 1 ? 'each artist' : 'the artist'}.`);
        const bad = people.find(p => p.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(p.email));
        if (bad) return fail(`The email of ${bad.name} is not valid.`);
        const artist = people.map(p => p.name).join(' & ');
        const jobs = copiesMode
          ? people.map((p, x) => ({ values: { ...valuesFor(x + 1), 'Artists clause name': people.map(q => q.name).join(', '), 'Artists clause legal': people.map((q, y) => valuesFor(y + 1)['Legal name'] || '').filter(Boolean).join(', ') }, copies: [{ title: `${title} (${p.name})`, artist, signers: [{ label: p.name, email: p.email }] }] }))
          : [{ values: valuesFor(0), copies: [{ title, artist, signers: people.map(p => ({ label: p.name, email: p.email })) }] }];
        btn.disabled = true; stage('Making the contract and its PDF…');
        try {
          const rs = await ctAction(() => Promise.all(jobs.map(jb => api('POST', '/api/contracts/make', { template: tpl.id, ...jb, release_cat: f.elements.release_cat.value, release_name: f.elements.release_name.value }))));
          const r = { ids: rs.flatMap(x => x.ids) };
          toast(r.ids.length > 1 ? `${r.ids.length} contracts created, one per artist` : 'Contract created');
          ctTab = 'contracts'; ctData = null;
          if (r.ids.length > 1) { ctOpen = null; render(); loadContracts(); }
          else { autoPlaceFor = r.ids[0]; openContract(r.ids[0]); loadContracts(); }
        } catch (err) { if (!$('#ed-error:not([hidden])')) fail(err.message); btn.disabled = false; stage('Create contract'); }
      } else {
        const c = ctOpen.contract;
        const signers = $$('.signer', f).map(el => ({ id: el.dataset.sg, label: el.querySelector('.sg-label')?.value, email: el.querySelector('.sg-email')?.value })).filter(x => x.label !== undefined);
        await ctAction(() => api('POST', '/api/contracts', { id: c.id, title: f.elements.title?.value ?? c.title, artist: f.elements.artist?.value ?? c.artist, email: signers[0]?.email ?? c.email, notes: f.elements.notes.value, signers,
          ...(f.elements.release_cat ? { release_cat: f.elements.release_cat.value, release_name: f.elements.release_name.value } : {}) }), 'Saved');
        // se queda todo como está; solo se ponen al día los datos y el título
        const r = await api('GET', `/api/contracts/${encodeURIComponent(c.id)}`).catch(() => null);
        if (r && ctOpen?.id === c.id) { ctOpen.contract = r.contract; ctOpen.events = r.events || []; const h = $('.ct-ed .head h1'); if (h) h.textContent = r.contract.title; }
      }
    } catch { /* aviso ya mostrado */ }
  }, true);

  /* ---------------- Calendar: releases y mixtapes con su fecha ---------------- */
  let calData = null, calErr = '', calLoading = false, calOpen = null;
  const calCanEdit = () => !!calData?.canEdit && can('calendar', 'edit');
  async function loadCalendar() {
    if (calLoading) return;
    calLoading = true;
    try { calData = await api('GET', '/api/calendar'); calErr = ''; }
    catch (e) { calErr = e.message; if (e.status === 401) { calLoading = false; logout(e.message); return; } }
    calLoading = false;
    if (view === 'calendar') render();
  }
  // mientras miras Calendar, cada 30 s se pone al día (fechas que llegan de Discord, cambios de otros); sin parpadeo
  async function checkCalendar() {
    if (!auth || view !== 'calendar' || calOpen || !calData || calLoading || busy || document.hidden) return;
    if (document.activeElement?.matches?.('.cal-pick, input, select, textarea')) return;   // eligiendo una fecha: no se toca
    try {
      const r = await api('GET', '/api/calendar');
      const key = x => JSON.stringify([x.items, x.unscheduled]);
      if (key(r) !== key(calData)) { calData = r; if (view === 'calendar' && !calOpen) render(); }
      else { calData.discord = r.discord; const n = $('.cal-sync'); if (n) n.outerHTML = calSyncNote(); }
    } catch { /* sin aviso */ }
  }
  setInterval(checkCalendar, 30e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCalendar(); });
  const CAL_KIND = { release: 'Release', mixtape: 'Mixtape', other: 'Other' };
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const calDay = d => { const [y, m, x] = d.split('-'); return `${x}.${m}.${y.slice(2)}`; };
  const calWeekday = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
  const calMonth = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  // días que faltan (según la fecha de hoy en este ordenador)
  const calDaysLeft = d => { const t = new Date(); t.setHours(12, 0, 0, 0); return Math.round((new Date(d + 'T12:00:00') - t) / 864e5); };
  const calLeftTxt = n => n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 ? `${n} days` : n === -1 ? 'Yesterday' : `${-n} days ago`;
  const calBits = d => { const x = new Date(d + 'T12:00:00'); return { day: x.getDate(), mon: x.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase(), wd: x.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase(), yr: x.getFullYear() }; };
  function calendarPage() {
    if (!calData) {
      if (!calErr) setTimeout(loadCalendar, 0);
      return `<div class="head"><div><p class="eyebrow">Schedule</p><h1>CALENDAR</h1></div></div>${calErr ? `<p class="login-error" role="alert">${esc(calErr)}</p>` : '<p class="info">Loading…</p>'}`;
    }
    if (calOpen) return calForm();
    const ed = calCanEdit(), today = todayIso();
    const next = calData.items.filter(x => x.date >= today), past = calData.items.filter(x => x.date < today).reverse();
    const row = x => {
      const b = calBits(x.date), n = calDaysLeft(x.date);
      return `
        <li class="row cal${n === 0 ? ' is-today' : n > 0 && n <= 7 ? ' is-soon' : ''}${n < 0 ? ' is-past' : ''}" data-cal="${esc(x.id)}">
          <span class="cal-day"><small>${b.wd}</small><b>${b.day}</b><small>${b.mon}${b.yr !== new Date().getFullYear() ? ' ' + String(b.yr).slice(2) : ''}</small></span>
          <span class="meta"><span class="cal-kicker">${x.cat ? `<span class="cal-cat">${esc(x.cat)}</span>` : ''}${CAL_KIND[x.kind] || x.kind}${x.programmed ? ' · <span class="cal-prog">Programmed</span>' : ''}</span>
            <b>${x.artist ? esc(x.artist) + ' - ' : ''}${esc(x.title)}</b>${x.note ? `<span>${esc(x.note)}</span>` : ''}</span>
          <span class="cal-left">${calLeftTxt(n)}</span>
          <span class="row-btns">${ed ? '<button type="button" class="btn ghost sm" data-cal-act="edit">Edit</button>' : ''}</span>
        </li>`;
    };
    // lo próximo, en grande arriba
    const nextOf = k => next.find(x => x.kind === k);
    const hero = x => { if (!x) return ''; const n = calDaysLeft(x.date), b = calBits(x.date); return `
        <div class="cal-hero${n === 0 ? ' is-today' : ''}">
          <p class="mini">Next ${x.kind === 'mixtape' ? 'mixtape' : 'release'}</p>
          <div class="cal-count"><b>${n <= 0 ? 'TODAY' : n}</b>${n > 0 ? `<small>${n === 1 ? 'day' : 'days'}</small>` : ''}</div>
          <p class="cal-hero-t">${x.artist ? esc(x.artist) + ' - ' : ''}${esc(x.title)}</p>
          <p class="cal-hero-s">${x.cat ? `<span class="cal-cat">${esc(x.cat)}</span>` : ''}${b.wd} ${b.day} ${b.mon} ${b.yr}</p>
        </div>`; };
    const months = {};
    for (const x of next) (months[calMonth(x.date)] ||= []).push(x);
    const todo = ed ? calData.unscheduled : [];
    return `
      <div class="head"><div><p class="eyebrow">Schedule</p><h1>CALENDAR</h1></div>
        <div class="head-btns">${ed ? '<button type="button" class="btn primary" data-cal-act="new">+ Add date</button>' : ''}</div></div>
      ${calSyncNote()}
      ${nextOf('release') || nextOf('mixtape') ? `<div class="cal-heros">${hero(nextOf('release'))}${hero(nextOf('mixtape'))}</div>` : ''}
      ${todo.length ? `<h2 class="ct-group-h">Signed contracts without a date <span>${todo.length}</span></h2>
        <ol class="list">${todo.map(c => `
          <li class="row cal-todo" data-ctid="${esc(c.id)}">
            <span class="meta"><b>${esc(c.artist || '')}${c.release_name ? ' - ' + esc(c.release_name) : ''}</b><span>${[c.release_cat, 'Signed ' + fmtDate(c.signed_at)].filter(Boolean).map(esc).join(' · ')}</span></span>
            <input type="date" class="cal-pick" aria-label="Release date" min="${today}">
            <span class="row-btns"><button type="button" class="btn primary sm" data-cal-act="schedule">Add to calendar</button></span>
          </li>`).join('')}</ol>` : ''}
      ${Object.keys(months).length ? Object.entries(months).map(([m, l]) => `<h2 class="ct-group-h">${esc(m)} <span>${l.length}</span></h2><ol class="list">${l.map(row).join('')}</ol>`).join('') : '<ol class="list"><li class="empty">Nothing scheduled yet.</li></ol>'}
      ${past.length ? `<details class="cal-past"><summary>Past · ${past.length}</summary><ol class="list">${past.map(row).join('')}</ol></details>` : ''}`;
  }
  function calSyncNote() {
    const d = calData.discord;
    if (!d) return '<p class="info cal-sync">Dates come from the Discord channel #horizon-calendar (checked every 10 minutes).</p>';
    if (d.noAccess) return '<p class="login-error cal-sync">The Discord bot can’t see #horizon-calendar. In Discord, open the channel settings → Permissions → add the bot and allow <b>View Channel</b> and <b>Read Message History</b>.</p>';
    if (d.noText) return '<p class="login-error cal-sync">The Discord bot can’t read the text of #horizon-calendar. In the Discord Developer Portal → your bot → Bot, turn on <b>Message Content Intent</b>.</p>';
    const mins = Math.max(0, Math.round((Date.now() - d.at) / 60000));
    return `<p class="info cal-sync">Synced with Discord #horizon-calendar ${mins < 1 ? 'just now' : mins === 1 ? '1 minute ago' : mins + ' minutes ago'} · edit the dates there and they change here.</p>`;
  }
  function calForm() {
    const x = calOpen.item || { date: '', kind: 'release', artist: '', title: '', cat: '', note: '', programmed: 0 };
    return `
      <form id="cal-ed" class="editor ct-ed cal-ed" novalidate>
        <button type="button" class="back" data-cal-act="back">← Calendar</button>
        <h1>${calOpen.item ? 'EDIT DATE' : 'NEW DATE'}</h1>
        <div class="row2 wide"><div class="field"><label for="cl-date">Date</label><input id="cl-date" name="date" type="date" value="${esc(x.date)}"></div>
          <div class="field"><label for="cl-kind">Type</label><select id="cl-kind" name="kind">${Object.entries(CAL_KIND).map(([k, v]) => `<option value="${k}"${x.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div></div>
        <div class="row2 wide"><div class="field"><label for="cl-artist">Artist</label><input id="cl-artist" name="artist" maxlength="160" value="${esc(x.artist || '')}" autocomplete="off"></div>
          <div class="field"><label for="cl-title">Title</label><input id="cl-title" name="title" maxlength="160" value="${esc(x.title)}" autocomplete="off"></div></div>
        <div class="row2 wide"><div class="field"><label for="cl-cat">Release number</label><input id="cl-cat" name="cat" maxlength="40" value="${esc(x.cat || '')}" autocomplete="off" placeholder="HRZ#092"></div>
          <div class="field"><label for="cl-note">Note</label><input id="cl-note" name="note" maxlength="500" value="${esc(x.note || '')}" autocomplete="off"></div></div>
        <label class="check"><input type="checkbox" name="programmed"${x.programmed ? ' checked' : ''}> <span>Programmed (already scheduled in the distributor)</span></label>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions"><button type="submit" class="btn primary">Save</button><button type="button" class="btn ghost" data-cal-act="back">Cancel</button>${calOpen.item ? '<button type="button" class="btn ghost danger-txt" data-cal-act="del">Delete</button>' : ''}</div>
      </form>`;
  }
  async function calSave(body, ok) {
    busy = true;
    try { await api('POST', '/api/calendar', body); toast(ok); calOpen = null; calData = null; await loadCalendar(); }
    catch (e) { const b = $('#ed-error'); if (b) { b.textContent = e.message; b.hidden = false; } else toast(e.message); }
    finally { busy = false; }
  }
  document.addEventListener('click', async e => {
    if (view !== 'calendar') return;
    const t = e.target.closest('[data-cal-act]');
    if (!t || busy) return;
    const a = t.dataset.calAct, id = t.closest('[data-cal]')?.dataset.cal;
    if (a === 'new') { calOpen = { item: null }; render(); $('#cl-date')?.focus(); }
    else if (a === 'edit') { calOpen = { item: calData.items.find(x => x.id === id) }; render(); }
    else if (a === 'back') { calOpen = null; render(); }
    else if (a === 'del') {
      const x = calOpen.item;
      if (!await confirmBox(`Remove “${x.artist ? x.artist + ' - ' : ''}${x.title}” (${calDay(x.date)}) from the calendar?`, 'Remove')) return;
      busy = true;
      try { await api('DELETE', `/api/calendar/${encodeURIComponent(x.id)}`); toast('Removed'); calOpen = null; calData = null; await loadCalendar(); }
      catch (err) { toast(err.message); } finally { busy = false; }
    }
    else if (a === 'schedule') {
      // un contrato firmado → su fecha de salida
      const li = t.closest('[data-ctid]'), c = calData.unscheduled.find(x => x.id === li.dataset.ctid), date = $('.cal-pick', li).value;
      if (!date) { toast('Choose the release date first.'); $('.cal-pick', li).focus(); return; }
      await calSave({ date, kind: 'release', artist: c.artist, title: c.release_name || c.title, cat: c.release_cat, contract_id: c.id }, 'Added to the calendar');
    }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'cal-ed') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (busy) return;
    const f = e.target;
    await calSave({ id: calOpen.item?.id, date: f.elements.date.value, kind: f.elements.kind.value, artist: f.elements.artist.value, title: f.elements.title.value, cat: f.elements.cat.value, note: f.elements.note.value, programmed: f.elements.programmed.checked }, 'Saved');
  }, true);

  /* ---------------- Team chat (burbuja abajo a la derecha) ---------------- */
  const CHAT_SEEN = 'hz_chat_seen';
  const chatState = { on: false, open: false, timer: 0, last: 0, msgs: new Map(), me: '', owner: false, loading: false, seen: 0 };
  try { chatState.seen = Number(localStorage.getItem(CHAT_SEEN)) || 0; } catch { /* nada */ }
  const linkify = t => esc(t).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, '<br>');
  function chatEl() {
    let el = $('#chat');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'chat'; el.className = 'chat';
    el.innerHTML = `
      <button type="button" class="chat-fab" data-chat="toggle" aria-label="Team chat" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.9 2 11.6c0 2.6 1.4 4.9 3.6 6.5L5 22l4-2.2c.9.2 1.9.4 3 .4 5.5 0 10-3.9 10-8.6S17.5 3 12 3z"/></svg>
        <span class="chat-badge" hidden></span>
      </button>
      <section class="chat-box" hidden aria-label="Team chat">
        <header class="chat-head"><b>Team chat</b><button type="button" class="chat-x" data-chat="toggle" aria-label="Close">×</button></header>
        <ol class="chat-list" aria-live="polite"></ol>
        <form class="chat-form" novalidate>
          <textarea name="text" rows="1" maxlength="1000" placeholder="Write a message…" aria-label="Message"></textarea>
          <button type="submit" class="chat-send" aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg></button>
        </form>
      </section>`;
    document.body.appendChild(el);
    return el;
  }
  function chatBadge() {
    const el = $('#chat .chat-badge');
    if (!el) return;
    const n = [...chatState.msgs.values()].filter(m => m.id > chatState.seen && m.email !== chatState.me).length;
    el.hidden = !n || chatState.open; el.textContent = n > 9 ? '9+' : String(n);
  }
  function chatRender(stick) {
    const list = $('#chat .chat-list');
    if (!list) return;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const msgs = [...chatState.msgs.values()].sort((a, b) => a.id - b.id);
    let prev = null;
    list.innerHTML = msgs.length ? msgs.map(m => {
      const mine = m.email === chatState.me, d = new Date(m.at);
      const same = prev && prev.email === m.email && m.at - prev.at < 5 * 60e3;
      const day = !prev || new Date(prev.at).toDateString() !== d.toDateString();
      prev = m;
      const who = m.name || m.email.split('@')[0];
      return `${day ? `<li class="chat-day">${esc(d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</li>` : ''}
        <li class="chat-msg${mine ? ' mine' : ''}${same ? ' cont' : ''}" data-id="${m.id}">
          ${same || mine ? '' : `<span class="chat-av">${m.picture ? `<img src="${esc(m.picture)}" alt="" referrerpolicy="no-referrer">` : esc(who[0].toUpperCase())}</span>`}
          <div class="chat-bubble">
            ${same || mine ? '' : `<b style="${m.color ? `color:${esc(m.color)}` : ''}">${esc(who)}</b>`}
            <p>${linkify(m.text)}</p>
            <time>${esc(d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</time>
            ${mine || chatState.owner ? '<button type="button" class="chat-del" data-chat="del" aria-label="Delete message">×</button>' : ''}
          </div>
        </li>`;
    }).join('') : '<li class="chat-empty">No messages yet. Write the first one!</li>';
    if (stick || near) list.scrollTop = list.scrollHeight;
  }
  async function chatPoll() {
    clearTimeout(chatState.timer);
    if (!chatState.on) return;
    if (!document.hidden && !chatState.loading) {
      chatState.loading = true;
      try {
        const r = await api('GET', `/api/chat?after=${chatState.last}`);
        chatState.me = r.me; chatState.owner = r.owner;
        for (const id of r.gone || []) chatState.msgs.delete(id);
        for (const m of r.messages) { chatState.msgs.set(m.id, m); chatState.last = Math.max(chatState.last, m.id); }
        if (r.messages.length || (r.gone || []).length) chatRender(false);
        if (chatState.open) chatMarkSeen();
        chatBadge();
      } catch (e) {
        if (e.status === 401) { chatState.loading = false; logout(e.message); return; }
        if (e.status === 403) { chatStop(); return; }
      }
      chatState.loading = false;
    }
    chatState.timer = setTimeout(chatPoll, chatState.open ? 3000 : 20000);
  }
  function chatMarkSeen() {
    chatState.seen = chatState.last;
    try { localStorage.setItem(CHAT_SEEN, String(chatState.seen)); } catch { /* nada */ }
  }
  function chatStart() {
    if (chatState.on || !auth?.user) return;
    chatState.on = true;
    chatEl().hidden = false;
    chatPoll();
  }
  function chatStop() {
    chatState.on = false; chatState.open = false; clearTimeout(chatState.timer);
    chatState.msgs.clear(); chatState.last = 0;
    $('#chat')?.remove();
  }
  function chatToggle(force) {
    const el = chatEl(), open = force ?? !chatState.open;
    chatState.open = open;
    el.classList.toggle('is-open', open);
    el.querySelector('.chat-box').hidden = !open;
    el.querySelector('.chat-fab').setAttribute('aria-expanded', String(open));
    if (open) { chatRender(true); chatMarkSeen(); chatBadge(); el.querySelector('textarea').focus(); chatPoll(); }
    else chatBadge();
  }
  async function chatSend(form) {
    const ta = form.elements.text, text = ta.value.trim();
    if (!text) return;
    ta.disabled = true;
    try { await api('POST', '/api/chat', { text }); ta.value = ''; ta.style.height = ''; await chatPoll(); chatRender(true); }
    catch (e) { toast(e.message); }
    finally { ta.disabled = false; ta.focus(); }
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-chat]');
    if (!t) return;
    if (t.dataset.chat === 'toggle') chatToggle();
    if (t.dataset.chat === 'del') {
      const id = Number(t.closest('.chat-msg')?.dataset.id);
      if (!id || !await confirmBox('Delete this message?', 'Delete')) return;
      try { await api('DELETE', `/api/chat?id=${id}`); chatState.msgs.delete(id); chatRender(false); } catch (err) { toast(err.message); }
    }
  });
  document.addEventListener('submit', e => {
    if (!e.target.classList?.contains('chat-form')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    chatSend(e.target);
  }, true);
  document.addEventListener('keydown', e => {
    const ta = e.target.closest?.('.chat-form textarea');
    if (ta && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(ta.form); }
    if (e.key === 'Escape' && chatState.open) chatToggle(false);
  });
  document.addEventListener('input', e => {
    const ta = e.target.closest?.('.chat-form textarea');
    if (ta) { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && chatState.on) chatPoll(); });

  /* ---------------- Arranque ---------------- */
  async function boot() {
    auth = readAuth();
    if (!auth) { loginView(); return; }
    app.innerHTML = '<p class="boot">Loading…</p>';
    try {
      useSession(await api('GET', '/api/auth/me'));   // el rol puede haber cambiado desde la última vez
      const remembered = (() => { try { return !!localStorage.getItem(AUTH_KEY); } catch { return false; } })();
      saveAuth(auth, remembered);
      repo = firstView() === 'none' ? emptyRepo() : await loadRepo();
      go(lastView());   // al refrescar, sigues en la misma sección
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) { logout(e.message); return; }
      app.innerHTML = `<main class="login"><div class="login-card"><p class="login-error" role="alert">${esc(e.message)}</p>
        <button type="button" class="btn primary wide" id="retry">Retry</button>
        <button type="button" class="btn ghost wide" data-act="logout">Sign out</button></div></main>`;
      $('#retry').addEventListener('click', boot);
    }
  }
  boot();
})();
