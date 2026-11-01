/* HORIZON RCRDS — panel de administración.
   Sin servidor: el navegador habla directamente con la API de GitHub (token personal del usuario) y cada
   «Publicar» es UN commit en el repositorio de la web: releases.json, playlists.json y archivos de assets/.
   GitHub Pages vuelve a publicar la web sola en 1–2 minutos. La web no necesita ningún cambio. */
'use strict';
(() => {
  const CFG = Object.assign({ owner: '', repo: '', branch: '', root: '' }, window.HZ_CONFIG || {});
  const API = 'https://api.github.com';
  const SITE = '../';                 // el panel vive en <web>/admin/
  const AUTH_KEY = 'hz_admin_auth';
  const COVER_PX = 1000;              // mismo tamaño que las portadas que ya tiene la web
  const MAX_AUDIO = 25 * 1024 * 1024;
  const MAX_IMAGE_IN = 30 * 1024 * 1024;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  let auth = null;        // { token, owner, repo, branch, root }
  let repo = null;        // { head, treeSha, files: Map(ruta → {sha,size}), truncated, releases: [], playlists: [] }
  let view = 'releases';
  let editing = null;     // editor abierto (lanzamiento o playlist)
  let filter = '';
  let busy = false;
  const previews = new Map();   // ruta del repositorio → URL local de lo recién subido (la web aún no lo tiene)

  /* ---------------- Sesión ---------------- */
  function readAuth() {
    for (const s of [localStorage, sessionStorage]) {
      try { const a = JSON.parse(s.getItem(AUTH_KEY) || 'null'); if (a?.token && a.owner && a.repo) return a; } catch { /* almacenamiento bloqueado */ }
    }
    return null;
  }
  function saveAuth(a, remember) {
    clearAuth();
    try { (remember ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(a)); } catch { /* sólo para esta pestaña */ }
  }
  function clearAuth() { for (const s of [localStorage, sessionStorage]) { try { s.removeItem(AUTH_KEY); } catch { /* nada */ } } }

  /* ---------------- GitHub ---------------- */
  class GhError extends Error { constructor(msg, status = 0) { super(msg); this.status = status; } }
  const R = () => `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}`;
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  const root = () => { const r = String(auth?.root || '').replace(/^\/+|\/+$/g, ''); return r ? r + '/' : ''; };
  const P = p => root() + p;

  function ghMessage(status, msg) {
    if (status === 401) return 'El token no es válido o ha caducado. Entra con uno nuevo.';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub ha limitado las peticiones durante un rato. Espera unos minutos.';
    if (status === 403) return 'El token no tiene permiso para esto. Necesita «Contents: Read and write» en este repositorio.';
    if (status === 404) return 'No se encuentra el repositorio o la rama (o el token no tiene acceso a ese repositorio).';
    if (status === 409) return 'El repositorio está vacío.';
    if (status === 422) return 'GitHub rechazó el cambio' + (msg ? `: ${msg}` : '.');
    return `Error de GitHub (${status})${msg ? `: ${msg}` : ''}.`;
  }
  async function gh(method, path, body, raw) {
    let res;
    try {
      res = await fetch(API + path, {
        method, cache: 'no-store',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new GhError('Sin conexión con GitHub. Revisa tu internet y vuelve a intentarlo.'); }
    if (res.ok) return raw ? res.blob() : res.status === 204 ? null : res.json();
    const j = await res.json().catch(() => ({}));
    throw new GhError(ghMessage(res.status, j.message || ''), res.status);
  }
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function textOfB64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u8);   // UTF-8: nombres como 浩林Hali se leen bien
  }

  async function loadRepo() {
    const ref = await gh('GET', `${R()}/git/ref/heads/${encPath(auth.branch)}`);
    const head = ref.object.sha;
    const commit = await gh('GET', `${R()}/git/commits/${head}`);
    const tree = await gh('GET', `${R()}/git/trees/${commit.tree.sha}?recursive=1`);
    const files = new Map();
    for (const t of tree.tree || []) if (t.type === 'blob') files.set(t.path, { sha: t.sha, size: t.size });
    const fileInfo = async path => {
      if (files.has(path)) return files.get(path);
      if (!tree.truncated) return null;
      try { const c = await gh('GET', `${R()}/contents/${encPath(path)}?ref=${head}`); return { sha: c.sha, size: c.size }; }
      catch (e) { if (e.status === 404) return null; throw e; }
    };
    const json = async (name, required) => {
      const f = await fileInfo(P(name));
      if (!f) {
        if (required) throw new GhError(`No encuentro ${P(name)} en el repositorio. Revisa «root» en config.js.`);
        return [];
      }
      const blob = await gh('GET', `${R()}/git/blobs/${f.sha}`);
      let data;
      try { data = JSON.parse(textOfB64(blob.content)); } catch { throw new GhError(`${P(name)} tiene un error de formato. Corrígelo en GitHub antes de usar el panel.`); }
      if (!Array.isArray(data)) throw new GhError(`${P(name)} debe ser una lista ([ … ]).`);
      return data;
    };
    const [releases, playlists] = await Promise.all([json('releases.json', true), json('playlists.json', false)]);
    return { head, treeSha: commit.tree.sha, files, truncated: !!tree.truncated, releases, playlists };
  }

  /* Un «Publicar» = un commit. Los archivos se suben una vez; el JSON se recalcula sobre la versión más
     reciente del repositorio (si alguien publicó a la vez, se reintenta sin pisar su cambio). */
  async function publish(message, uploads, build) {
    const made = [];
    for (const u of uploads) {
      const { sha } = await gh('POST', `${R()}/git/blobs`, { content: toB64(new Uint8Array(await u.blob.arrayBuffer())), encoding: 'base64' });
      made.push({ ...u, sha });
    }
    for (let attempt = 0; ; attempt++) {
      const fresh = await loadRepo();
      const out = build ? build(fresh) : {};
      const entries = made.map(m => ({ path: m.path, mode: '100644', type: 'blob', sha: m.sha }));
      if (out.releases) entries.push({ path: P('releases.json'), mode: '100644', type: 'blob', content: JSON.stringify(out.releases, null, 2) + '\n' });
      if (out.playlists) entries.push({ path: P('playlists.json'), mode: '100644', type: 'blob', content: JSON.stringify(out.playlists, null, 2) + '\n' });
      for (const p of new Set(out.remove || [])) {
        if (fresh.files.has(p) && !made.some(m => m.path === p)) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      }
      const tree = await gh('POST', `${R()}/git/trees`, { base_tree: fresh.treeSha, tree: entries });
      if (tree.sha === fresh.treeSha) { repo = fresh; return { out, unchanged: true }; }
      const commit = await gh('POST', `${R()}/git/commits`, { message, tree: tree.sha, parents: [fresh.head] });
      try {
        await gh('PATCH', `${R()}/git/refs/heads/${encPath(auth.branch)}`, { sha: commit.sha, force: false });
      } catch (e) {
        if (e.status === 422 && attempt < 3) continue;   // otro commit entró antes: repetir sobre el nuevo
        throw e;
      }
      for (const m of made) { const old = previews.get(m.path); if (old) URL.revokeObjectURL(old); previews.set(m.path, URL.createObjectURL(m.blob)); }
      try { repo = await loadRepo(); } catch { repo = { ...fresh, releases: out.releases || fresh.releases, playlists: out.playlists || fresh.playlists }; }
      return { out, made };
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
      if (ok) { deploy('✓ Ya está en la web', 'ok'); watchTimer = setTimeout(() => id === watchId && deploy(), 8000); return; }
      if (Date.now() - start > 6 * 60e3) { deploy('GitHub sigue publicando. Mira la web en unos minutos.', 'warn'); watchTimer = setTimeout(() => id === watchId && deploy(), 15000); return; }
      watchTimer = setTimeout(tick, 8000);
    };
    watchTimer = setTimeout(tick, 4000);
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

  /* Si la web aún no tiene un archivo (recién publicado) o el repositorio es privado: se pide a GitHub. */
  document.addEventListener('error', async e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.repo || img.dataset.tried || !auth || !repo) return;
    img.dataset.tried = '1';
    try { img.src = URL.createObjectURL(await gh('GET', `${R()}/contents/${encPath(img.dataset.repo)}?ref=${repo.head}`, null, true)); }
    catch { img.classList.add('is-broken'); }
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
  function loginView(message = '') {
    const needRepo = !CFG.owner || !CFG.repo;
    document.title = 'Panel — HORIZON RCRDS';
    app.innerHTML = `
      <main class="login">
        <form id="login" class="login-card" novalidate>
          <img class="login-logo" src="${SITE}assets/logo.png" alt="">
          <h1>HORIZON <span>RCRDS</span></h1>
          <p class="login-sub">Panel</p>
          ${needRepo ? `
          <div class="field"><label for="l-owner">Usuario u organización de GitHub</label><input id="l-owner" name="owner" autocomplete="off" spellcheck="false" required></div>
          <div class="field"><label for="l-repo">Repositorio</label><input id="l-repo" name="repo" autocomplete="off" spellcheck="false" required></div>` : ''}
          <div class="field"><label for="l-token">Token de GitHub</label><input id="l-token" name="token" type="password" autocomplete="off" spellcheck="false" required></div>
          <label class="check"><input type="checkbox" name="remember" checked><span>Recordar en este navegador</span></label>
          <p class="login-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
          <button class="btn primary wide" type="submit">Entrar</button>
          <details class="howto">
            <summary>¿Cómo consigo el token?</summary>
            <ol>
              <li>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token.</li>
              <li>Repository access: <b>Only select repositories</b> → el repositorio de la web.</li>
              <li>Permissions → Repository permissions → <b>Contents: Read and write</b>.</li>
              <li>Generate token, cópialo y pégalo aquí.</li>
            </ol>
          </details>
        </form>
      </main>`;
    (needRepo ? $('#l-owner') : $('#l-token')).focus();
  }

  async function login(form) {
    const btn = form.querySelector('[type=submit]'), err = form.querySelector('.login-error');
    const val = n => String(form.elements[n]?.value || '').trim();
    const a = { token: val('token'), owner: CFG.owner || val('owner'), repo: CFG.repo || val('repo'), branch: CFG.branch || '', root: CFG.root || '' };
    if (!a.owner || !a.repo || !a.token) { err.textContent = 'Rellena todos los campos.'; err.hidden = false; return; }
    if (/^https?:\/\//.test(a.repo)) a.repo = a.repo.replace(/\/+$/, '').split('/').pop();
    btn.disabled = true; btn.textContent = 'Comprobando…'; err.hidden = true;
    auth = a;
    try {
      const info = await gh('GET', R());
      if (!info.permissions?.push) throw new GhError('El token puede leer el repositorio pero no escribir. Dale «Contents: Read and write».', 403);
      a.branch = a.branch || info.default_branch || 'main';
      repo = await loadRepo();
      saveAuth(a, form.elements.remember.checked);
      go('releases');
    } catch (e) {
      auth = null; repo = null;
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }
  function logout(message = '') {
    clearAuth(); auth = null; repo = null; editing = null; setDirtyBase(null);
    watchId++; deploy();
    loginView(message);
  }

  function shell(inner) {
    const tab = (id, label) => `<button type="button" class="tab${view === id || (editing && editing.view === id) ? ' is-on' : ''}" data-view="${id}">${label}</button>`;
    return `
      <header class="top">
        <a class="brand" href="${SITE}" target="_blank" rel="noopener" aria-label="Abrir la web">
          <img src="${SITE}assets/logo.png" alt="">
          <span class="word">HORIZON<small>RCRDS</small></span>
        </a>
        <nav class="tabs" aria-label="Secciones">
          ${tab('releases', 'Releases')}${tab('playlists', 'Playlists')}${tab('player', 'Reproductor')}${tab('brand', 'Logo')}
        </nav>
        <div class="top-end">
          <a class="link" href="${SITE}" target="_blank" rel="noopener">Ver web ↗</a>
          <button type="button" class="link" data-act="logout">Salir</button>
        </div>
      </header>
      <main id="main" class="main" tabindex="-1">${inner}</main>`;
  }

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
        <span class="swatch" style="--c:${esc(hex6(r.color) || '#ffffff')}" title="${esc(r.color || '')}"></span>
        ${i === 0 ? '<span class="tag">Portada</span>' : '<span></span>'}
        <button type="button" class="btn ghost sm" data-act="edit-release" data-key="${esc(keyOf(r))}">Editar</button>
      </li>`).join('');
  }
  function releasesView() {
    return `
      <div class="head">
        <div><p class="eyebrow">Discography</p><h1>RELEASES <span class="count">${repo.releases.length}</span></h1></div>
        <button type="button" class="btn primary" data-act="new-release">+ Nuevo lanzamiento</button>
      </div>
      <input class="search" type="search" id="rel-filter" placeholder="Buscar" aria-label="Buscar lanzamientos" value="${esc(filter)}">
      <ol class="list" id="rel-list">${releaseRows()}</ol>`;
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
            <div class="field"><label for="f-desc">Descripción</label><textarea id="f-desc" name="description" rows="3" maxlength="400">${esc(r.description || '')}</textarea></div>
          </div>
        </div>
        <p class="ed-error" id="ed-error" role="alert" hidden></p>
        <div class="ed-actions">
          <button type="submit" class="btn primary">${isNew ? 'Publicar' : 'Guardar cambios'}</button>
          <button type="button" class="btn ghost" data-act="back">Cancelar</button>
          ${isNew ? '' : '<button type="button" class="btn danger push" data-act="delete-release">Eliminar</button>'}
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
      for (const k of ['stream_link', 'spotify_link', 'soundcloud_link', 'description']) {
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
  async function deleteRelease() {
    const r = editing.orig;
    if (repo.releases.length <= 1) throw new Error('La web necesita al menos un lanzamiento.');
    if (!await confirmBox(`¿Eliminar «${r.title || catOf(r)}» de la web? También se borra su portada.`)) return false;
    const res = await publish(`Remove release ${catOf(r)} — ${r.title || ''}`, [], fresh => {
      const list = fresh.releases.filter(x => keyOf(x) !== editing.key);
      if (list.length === fresh.releases.length) throw new Error('Este lanzamiento ya no estaba en la web.');
      if (!list.length) throw new Error('La web necesita al menos un lanzamiento.');
      const gone = fresh.releases.find(x => keyOf(x) === editing.key)?.image;
      return { releases: list, remove: gone && safeFile(gone) && !list.some(x => x.image === gone) ? [P('assets/' + gone)] : [] };
    });
    afterPublish(res, 'Lanzamiento eliminado', [jsonProbe('releases.json', res.out.releases)]);
    go('releases');
    return true;
  }

  /* Playlists */
  function playlistsView() {
    const list = repo.playlists;
    return `
      <div class="head">
        <div><p class="eyebrow">Curated</p><h1>PLAYLISTS <span class="count">${list.length}</span></h1></div>
        <button type="button" class="btn primary" data-act="new-playlist">+ Nueva playlist</button>
      </div>
      <ol class="list">${list.length ? list.map((p, i) => `
        <li class="row pl">
          <span class="pos">${i + 1}</span>
          ${imgTag(p.image, 'thumb')}
          <span class="meta"><b>${esc(p.title || 'Sin título')}</b><span>${esc(p.description || '')}</span></span>
          <button type="button" class="btn ghost sm" data-act="edit-playlist" data-index="${i}">Editar</button>
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
          ${isNew ? '' : '<button type="button" class="btn danger push" data-act="delete-playlist">Eliminar</button>'}
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
    brand: [
      { file: 'logo.png', title: 'Logo', kind: 'image', accept: 'image/png' },
      { file: 'favicon_icon.png', title: 'Icono de la pestaña', kind: 'image', accept: 'image/png' },
    ],
  };
  const pending = new Map();   // archivo → { blob, url }
  function fileCard(f) {
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
        <div class="card-actions">
          <input type="file" id="file-${esc(f.file)}" class="sr-only" accept="${esc(f.accept)}" data-pick="${esc(f.file)}">
          <label for="file-${esc(f.file)}" class="btn ghost">${nw ? 'Elegir otro' : f.kind === 'audio' ? 'Cambiar audio' : 'Cambiar imagen'}</label>
          ${nw ? `<button type="button" class="btn primary" data-act="publish-file" data-file="${esc(f.file)}">Publicar</button>
                  <button type="button" class="btn ghost" data-act="discard-file" data-file="${esc(f.file)}">Descartar</button>` : ''}
        </div>
        <p class="ed-error" role="alert" hidden></p>
      </section>`;
  }
  function filesView(which) {
    const title = which === 'player' ? 'REPRODUCTOR' : 'LOGO';
    return `<div class="head"><div><p class="eyebrow">${which === 'player' ? 'Latest Release' : 'Brand'}</p><h1>${title}</h1></div></div>
      <div class="cards">${FILES[which].map(fileCard).join('')}</div>`;
  }
  async function pickFile(name, file) {
    const f = Object.values(FILES).flat().find(x => x.file === name);
    const card = $(`.card[data-file="${CSS.escape(name)}"]`), err = card?.querySelector('.ed-error');
    try {
      if (f.kind === 'audio') {
        if (!(file.type === 'audio/mpeg' || /\.mp3$/i.test(file.name))) throw new Error('Usa un archivo MP3.');
        if (file.size > MAX_AUDIO) throw new Error('El audio pesa demasiado (máx. 25 MB).');
        await new Promise((ok, ko) => {
          const a = new Audio(), u = URL.createObjectURL(file), t = setTimeout(() => done(ko), 10000);
          const done = fn => { clearTimeout(t); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(u); fn(new Error('Este archivo no se puede reproducir. Prueba con otro MP3.')); };
          a.onloadedmetadata = () => { clearTimeout(t); URL.revokeObjectURL(u); ok(); };
          a.onerror = () => done(ko);
          a.preload = 'metadata'; a.src = u;
        });
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
    return JSON.stringify([[...new FormData(f)].filter(([k]) => k !== 'ed-file').map(([k, v]) => [k, typeof v === 'string' ? v : '']), !!editing?.cover]);
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
    let inner;
    if (editing?.view === 'releases') inner = releaseEditor();
    else if (editing?.view === 'playlists') inner = playlistEditor();
    else if (view === 'playlists') inner = playlistsView();
    else if (view === 'player' || view === 'brand') inner = filesView(view);
    else inner = releasesView();
    app.innerHTML = shell(inner);
    const names = { releases: 'Releases', playlists: 'Playlists', player: 'Reproductor', brand: 'Logo' };
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
      if (editing.view === 'releases') setColor(c.color);
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
    switch (t.dataset.act) {
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
      case 'delete-playlist': {
        const form = $('#ed');
        busyOn(form, t, 'Eliminando…');
        try {
          const done = await (t.dataset.act === 'delete-release' ? deleteRelease() : deletePlaylist());
          if (!done) busyOff(form);
        } catch (err) { busyOff(form); showError(err); } finally { busy = false; }
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
    if (form.id === 'login') { login(form); return; }
    if (form.id !== 'ed' || busy) return;
    const btn = form.querySelector('[type=submit]');
    $('#ed-error').hidden = true;
    busyOn(form, btn, 'Publicando…');
    try {
      if (editing.view === 'releases') await saveRelease(form); else await savePlaylist(form);
    } catch (err) {
      busyOff(form);
      showError(err);
    } finally { busy = false; }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'rel-filter') { filter = t.value; $('#rel-list').innerHTML = releaseRows(); return; }
    if (t.id === 'f-color-pick') setColor(t.value);
    if (t.id === 'f-color' && hex6(t.value)) { editing.color = hex6(t.value); $('#f-color-pick').value = editing.color; $('#color-prev').style.setProperty('--c', editing.color); }
    if (t.id === 'f-catalog') $('#color-prev').textContent = t.value || ' ';
    if (t.matches('[aria-invalid]')) t.removeAttribute('aria-invalid');
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'ed-file' && t.files[0]) { setCover(t.files[0]); t.value = ''; }
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

  /* ---------------- Arranque ---------------- */
  async function boot() {
    auth = readAuth();
    if (!auth) { loginView(); return; }
    // config.js manda sobre lo guardado (si se cambia de repositorio, no se usa el antiguo)
    if ((CFG.owner && CFG.owner !== auth.owner) || (CFG.repo && CFG.repo !== auth.repo)) { logout(); return; }
    app.innerHTML = '<p class="boot">Cargando…</p>';
    try {
      repo = await loadRepo();
      go('releases');
    } catch (e) {
      if (e.status === 401 || e.status === 404) { logout(e.message); return; }
      app.innerHTML = `<main class="login"><div class="login-card"><p class="login-error" role="alert">${esc(e.message)}</p>
        <button type="button" class="btn primary wide" id="retry">Reintentar</button>
        <button type="button" class="btn ghost wide" data-act="logout">Salir</button></div></main>`;
      $('#retry').addEventListener('click', boot);
    }
  }
  boot();
})();
