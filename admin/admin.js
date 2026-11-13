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
    } catch { throw new GhError('Sin conexión con el servidor. Revisa tu internet y vuelve a intentarlo.'); }
    const j = await res.json().catch(() => ({}));
    if (res.ok) return j;
    throw new GhError(j.message || `Error del servidor (${res.status}).`, res.status);
  }
  /* Permisos del rol (el servidor los vuelve a comprobar en cada cambio) */
  const can = (sec, act = 'view') => !!(auth?.user?.owner || auth?.user?.perms?.[sec]?.[act]);

  async function loadRepo() {
    const d = await api('GET', '/api/data');
    const files = new Map();
    for (const [name, f] of Object.entries(d.files || {})) files.set('assets/' + name, { sha: String(f.v), size: f.size });
    return { head: d.version, files, releases: d.releases || [], mixtapes: d.mixtapes || [], playlists: d.playlists || [], ignore: d.ignore || [] };
  }

  /* Un «Publicar» = un cambio en el servidor. Las listas se recalculan sobre la versión más reciente
     (si alguien publicó a la vez, se reintenta sin pisar su cambio). Sale en la web al momento. */
  async function publish(message, uploads, build) {
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
    deploy('Publicando en la web…', 'busy');
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
      if (ok) { deploy('✓ Ya está en la web', 'ok'); watchTimer = setTimeout(() => id === watchId && deploy(), 5000); return; }
      if (Date.now() - start > 2 * 60e3) { deploy('Aún no se ve el cambio. Recarga la web en un momento.', 'warn'); watchTimer = setTimeout(() => id === watchId && deploy(), 15000); return; }
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
  function confirmBox(msg, okLabel = 'Eliminar') {
    const d = $('#confirm');
    $('#confirm-msg').textContent = msg; $('#confirm-ok').textContent = okLabel;
    d.returnValue = '';
    d.showModal();
    return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
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
    const c = hex6(repo?.releases?.[0]?.color) || '#ffffff';
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
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Usa una imagen JPG, PNG o WebP.');
    if (file.size > MAX_IMAGE_IN) throw new Error('La imagen pesa demasiado (máx. 30 MB).');
    const img = await decodeImage(file).catch(() => null);
    const w = img?.width || img?.naturalWidth, h = img?.height || img?.naturalHeight;
    if (!w || !h) throw new Error('No se pudo leer la imagen. Prueba con otro archivo.');
    const canvas = square(img, w, h, n);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .9));
    if (!blob) throw new Error('No se pudo preparar la imagen.');
    return { blob, url: URL.createObjectURL(blob), w, h, color: pickColor(canvas), small: Math.min(w, h) < n };
  }

  /* ---------------- Validación ---------------- */
  class FieldError extends Error { constructor(field, msg) { super(msg); this.field = field; } }
  function text(form, name, label, { max = 120, missing = '' } = {}) {
    const v = String(form.elements[name]?.value ?? '').replace(/\s+/g, ' ').trim();
    if (missing && !v) throw new FieldError(name, missing);
    if (/[<>]/.test(v)) throw new FieldError(name, `${label}: no uses los signos < ni > (la web los interpreta como código).`);
    if (v.length > max) throw new FieldError(name, `${label}: máximo ${max} caracteres.`);
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
    try { u = new URL(v); } catch { throw new FieldError(name, `${label}: no es un enlace válido.`); }
    if (u.protocol !== 'https:') throw new FieldError(name, `${label}: debe empezar por https://`);
    if (/["'<>\s\\`]/.test(v)) throw new FieldError(name, `${label}: el enlace tiene caracteres no válidos.`);
    if (hosts && !hosts.some(h => h.test(u.hostname))) throw new FieldError(name, `${label}: no parece un enlace de ${label}.`);
    return v;
  }
  function position(form, max) {
    const n = Number(form.elements.position?.value);
    if (!Number.isInteger(n) || n < 1) throw new FieldError('position', 'Posición: escribe un número desde 1.');
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
      s.onerror = () => { gisLoad = null; ko(new Error('No se pudo cargar el botón de Google. Revisa tu internet o desactiva el bloqueador de anuncios en esta página.')); };
      document.head.appendChild(s);
    });
    return gisLoad;
  }
  function loginError(msg) {
    const el = $('.login-error');
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
  }
  async function loginView(message = '') {
    document.title = MODE === 'team' ? 'Equipo — HORIZON RCRDS' : 'Panel — HORIZON RCRDS';
    app.innerHTML = `
      <main class="login">
        <div class="login-card">
          <img class="login-logo" src="${SITE}assets/logo.png" alt="">
          <h1>HORIZON <span>RCRDS</span></h1>
          <p class="login-sub">${MODE === 'team' ? 'Equipo' : 'Panel · Owners'}</p>
          <p class="login-text">${MODE === 'team' ? 'Entra con la cuenta de Google con la que te han dado de alta en el equipo.' : 'Solo para los owners. Entra con tu cuenta de Google.'}</p>
          <div id="g-btn" class="g-btn"></div>
          <form id="dev-login" class="dev-login" hidden novalidate>
            <div class="field"><label for="dev-email">Prueba local · email</label><input id="dev-email" name="email" type="email" autocomplete="off" spellcheck="false"></div>
            <button class="btn ghost wide" type="submit">Entrar (prueba local)</button>
          </form>
          <label class="check"><input type="checkbox" id="remember" checked><span>Recordar en este navegador</span></label>
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
        google.accounts.id.renderButton($('#g-btn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'es', width: 280 });
      } else if (!serverCfg.dev) throw new Error('El panel aún no está configurado: falta el ID de cliente de Google en el servidor.');
    } catch (e) { serverCfg = null; loginError(e.message); }
  }

  const VIEWS = ['releases', 'radio', 'playlists', 'player'];
  const firstView = () => VIEWS.find(v => can(v)) || (MODE === 'admin' && auth?.user?.owner ? 'team' : 'none');
  const emptyRepo = () => ({ head: '', treeSha: '', files: new Map(), truncated: false, releases: [], mixtapes: [], playlists: [], ignore: [] });
  function useSession(res) {
    auth = { token: res.token || auth?.token, user: res.user, sections: res.sections };
  }
  async function login(cred) {
    const card = $('.login-card'), remember = $('#remember')?.checked !== false;
    loginError(''); card?.setAttribute('aria-busy', 'true');
    try {
      const res = await api('POST', cred.email ? '/api/auth/dev' : '/api/auth/login', cred.email ? { email: cred.email, area: MODE } : { credential: cred.credential, area: MODE });
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
    clearAuth(); auth = null; repo = null; editing = null; setDirtyBase(null); teamData = null; teamErr = '';
    watchId++; deploy();
    loginView(message);
  }

  function shell(inner) {
    const tab = (id, label) => `<button type="button" class="tab${view === id || (editing && editing.view === id) ? ' is-on' : ''}" data-view="${id}">${label}</button>`;
    const u = auth.user, names = { releases: 'Releases', radio: 'Mixtapes', playlists: 'Playlists', player: 'Reproductor' };
    const initials = (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');
    return `
      <header class="top">
        <a class="brand" href="${SITE}" target="_blank" rel="noopener" aria-label="Abrir la web">
          <img src="${SITE}assets/logo.png" alt="">
          <span class="word">HORIZON<small>RCRDS</small></span>
        </a>
        <nav class="tabs" aria-label="Secciones">
          ${VIEWS.filter(v => can(v)).map(v => tab(v, names[v])).join('')}${MODE === 'admin' && u.owner ? tab('team', 'Equipo') + tab('log', 'Historial') : ''}
        </nav>
        <div class="top-end">
          <span class="who" title="${esc(u.email)}">
            ${u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="who-ini">${esc(initials)}</span>`}
            <span class="who-txt"><b>${esc(u.name || u.email.split('@')[0])}</b><small>${esc(u.owner ? 'Owner' : u.role?.name || 'Sin rol')}</small></span>
          </span>
          <a class="link" href="${SITE}" target="_blank" rel="noopener">Ver web ↗</a>
          <button type="button" class="link" data-act="logout">Salir</button>
        </div>
      </header>
      <main id="main" class="main" tabindex="-1">${inner}</main>`;
  }
  function noAccessView() {
    return `<div class="head"><div><p class="eyebrow">Equipo</p><h1>SIN SECCIONES</h1></div></div>
      <p class="info">Tu rol (${esc(auth.user.role?.name || 'sin rol')}) todavía no tiene ninguna sección. Cuando un owner te dé acceso, sal y vuelve a entrar.</p>`;
  }

  /* ---------------- Equipo y roles (solo owners, en /admin) ---------------- */
  let teamData = null, teamErr = '', teamLoading = false, newRole = false;
  const ACTIONS = { view: 'Ver', edit: 'Editar', delete: 'Eliminar' };
  const fmtDate = t => t ? new Date(t).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';
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
  function roleCard(r) {
    const isNew = !r.id;
    return `
      <form class="role-card" data-role="${esc(r.id || '')}" novalidate>
        <div class="role-top">
          <input name="name" value="${esc(r.name || '')}" maxlength="40" placeholder="Nombre del rol (p. ej. A&R, Mod)" aria-label="Nombre del rol" autocomplete="off">
          <button type="submit" class="btn primary sm">${isNew ? 'Crear rol' : 'Guardar'}</button>
          ${isNew ? '<button type="button" class="btn ghost sm" data-act="cancel-role">Cancelar</button>' : '<button type="button" class="btn danger sm" data-act="delete-role">Eliminar</button>'}
        </div>
        <table class="perm-table">
          <thead><tr><th scope="col">Sección</th>${Object.values(ACTIONS).map(a => `<th scope="col">${a}</th>`).join('')}</tr></thead>
          <tbody>${teamData.sections.map(s => `
            <tr><th scope="row">${esc(s.label)}</th>${Object.keys(ACTIONS).map(a => `<td>${s.actions.includes(a)
              ? `<label class="perm"><input type="checkbox" name="${esc(s.id)}.${a}" ${r.perms?.[s.id]?.[a] ? 'checked' : ''} aria-label="${esc(s.label)}: ${ACTIONS[a]}"><span></span></label>`
              : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
        <p class="ed-error" role="alert" hidden></p>
      </form>`;
  }
  function teamView() {
    const head = `<div class="head"><div><p class="eyebrow">Accesos</p><h1>EQUIPO${teamData ? ` <span class="count">${teamData.owners.length + teamData.members.length}</span>` : ''}</h1></div></div>`;
    if (!teamData) {
      if (!teamErr) setTimeout(loadTeam, 0);
      return head + (teamErr ? `<p class="login-error" role="alert">${esc(teamErr)}</p><button type="button" class="btn ghost" data-act="team-retry">Reintentar</button>` : '<p class="info">Cargando…</p>');
    }
    const { owners, members, roles } = teamData;
    const roleOpts = sel => roles.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    const person = (name, email, pic) => `
      ${pic ? `<img class="thumb round" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span class="thumb round ini">${esc((name || email)[0].toUpperCase())}</span>`}
      <span class="meta"><b>${esc(name || email)}</b><span>${esc(name ? email : '')}</span></span>`;
    return `${head}
      <p class="info lead">Cada persona entra en <b>horizonrcrds.com/team</b> con su cuenta de Google y solo ve lo que permite su rol. /admin es solo para los owners.</p>
      <ol class="list team-list">
        ${owners.map(e => `<li class="row tm">${person('', e, '')}<span class="tag">Owner</span><span class="muted sm-txt">Acceso total</span><span></span></li>`).join('')}
        ${members.map(m => `
          <li class="row tm">
            <label class="color-dot" style="--c:${esc(m.color || '#ffffff')}" title="Color de ${esc(m.label || m.email)}"><input type="color" class="color-in" data-member="${esc(m.email)}" value="${esc(m.color || '#ffffff')}" aria-label="Color de ${esc(m.label || m.email)}"></label>
            <span class="meta" title="${esc(m.email)}"><input class="name-in" data-member="${esc(m.email)}" value="${esc(m.label || '')}" placeholder="${esc(m.name || m.email.split('@')[0])}" maxlength="40" aria-label="Nombre de ${esc(m.email)}" autocomplete="off" style="color:${esc(m.color || '#ffffff')}"></span>
            <select class="role-sel" data-member="${esc(m.email)}" aria-label="Rol de ${esc(m.email)}">${m.role_id && roles.some(r => r.id === m.role_id) ? '' : '<option value="" selected>Sin rol</option>'}${roleOpts(m.role_id)}</select>
            <span class="muted sm-txt" title="${m.last_login ? 'Última vez: ' + esc(fmtDate(m.last_login)) : ''}">Acceso activo</span>
            <button type="button" class="btn ghost sm" data-act="remove-member" data-email="${esc(m.email)}">Quitar</button>
          </li>`).join('')}
      </ol>
      ${roles.length ? `
      <form id="add-member" class="add-row" novalidate>
        <input name="email" type="email" placeholder="email@gmail.com" aria-label="Email de Google" autocomplete="off" spellcheck="false">
        <input name="label" placeholder="Nombre (p. ej. Kris m)" maxlength="40" aria-label="Nombre" autocomplete="off">
        <label class="color-dot big" style="--c:#a78bfa" title="Color"><input type="color" name="color" value="#a78bfa" aria-label="Color"></label>
        <select name="role_id" aria-label="Rol">${roleOpts(roles[0].id)}</select>
        <button type="submit" class="btn primary">Añadir</button>
        <p class="ed-error" role="alert" hidden></p>
      </form>` : '<p class="info">Crea primero un rol (abajo) para poder añadir personas.</p>'}

      <div class="head sub"><div><p class="eyebrow">Permisos</p><h2>ROLES <span class="count">${roles.length}</span></h2></div>
        ${newRole ? '' : '<button type="button" class="btn ghost" data-act="new-role">+ Nuevo rol</button>'}</div>
      <p class="info">Marca lo que puede hacer cada rol. «Editar» incluye crear. Los owners siempre lo tienen todo.</p>
      <div class="roles">${newRole ? roleCard({ perms: {} }) : ''}${roles.map(roleCard).join('')}${!roles.length && !newRole ? '<p class="info">Todavía no hay roles.</p>' : ''}</div>`;
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
    const opts = logState.people.slice().sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
      .map(p => `<option value="${esc(p.email)}" ${p.email === logState.who ? 'selected' : ''}>${esc(p.name ? `${p.name} · ${p.email}` : p.email)}</option>`).join('');
    let day = '';
    const rows = logState.items.map(x => {
      const d = new Date(x.at), k = d.toDateString();
      const head = k !== day ? `<li class="log-day">${esc(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</li>` : '';
      day = k;
      const kind = /^Entró/.test(x.action) ? 'in' : /(Añadió|Quitó|rol)/.test(x.action) ? 'team' : 'web';
      return `${head}<li class="row lg ${kind}"><span class="muted">${esc(d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}</span><b style="${x.color ? `color:${esc(x.color)}` : ''}" title="${esc(x.email)}">${esc(x.name || x.email)}</b><span>${esc(x.action)}</span></li>`;
    }).join('');
    return `<div class="head"><div><p class="eyebrow">Quién hizo qué</p><h1>HISTORIAL</h1></div>
        <select class="log-who" aria-label="Ver el historial de"><option value="">Todo el equipo</option>${opts}</select></div>
      <p class="info lead">Todo lo que pasa en el panel: quién entra, qué publica, qué borra y los cambios del equipo. Solo lo veis los owners.</p>
      ${logState.err ? `<p class="login-error" role="alert">${esc(logState.err)}</p>` : ''}
      <ol class="list log">${rows || `<li class="empty">${logState.loading || !logState.loaded ? 'Cargando…' : 'Nada todavía.'}</li>`}</ol>
      ${logState.more ? `<button type="button" class="btn ghost log-more" data-act="log-more"${logState.loading ? ' disabled' : ''}>Ver más</button>` : ''}`;
  }

  function rolePerms(form) {
    const perms = {};
    for (const s of teamData.sections) {
      perms[s.id] = {};
      for (const a of s.actions) perms[s.id][a] = !!form.elements[`${s.id}.${a}`]?.checked;
    }
    return perms;
  }
  async function teamAction(fn, okMsg, errBox) {
    busy = true;
    try { await fn(); if (okMsg) toast(okMsg); newRole = false; teamData = null; await loadTeam(); }
    catch (e) {
      if (e.status === 401) { logout(e.message); return; }
      if (errBox) { errBox.textContent = e.message; errBox.hidden = false; } else toast(e.message);
    } finally { busy = false; }
  }

  /* Qué enlaces tiene cada uno (encendido = puesto) */
  const CHIP = { spotify_link: 'Spotify', soundcloud_link: 'SoundCloud', youtube_link: 'YouTube', stream_link: 'Smart link' };
  const CHIP_SHORT = { spotify_link: 'SP', soundcloud_link: 'SC', youtube_link: 'YT', stream_link: 'LINK' };
  const linkChips = (x, keys) => `<span class="links">${keys.map(k => x[k]
    ? `<a class="chip on" href="${esc(x[k])}" target="_blank" rel="noopener" title="${CHIP[k]}">${CHIP_SHORT[k]}</a>`
    : `<span class="chip" title="Sin ${CHIP[k]}">${CHIP_SHORT[k]}</span>`).join('')}</span>`;

  /* Releases */
  function releaseRows() {
    const q = filter.trim().toLowerCase();
    const rows = repo.releases.map((r, i) => ({ r, i })).filter(({ r }) => !q || [r.title, r.artist, catOf(r)].join(' ').toLowerCase().includes(q));
    if (!rows.length) return `<li class="empty">Nada coincide con «${esc(filter)}».</li>`;
    return rows.map(({ r, i }) => `
      <li class="row">
        <span class="pos">${i + 1}</span>
        ${imgTag(r.image, 'thumb')}
        <span class="meta"><b>${esc(r.title || 'Sin título')}</b><span>${esc(r.artist || '')}</span></span>
        <span class="cat">${esc(catOf(r))}</span>
        ${linkChips(r, ['spotify_link', 'soundcloud_link', 'youtube_link', 'stream_link'])}
        <span class="swatch" style="--c:${esc(hex6(r.color) || '#ffffff')}" title="${esc(r.color || '')}"></span>
        ${i === 0 ? '<span class="tag">Portada</span>' : '<span></span>'}
        ${can('releases', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-release" data-key="${esc(keyOf(r))}">Editar</button>` : '<span></span>'}
      </li>`).join('');
  }
  function releasesView() {
    return `
      <div class="head">
        <div><p class="eyebrow">Discography</p><h1>RELEASES <span class="count">${repo.releases.length}</span></h1></div>
        ${can('releases', 'edit') ? '<button type="button" class="btn primary" data-act="new-release">+ Nuevo lanzamiento</button>' : ''}
      </div>
      <input class="search" type="search" id="rel-filter" placeholder="Buscar" aria-label="Buscar lanzamientos" value="${esc(filter)}">
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
        <h1>${isNew ? 'NUEVO LANZAMIENTO' : esc(r.title || 'Sin título')}</h1>
        <div class="ed-grid">
          <div class="ed-side">
            ${coverDrop(cover, r.image && !editing.cover ? P('assets/' + r.image) : '', 'Portada')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
            <div class="field">
              <label for="f-color">Color</label>
              <div class="color-row">
                <input type="color" id="f-color-pick" value="${esc(color)}" aria-label="Elegir color">
                <input id="f-color" name="color" value="${esc(color)}" maxlength="7" spellcheck="false" autocomplete="off">
                <span class="badge-prev" id="color-prev" style="--c:${esc(color)}">${esc(catOf(r) || nextCatalog(repo.releases))}</span>
              </div>
            </div>
          </div>
          <div class="ed-main">
            <div class="field"><label for="f-title">Título</label><input id="f-title" name="title" value="${esc(r.title || '')}" maxlength="120" autocomplete="off"></div>
            <div class="field"><label for="f-artist">Artistas</label><input id="f-artist" name="artist" value="${esc(r.artist || '')}" maxlength="160" autocomplete="off"></div>
            <div class="row2">
              <div class="field"><label for="f-catalog">Nº de catálogo</label><input id="f-catalog" name="catalog" value="${esc(catOf(r) || nextCatalog(repo.releases))}" maxlength="20" autocomplete="off" spellcheck="false"></div>
              <div class="field"><label for="f-position">Posición</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? 1 : editing.index + 1}" inputmode="numeric"></div>
            </div>
            <p class="group">Enlaces</p>
            <div class="field"><label for="f-stream">Stream (smart link)</label><input id="f-stream" name="stream_link" type="url" value="${esc(r.stream_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://"></div>
            <div class="field"><label for="f-spotify">Spotify</label><input id="f-spotify" name="spotify_link" type="url" value="${esc(r.spotify_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://open.spotify.com/…"></div>
            <div class="field"><label for="f-soundcloud">SoundCloud</label><input id="f-soundcloud" name="soundcloud_link" type="url" value="${esc(r.soundcloud_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://soundcloud.com/…"></div>
            <div class="field"><label for="f-youtube">YouTube</label><input id="f-youtube" name="youtube_link" type="url" value="${esc(r.youtube_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…"></div>
            <div class="field"><label for="f-desc">Descripción</label><textarea id="f-desc" name="description" rows="3" maxlength="400">${esc(r.description || '')}</textarea></div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publicar' : 'Guardar cambios'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancelar</button>
          ${isNew || !can('releases', 'delete') ? '' : `${r.soundcloud_link ? '<button type="button" class="btn ghost push" data-act="exclude-release">Excluir</button>' : ''}<button type="button" class="btn danger${r.soundcloud_link ? '' : ' push'}" data-act="delete-release">Eliminar</button>`}
        </div>
      </form>`;
  }
  function coverDrop(src, repoPath, label) {
    return `
      <div class="drop" data-drop>
        <input type="file" id="ed-file" class="sr-only" accept="image/jpeg,image/png,image/webp">
        <label for="ed-file" class="drop-in">
          ${src ? `<img src="${esc(src)}" ${repoPath ? `data-repo="${esc(repoPath)}"` : ''} alt="">` : ''}
          <span class="drop-hint">${src ? 'Cambiar ' + label.toLowerCase() : `${label}<small>Arrastra o pulsa · JPG, PNG o WebP</small>`}</span>
        </label>
      </div>`;
  }
  function coverInfo() {
    const c = editing?.cover;
    if (!c) return '';
    const parts = [`${c.w}×${c.h} → ${Math.min(c.w, c.h, editing.px)}×${Math.min(c.w, c.h, editing.px)}`];
    if (c.w !== c.h) parts.push('recortada al centro');
    if (c.small) parts.push(`<span class="warn">pequeña: mejor ${editing.px} px o más</span>`);
    return parts.join(' · ');
  }

  async function saveRelease(form) {
    const isNew = !editing.key, orig = editing.orig || {};
    const v = {
      title: text(form, 'title', 'Título', { missing: 'Falta el título.' }),
      artist: text(form, 'artist', 'Artistas', { max: 160, missing: 'Faltan los artistas.' }),
      catalog: text(form, 'catalog', 'Nº de catálogo', { max: 20, missing: 'Falta el nº de catálogo.' }),
      stream_link: link(form, 'stream_link', 'Stream', null),
      spotify_link: link(form, 'spotify_link', 'Spotify', HOSTS.spotify),
      soundcloud_link: link(form, 'soundcloud_link', 'SoundCloud', HOSTS.soundcloud),
      youtube_link: link(form, 'youtube_link', 'YouTube', HOSTS.youtube),
      description: text(form, 'description', 'Descripción', { max: 400 }),
    };
    const color = hex6(form.elements.color.value);
    if (!color) throw new FieldError('color', 'Color: escribe un color como #ff68b2.');
    if (!v.stream_link && !v.spotify_link && !v.soundcloud_link) throw new FieldError('stream_link', 'Pon al menos un enlace.');
    if (isNew && !editing.cover) throw new Error('Falta la portada.');
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
      if (!isNew && idx < 0) throw new Error('Este lanzamiento ya no está en la web (lo han borrado desde otro sitio). Vuelve a la lista.');
      if (list.some((r, i) => i !== idx && normCat(catOf(r)) === normCat(v.catalog))) throw new FieldError('catalog', `Ya hay un lanzamiento con el nº ${v.catalog}.`);
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
    afterPublish(res, isNew ? 'Lanzamiento publicado' : 'Cambios guardados', [jsonProbe('releases.json', res.out.releases), ...uploads.map(u => fileProbe(image, u.blob))]);
    go('releases');
  }
  /* «Eliminar» only takes it off the site: if it is still on SoundCloud, the sync adds it again.
     «Excluir» also writes it to sync-ignore.json, so the SoundCloud sync (scripts/sync-soundcloud.mjs)
     never adds it again; «Permitir de nuevo» in the Excluidos list undoes that. */
  const ignoreEntry = (fresh, item, name, kind) => item?.soundcloud_link
    ? [...fresh.ignore.filter(x => x.soundcloud_link !== item.soundcloud_link), { soundcloud_link: item.soundcloud_link, title: name, kind, removed: new Date().toISOString().slice(0, 10) }]
    : undefined;
  const ignoreKind = x => x.kind || (/mixtape/i.test(x.title || '') ? 'mixtape' : 'release');
  function excludedHtml(kind) {
    const list = (repo.ignore || []).filter(x => ignoreKind(x) === kind);
    if (!list.length) return '';
    return `
      <section class="excluded">
        <h2>Excluidos <span class="count">${list.length}</span></h2>
        <ol class="list">${list.map(x => `
          <li class="row ex">
            <span class="meta"><b>${esc(x.title || x.soundcloud_link)}</b><span>${esc(x.removed ? 'Excluido el ' + x.removed : '')}</span></span>
            <a class="link" href="${esc(x.soundcloud_link)}" target="_blank" rel="noopener">SoundCloud ↗</a>
            ${can(kind === 'mixtape' ? 'radio' : 'releases', 'delete') ? `<button type="button" class="btn ghost sm" data-act="unexclude" data-link="${esc(x.soundcloud_link)}">Permitir de nuevo</button>` : '<span></span>'}
          </li>`).join('')}
        </ol>
      </section>`;
  }
  async function unexclude(link) {
    const x = (repo.ignore || []).find(i => i.soundcloud_link === link);
    if (!x) return;
    if (!await confirmBox(`¿Permitir de nuevo «${x.title || link}»? Si sigue en SoundCloud, la sincronización lo volverá a añadir a la web.`, 'Permitir')) return;
    const res = await publish(`Allow again from SoundCloud — ${x.title || link}`, [], fresh => {
      const ignore = fresh.ignore.filter(i => i.soundcloud_link !== link);
      if (ignore.length === fresh.ignore.length) throw new Error('Ya no estaba excluido.');
      return { ignore };
    });
    if (res.unchanged) toast('No había nada que cambiar'); else toast('Permitido de nuevo');
    render();
  }
  async function deleteRelease(exclude) {
    const r = editing.orig;
    if (repo.releases.length <= 1) throw new Error('La web necesita al menos un lanzamiento.');
    const ask = exclude
      ? `¿Excluir «${r.title || catOf(r)}»? Se quita de la web y la sincronización con SoundCloud no lo volverá a añadir (se puede deshacer en «Excluidos»).`
      : `¿Eliminar «${r.title || catOf(r)}» de la web? También se borra su portada.${r.soundcloud_link ? ' Si sigue en SoundCloud, volverá en la próxima sincronización (para que no vuelva, usa «Excluir»).' : ''}`;
    if (!await confirmBox(ask, exclude ? 'Excluir' : 'Eliminar')) return false;
    const res = await publish(`${exclude ? 'Exclude' : 'Remove'} release ${catOf(r)} — ${r.title || ''}`, [], fresh => {
      const list = fresh.releases.filter(x => keyOf(x) !== editing.key);
      if (list.length === fresh.releases.length) throw new Error('Este lanzamiento ya no estaba en la web.');
      if (!list.length) throw new Error('La web necesita al menos un lanzamiento.');
      const item = fresh.releases.find(x => keyOf(x) === editing.key), gone = item?.image;
      return {
        releases: list,
        remove: gone && safeFile(gone) && !list.some(x => x.image === gone) ? [P('assets/' + gone)] : [],
        ignore: exclude ? ignoreEntry(fresh, item, `${item?.artist || ''} - ${item?.title || ''}`, 'release') : undefined,
      };
    });
    afterPublish(res, exclude ? 'Lanzamiento excluido' : 'Lanzamiento eliminado', [jsonProbe('releases.json', res.out.releases)]);
    go('releases');
    return true;
  }

  /* Radio (mixtapes.json): el enlace de SoundCloud rellena número, título, invitado, portada y color */
  function radioView() {
    const list = repo.mixtapes;
    return `
      <div class="head">
        <div><p class="eyebrow">Horizon Mixtapes</p><h1>MIXTAPES <span class="count">${list.length}</span></h1></div>
        ${can('radio', 'edit') ? '<button type="button" class="btn primary" data-act="new-mixtape">+ Nuevo mixtape</button>' : ''}
      </div>
      <ol class="list">${list.length ? list.map((m, i) => `
        <li class="row">
          <span class="pos">${i + 1}</span>
          ${imgTag(m.image, 'thumb')}
          <span class="meta"><b>${esc(m.number ? 'Horizon Mixtape ' + m.number : m.title || 'Sin título')}</b><span>${esc(m.artist || '')}</span></span>
          <span class="cat">${m.preview ? '♪ Audio' : '<span class="muted">Sin audio</span>'}</span>
          ${linkChips(m, ['soundcloud_link', 'youtube_link'])}
          <span class="swatch" style="--c:${esc(hex6(m.color) || '#ffffff')}"></span>
          ${i === 0 ? '<span class="tag">Portada</span>' : '<span></span>'}
          ${can('radio', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-mixtape" data-key="${esc(keyOf(m))}">Editar</button>` : '<span></span>'}
        </li>`).join('') : '<li class="empty">Todavía no hay mixtapes.</li>'}
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
            ${coverDrop(cover, m.image && !editing.cover ? P('assets/' + m.image) : '', 'Portada')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
            <div class="field">
              <label for="f-color">Color</label>
              <div class="color-row">
                <input type="color" id="f-color-pick" value="${esc(color)}" aria-label="Elegir color">
                <input id="f-color" name="color" value="${esc(color)}" maxlength="7" spellcheck="false" autocomplete="off">
                <span class="badge-prev" id="color-prev" style="--c:${esc(color)}">RADIO</span>
              </div>
            </div>
          </div>
          <div class="ed-main">
            <div class="field">
              <label for="f-sc">Enlace de SoundCloud</label>
              <div class="sc-row">
                <input id="f-sc" name="soundcloud_link" type="url" value="${esc(m.soundcloud_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://soundcloud.com/horizonirecords/…">
                <button type="button" class="btn ghost" data-act="sc-fill">Rellenar</button>
              </div>
              <p class="info sc-info" id="sc-info"></p>
            </div>
            <div class="field"><label for="f-yt">Enlace de YouTube</label><input id="f-yt" name="youtube_link" type="url" value="${esc(m.youtube_link || '')}" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=…"></div>
            <div class="row2">
              <div class="field"><label for="f-title">Título</label><input id="f-title" name="title" value="${esc(m.title || 'HORIZON RCRDS Mixtape ' + number)}" maxlength="120" autocomplete="off"></div>
              <div class="field"><label for="f-number">Nº</label><input id="f-number" name="number" value="${esc(number)}" maxlength="12" autocomplete="off" spellcheck="false"></div>
            </div>
            <div class="row2">
              <div class="field"><label for="f-artist">Artista invitado</label><input id="f-artist" name="artist" value="${esc(m.artist || '')}" maxlength="120" autocomplete="off"></div>
              <div class="field"><label for="f-position">Posición</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? 1 : editing.index + 1}" inputmode="numeric"></div>
            </div>
            <p class="group">Fragmento de audio</p>
            <div class="mx-audio" id="mx-audio">${mixAudioHtml()}</div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publicar' : 'Guardar cambios'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancelar</button>
          ${isNew || !can('radio', 'delete') ? '' : `${m.soundcloud_link ? '<button type="button" class="btn ghost push" data-act="exclude-mixtape">Excluir</button>' : ''}<button type="button" class="btn danger${m.soundcloud_link ? '' : ' push'}" data-act="delete-mixtape">Eliminar</button>`}
        </div>
      </form>`;
  }
  function mixAudioHtml() {
    const a = editing.audio, cur = !editing.removeAudio && editing.orig?.preview;
    const src = a?.url || (cur ? assetSrc(cur) : '');
    return `
      ${src ? `<audio controls preload="metadata" src="${esc(src)}"></audio>` : ''}
      ${a ? `<p class="info">${esc(a.name)} · ${(a.blob.size / 1048576).toFixed(1)} MB</p>` : src ? '' : '<p class="info">Sin fragmento: en la web el botón abre el mix en SoundCloud.</p>'}
      <div class="card-actions">
        <input type="file" id="mx-file" class="sr-only" accept="audio/mpeg,.mp3">
        <label for="mx-file" class="btn ghost sm">${src ? 'Cambiar MP3' : 'Elegir MP3'}</label>
        ${src ? '<button type="button" class="btn ghost sm" data-act="mx-remove-audio">Quitar</button>' : ''}
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
    try { u = new URL(input.value.trim()); } catch { if (force) showError(new FieldError('soundcloud_link', 'Pega primero el enlace de SoundCloud del mixtape.')); return; }
    if (!HOSTS.soundcloud.some(h => h.test(u.hostname))) { if (force) showError(new FieldError('soundcloud_link', 'Ese enlace no es de SoundCloud.')); return; }
    const id = ++scSeq;
    info.textContent = 'Leyendo SoundCloud…';
    try {
      const res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u.href)}`).catch(() => null);
      if (!res?.ok) throw new Error('SoundCloud no encuentra ese enlace (¿es público?).');
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
      info.textContent = gotCover || !force ? '✓ Datos de SoundCloud' : '✓ Datos de SoundCloud (sin portada: súbela a mano)';
    } catch (e) {
      if (id === scSeq) info.textContent = e.message;
    }
  }
  async function saveMixtape(form) {
    const isNew = !editing.key, orig = editing.orig || {};
    const v = {
      soundcloud_link: link(form, 'soundcloud_link', 'SoundCloud', HOSTS.soundcloud, 'Falta el enlace de SoundCloud.'),
      title: text(form, 'title', 'Título', { missing: 'Falta el título.' }),
      number: normNumber(text(form, 'number', 'Nº', { max: 12, missing: 'Falta el número.' })),
      artist: text(form, 'artist', 'Artista invitado', { max: 120 }),
      youtube_link: link(form, 'youtube_link', 'YouTube', HOSTS.youtube),
    };
    const color = hex6(form.elements.color.value);
    if (!color) throw new FieldError('color', 'Color: escribe un color como #ff68b2.');
    if (isNew && !editing.cover) throw new Error('Falta la portada (pega el enlace de SoundCloud o súbela).');
    const pos = position(form, isNew ? repo.mixtapes.length + 1 : repo.mixtapes.length);
    const base = 'mix' + (normCat(v.number) || 'tape');
    let image = orig.image, preview = editing.removeAudio ? undefined : orig.preview;
    const uploads = [];
    if (editing.cover) { image = uniqueName(base, 'jpg'); uploads.push({ path: P('assets/' + image), blob: editing.cover.blob }); }
    if (editing.audio) { preview = uniqueName(base, 'mp3'); uploads.push({ path: P('assets/' + preview), blob: editing.audio.blob }); }
    const res = await publish(`${isNew ? 'Add' : 'Update'} mixtape ${v.number}${v.artist ? ' — ' + v.artist : ''}`, uploads, fresh => {
      const list = fresh.mixtapes.slice();
      const idx = isNew ? -1 : list.findIndex(m => keyOf(m) === editing.key);
      if (!isNew && idx < 0) throw new Error('Este mixtape ya no está en la web (lo han borrado desde otro sitio). Vuelve a la lista.');
      if (list.some((m, i) => i !== idx && m.number && normCat(m.number) === normCat(v.number))) throw new FieldError('number', `Ya hay un mixtape ${v.number}.`);
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
    afterPublish(res, isNew ? 'Mixtape publicado' : 'Cambios guardados', [jsonProbe('mixtapes.json', res.out.mixtapes), ...uploads.map(u => fileProbe(u.path.split('/').pop(), u.blob))]);
    go('radio');
  }
  async function deleteMixtape(exclude) {
    const m = editing.orig;
    const ask = exclude
      ? `¿Excluir «Horizon Mixtape ${m.number || ''}»? Se quita de la web y la sincronización con SoundCloud no lo volverá a añadir (se puede deshacer en «Excluidos»).`
      : `¿Eliminar «Horizon Mixtape ${m.number || ''}» de la web? También se borran su portada y su audio.${m.soundcloud_link ? ' Si sigue en SoundCloud, volverá en la próxima sincronización (para que no vuelva, usa «Excluir»).' : ''}`;
    if (!await confirmBox(ask, exclude ? 'Excluir' : 'Eliminar')) return false;
    const res = await publish(`${exclude ? 'Exclude' : 'Remove'} mixtape ${m.number || ''}`, [], fresh => {
      const list = fresh.mixtapes.filter(x => keyOf(x) !== editing.key);
      if (list.length === fresh.mixtapes.length) throw new Error('Este mixtape ya no estaba en la web.');
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
        ${can('playlists', 'edit') ? '<button type="button" class="btn primary" data-act="new-playlist">+ Nueva playlist</button>' : ''}
      </div>
      <ol class="list">${list.length ? list.map((p, i) => `
        <li class="row pl">
          <span class="pos">${i + 1}</span>
          ${imgTag(p.image, 'thumb')}
          <span class="meta"><b>${esc(p.title || 'Sin título')}</b><span>${esc(p.description || '')}</span></span>
          ${can('playlists', 'edit') ? `<button type="button" class="btn ghost sm" data-act="edit-playlist" data-index="${i}">Editar</button>` : '<span></span>'}
        </li>`).join('') : '<li class="empty">Todavía no hay playlists.</li>'}
      </ol>`;
  }
  function playlistEditor() {
    const p = editing.orig || {}, isNew = editing.index < 0, n = repo.playlists.length;
    const cover = editing.cover?.url || (p.image ? assetSrc(p.image) : '');
    return `
      <form id="ed" class="editor" novalidate>
        <button type="button" class="back" data-act="back">← Playlists</button>
        <h1>${isNew ? 'NUEVA PLAYLIST' : esc(p.title || 'Sin título')}</h1>
        <div class="ed-grid">
          <div class="ed-side">
            ${coverDrop(cover, p.image && !editing.cover ? P('assets/' + p.image) : '', 'Portada')}
            <p class="info" id="ed-cover-info">${coverInfo()}</p>
          </div>
          <div class="ed-main">
            <div class="field"><label for="f-title">Título</label><input id="f-title" name="title" value="${esc(p.title || '')}" maxlength="80" autocomplete="off"></div>
            <div class="field"><label for="f-desc">Descripción</label><textarea id="f-desc" name="description" rows="3" maxlength="300">${esc(p.description || '')}</textarea></div>
            <div class="field"><label for="f-link">Enlace</label><input id="f-link" name="link" type="url" value="${esc(p.link || '')}" autocomplete="off" spellcheck="false" placeholder="https://open.spotify.com/playlist/…"></div>
            <div class="field narrow"><label for="f-position">Posición</label><input id="f-position" name="position" type="number" min="1" max="${isNew ? n + 1 : n}" value="${isNew ? n + 1 : editing.index + 1}" inputmode="numeric"></div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publicar' : 'Guardar cambios'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancelar</button>
          ${isNew || !can('playlists', 'delete') ? '' : '<button type="button" class="btn danger push" data-act="delete-playlist">Eliminar</button>'}
        </div>
      </form>`;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function findPlaylist(list) {
    if (same(list[editing.index], editing.orig)) return editing.index;
    const i = list.findIndex(p => same(p, editing.orig));
    if (i < 0) throw new Error('Esta playlist ha cambiado desde otro sitio. Vuelve a la lista y ábrela otra vez.');
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
      title: text(form, 'title', 'Título', { max: 80, missing: 'Falta el título.' }),
      description: text(form, 'description', 'Descripción', { max: 300 }),
      link: link(form, 'link', 'Enlace', null, 'Falta el enlace.'),
    };
    if (isNew && !editing.cover) throw new Error('Falta la portada.');
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
    afterPublish(res, isNew ? 'Playlist publicada' : 'Cambios guardados', [jsonProbe('playlists.json', res.out.playlists), ...uploads.map(u => fileProbe(image, u.blob))]);
    go('playlists');
  }
  async function deletePlaylist() {
    const p = editing.orig;
    if (!await confirmBox(`¿Eliminar la playlist «${p.title || ''}» de la web?`)) return false;
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
    player: [{ file: 'release_preview.mp3', title: 'Audio del reproductor', kind: 'audio', accept: 'audio/mpeg,.mp3' }],
  };
  const pending = new Map();   // archivo → { blob, url }
  function fileCard(f, editable) {
    const path = P('assets/' + f.file), has = repo.files.has(path) || previews.has(path), nw = pending.get(f.file);
    const src = nw?.url || (has ? assetSrc(f.file) : '');
    const media = f.kind === 'audio'
      ? (src ? `<audio controls preload="metadata" src="${esc(src)}"></audio>` : '<p class="info">Todavía no hay audio.</p>')
      : `<div class="logo-prev">${src ? `<img src="${esc(src)}" ${nw ? '' : `data-repo="${esc(path)}"`} alt="">` : '<span class="info">Sin imagen</span>'}</div>`;
    return `
      <section class="card" data-file="${esc(f.file)}">
        <h2>${esc(f.title)}${nw ? ' <span class="tag">Nuevo, sin publicar</span>' : ''}</h2>
        ${media}
        ${nw ? `<p class="info">${esc(nw.name)} · ${(nw.blob.size / 1048576).toFixed(1)} MB</p>` : ''}
        ${editable ? `<div class="card-actions">
          <input type="file" id="file-${esc(f.file)}" class="sr-only" accept="${esc(f.accept)}" data-pick="${esc(f.file)}">
          <label for="file-${esc(f.file)}" class="btn ghost">${nw ? 'Elegir otro' : f.kind === 'audio' ? 'Cambiar audio' : 'Cambiar imagen'}</label>
          ${nw ? `<button type="button" class="btn primary" data-act="publish-file" data-file="${esc(f.file)}">Publicar</button>
                  <button type="button" class="btn ghost" data-act="discard-file" data-file="${esc(f.file)}">Descartar</button>` : ''}
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
        if (file.type !== 'image/png') throw new Error('Usa una imagen PNG (con fondo transparente si lo tiene el actual).');
        if (file.size > 3 * 1048576) throw new Error('La imagen pesa demasiado (máx. 3 MB).');
        if (!await decodeImage(file).catch(() => null)) throw new Error('No se pudo leer la imagen.');
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
    if (!(file.type === 'audio/mpeg' || /\.mp3$/i.test(file.name))) throw new Error('Usa un archivo MP3.');
    if (file.size > MAX_AUDIO) throw new Error('El audio pesa demasiado (máx. 25 MB).');
    await new Promise((ok, ko) => {
      const a = new Audio(), u = URL.createObjectURL(file), t = setTimeout(() => done(ko), 10000);
      const done = fn => { clearTimeout(t); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(u); fn(new Error('Este archivo no se puede reproducir. Prueba con otro MP3.')); };
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
      afterPublish(res, 'Publicado', [fileProbe(name, nw.blob)]);
      render();
    } catch (e) {
      busyOff(card);
      err.textContent = e.message; err.hidden = false;
      if (e.status === 401) logout(e.message);
    } finally { busy = false; }
  }

  function afterPublish(res, msg, probes) {
    if (res.unchanged) { toast('No había nada que cambiar'); return; }
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
    const ok = await confirmBox('Hay cambios sin publicar. ¿Salir sin publicarlos?', 'Salir sin publicar');
    if (ok) { for (const p of pending.values()) URL.revokeObjectURL(p.url); pending.clear(); }
    return ok;
  }
  function go(v, ed = null) {
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
    if (view !== 'team' && view !== 'log' && view !== 'none' && !can(view)) { view = firstView(); editing = null; }
    if ((view === 'team' || view === 'log') && !(MODE === 'admin' && auth.user.owner)) view = firstView();
    let inner;
    if (view === 'none') inner = noAccessView();
    else if (view === 'team') inner = teamView();
    else if (view === 'log') inner = logView();
    else if (editing?.view === 'releases') inner = releaseEditor();
    else if (editing?.view === 'playlists') inner = playlistEditor();
    else if (editing?.view === 'radio') inner = mixtapeEditor();
    else if (view === 'radio') inner = radioView();
    else if (view === 'playlists') inner = playlistsView();
    else if (view === 'player') inner = filesView(view);
    else inner = releasesView();
    app.innerHTML = shell(inner);
    chatStart();
    const names = { releases: 'Releases', radio: 'Mixtapes', playlists: 'Playlists', player: 'Reproductor', team: 'Equipo', log: 'Historial', none: 'Equipo' };
    document.title = `${editing ? (editing.orig?.title || 'Nuevo') + ' · ' : ''}${names[view] || ''} — Panel HORIZON RCRDS`;
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
      drop.querySelector('.drop-hint').textContent = 'Cambiar portada';
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

  /* ---------------- Eventos ---------------- */
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act], [data-view]');
    if (!t || busy) return;
    if (t.dataset.view) {
      if (t.dataset.view === view && !editing) return;
      if (!await leaveOk()) return;
      filter = ''; go(t.dataset.view);
      return;
    }
    // El servidor también lo comprueba; aquí solo se evita abrir lo que el rol no puede usar
    const needs = { 'new-release': ['releases', 'edit'], 'edit-release': ['releases', 'edit'], 'delete-release': ['releases', 'delete'], 'exclude-release': ['releases', 'delete'],
      'new-mixtape': ['radio', 'edit'], 'edit-mixtape': ['radio', 'edit'], 'delete-mixtape': ['radio', 'delete'], 'exclude-mixtape': ['radio', 'delete'],
      'new-playlist': ['playlists', 'edit'], 'edit-playlist': ['playlists', 'edit'], 'delete-playlist': ['playlists', 'delete'] }[t.dataset.act];
    if (needs && !can(...needs)) { toast('Tu rol no tiene permiso para esto.'); return; }
    switch (t.dataset.act) {
      case 'team-retry': teamErr = ''; render(); break;
      case 'log-more': loadLog(true); break;
      case 'new-role': newRole = true; render(); $('.role-card input[name=name]')?.focus(); break;
      case 'cancel-role': newRole = false; render(); break;
      case 'delete-role': {
        const form = t.closest('.role-card'), r = teamData.roles.find(x => x.id === form.dataset.role);
        if (!r || !await confirmBox(`¿Eliminar el rol «${r.name}»?`)) return;
        teamAction(() => api('DELETE', `/api/team/roles?id=${encodeURIComponent(r.id)}`), 'Rol eliminado', form.querySelector('.ed-error'));
        break;
      }
      case 'remove-member': {
        const email = t.dataset.email;
        if (!await confirmBox(`¿Quitar a ${email} del equipo? Dejará de poder entrar en /team al momento.`, 'Quitar')) return;
        teamAction(() => api('DELETE', `/api/team/members?email=${encodeURIComponent(email)}`), 'Quitado del equipo');
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
    if (form.id === 'dev-login') { const email = form.elements.email.value.trim(); if (email) login({ email }); return; }
    if (busy) return;
    if (form.id === 'add-member') {
      const box = form.querySelector('.ed-error'); box.hidden = true;
      const email = form.elements.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { box.textContent = 'Escribe un email válido.'; box.hidden = false; form.elements.email.focus(); return; }
      teamAction(() => api('POST', '/api/team/members', { email, label: form.elements.label.value.trim(), color: form.elements.color.value, role_id: form.elements.role_id.value }), `${email} añadido al equipo`, box);
      return;
    }
    if (form.classList.contains('role-card')) {
      const box = form.querySelector('.ed-error'); box.hidden = true;
      const name = form.elements.name.value.trim();
      if (!name) { box.textContent = 'Ponle un nombre al rol.'; box.hidden = false; form.elements.name.focus(); return; }
      const id = form.dataset.role || undefined;
      teamAction(() => api('POST', '/api/team/roles', { id, name, perms: rolePerms(form) }), id ? 'Rol guardado' : 'Rol creado', box);
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
    if (t.id === 'f-color-pick') setColor(t.value);
    if (t.type === 'color' && t.closest('.color-dot')) { t.closest('.color-dot').style.setProperty('--c', t.value); const n = t.dataset.member && $$('.name-in').find(i => i.dataset.member === t.dataset.member); if (n) n.style.color = t.value; }
    if (t.id === 'f-color' && hex6(t.value)) { editing.color = hex6(t.value); $('#f-color-pick').value = editing.color; $('#color-prev').style.setProperty('--c', editing.color); }
    if (t.id === 'f-catalog') $('#color-prev').textContent = t.value || ' ';
    if (t.matches('[aria-invalid]')) t.removeAttribute('aria-invalid');
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'ed-file' && t.files[0]) { setCover(t.files[0]); t.value = ''; }
    if (t.id === 'mx-file' && t.files[0]) { setMixAudio(t.files[0]); t.value = ''; }
    if (t.id === 'f-sc') scFill(!editing?.key);
    if (t.classList.contains('log-who')) { logState.who = t.value; logState.items = []; logState.loaded = false; loadLog(false); render(); }
    if (t.classList.contains('color-in') && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, color: t.value }), 'Color guardado');
    if (t.classList.contains('name-in') && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, label: t.value.trim() }), 'Nombre guardado');
    if (t.classList.contains('role-sel') && t.value && !busy) teamAction(() => api('POST', '/api/team/members', { email: t.dataset.member, role_id: t.value }), 'Rol cambiado');
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

  /* ---------------- Chat del equipo (burbuja abajo a la derecha) ---------------- */
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
      <button type="button" class="chat-fab" data-chat="toggle" aria-label="Chat del equipo" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.9 2 11.6c0 2.6 1.4 4.9 3.6 6.5L5 22l4-2.2c.9.2 1.9.4 3 .4 5.5 0 10-3.9 10-8.6S17.5 3 12 3z"/></svg>
        <span class="chat-badge" hidden></span>
      </button>
      <section class="chat-box" hidden aria-label="Chat del equipo">
        <header class="chat-head"><b>Chat del equipo</b><button type="button" class="chat-x" data-chat="toggle" aria-label="Cerrar">×</button></header>
        <ol class="chat-list" aria-live="polite"></ol>
        <form class="chat-form" novalidate>
          <textarea name="text" rows="1" maxlength="1000" placeholder="Escribe un mensaje…" aria-label="Mensaje"></textarea>
          <button type="submit" class="chat-send" aria-label="Enviar"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg></button>
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
      return `${day ? `<li class="chat-day">${esc(d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))}</li>` : ''}
        <li class="chat-msg${mine ? ' mine' : ''}${same ? ' cont' : ''}" data-id="${m.id}">
          ${same || mine ? '' : `<span class="chat-av">${m.picture ? `<img src="${esc(m.picture)}" alt="" referrerpolicy="no-referrer">` : esc(who[0].toUpperCase())}</span>`}
          <div class="chat-bubble">
            ${same || mine ? '' : `<b style="${m.color ? `color:${esc(m.color)}` : ''}">${esc(who)}</b>`}
            <p>${linkify(m.text)}</p>
            <time>${esc(d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}</time>
            ${mine || chatState.owner ? '<button type="button" class="chat-del" data-chat="del" aria-label="Borrar mensaje">×</button>' : ''}
          </div>
        </li>`;
    }).join('') : '<li class="chat-empty">Aún no hay mensajes. ¡Escribe el primero!</li>';
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
      if (!id || !await confirmBox('¿Borrar este mensaje?', 'Borrar')) return;
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
    app.innerHTML = '<p class="boot">Cargando…</p>';
    try {
      useSession(await api('GET', '/api/auth/me'));   // el rol puede haber cambiado desde la última vez
      const remembered = (() => { try { return !!localStorage.getItem(AUTH_KEY); } catch { return false; } })();
      saveAuth(auth, remembered);
      repo = firstView() === 'none' ? emptyRepo() : await loadRepo();
      go(firstView());
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) { logout(e.message); return; }
      app.innerHTML = `<main class="login"><div class="login-card"><p class="login-error" role="alert">${esc(e.message)}</p>
        <button type="button" class="btn primary wide" id="retry">Reintentar</button>
        <button type="button" class="btn ghost wide" data-act="logout">Salir</button></div></main>`;
      $('#retry').addEventListener('click', boot);
    }
  }
  boot();
})();
