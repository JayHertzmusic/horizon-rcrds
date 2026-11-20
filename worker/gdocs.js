import { mailName } from './contract-mail.js';
/* Google Docs y Drive con la cuenta de Horizon, hechos por el servidor (así cualquiera del equipo con permiso de
   Contracts crea contratos sin iniciar sesión en Google). El permiso lo da el script de Apps Script de Horizon
   (aplicación web, GSCRIPT_URL): devuelve un token de Google de la cuenta de Horizon; aquí se guarda ~50 min. */
let cached = null;
// margin: cuánto tiempo de vida tiene que quedarle (la tarea de cada 30 min lo renueva antes: nadie espera al crear un contrato)
export async function horizonToken(env, margin = 60e3) {
  if (cached && cached.exp > Date.now() + margin) return cached.token;
  const kv = await env.FILES.get('google/token', { type: 'json' }).catch(() => null);
  if (kv?.token && kv.exp > Date.now() + margin) { cached = kv; return kv.token; }
  if (!env.GSCRIPT_URL || !env.GFORM_SECRET) throw new Error('Google is not connected yet (the Horizon script is missing).');
  const r = await fetch(env.GSCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.GFORM_SECRET, action: 'token' }), redirect: 'follow' });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Google did not give access. Check the Horizon script (Deploy → Web app).');
  cached = { token: j.token, exp: Date.now() + 50 * 60e3 };
  await env.FILES.put('google/token', JSON.stringify(cached), { expirationTtl: 3000 });
  return j.token;
}
// token guardado sin un permiso nuevo (p. ej. Gmail recién añadido al script): se tira y se pide otro
export async function dropHorizonToken(env) { cached = null; await env.FILES.delete('google/token').catch(() => {}); }
async function gapi(tok, url, body, method, patch) {
  if (patch) body = patch;
  const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) cached = null;
    const msg = j.error?.message || `Error ${r.status}`;
    throw new Error(/has not been used|is disabled|not been enabled/i.test(msg) ? 'The Google Docs/Drive API is not enabled in the Horizon script’s Google project.' : `Google: ${msg}`);
  }
  return j;
}
const DATA_NAMES = { 'artist name': 'Artist name', 'legal name': 'Legal name', 'e-mail address': 'Email', 'age': 'Age', 'street address, zip code': 'Address & zip code', 'city, country': 'City & country' };
const BLANK_RULES = [
  [/(\{\{\s*([^{}]{1,60}?)\s*\}\})/gd, m => [[1, m[2].replace(/\s+/g, ' ').trim()]]],
  [/represented herein by\s+(.+?),\s*and hereinafter referred to as the\s*[“"]Label/gd, () => [[1, 'Label representative']]],
  [/(?:^|\n|\.\s)\s*(?:\d+\.\d+\.\s*)?([^\n:.]+?),\s*also known as\s+(.+?),\s*and hereinafter referred to as the\s*[“"]Artists?[”"]/gd, () => [[1, 'Artists clause name'], [2, 'Artists clause legal']]],
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
// texto de una pestaña del Doc con el índice de Google de cada carácter
function docText(content) {
  let text = ''; const idx = [], sty = [], tbl = [], ind = [];
  const walk = (els, inT) => { for (const el of els || []) {
    if (el.paragraph) { const ps = el.paragraph.paragraphStyle || {}, pi = { x0: Math.max(ps.indentStart?.magnitude || 0, ps.indentFirstLine?.magnitude || 0), end: ps.indentEnd?.magnitude || 0 };
      for (const pe of el.paragraph.elements || []) { const t = pe.textRun?.content; if (t) for (let k = 0; k < t.length; k++) { text += t[k]; idx.push(pe.startIndex + k); sty.push(pe.textRun.textStyle || {}); tbl.push(inT); ind.push(pi); } } }
    if (el.table) for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content, true);
  } };
  walk(content, false);
  return { text, idx, sty, tbl, ind };
}
const findTab = (tabs, id) => { for (const t of tabs || []) { if (t.tabProperties?.tabId === id) return t; const c = findTab(t.childTabs, id); if (c) return c; } return null; };
const docParts = u => { const m = String(u).match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/), t = String(u).match(/[?&#]tab=(t\.[\w]+)/); return m ? { id: m[1], tab: t ? t[1] : '' } : null; };
// lo único que se lee de un Doc: pestañas, texto con su posición y el estilo que se copia a los datos
const DOC_EL = 'paragraph(paragraphStyle(indentStart,indentFirstLine,indentEnd),elements(startIndex,textRun(content,textStyle(bold,italic,smallCaps,weightedFontFamily,fontSize,foregroundColor)))),table(tableRows(tableCells(content(paragraph(elements(startIndex,textRun(content,textStyle(bold,italic,smallCaps,weightedFontFamily,fontSize,foregroundColor))))))))';
const DOC_TAB = `tabProperties(tabId,index),documentTab(documentStyle(pageSize,marginLeft,marginRight),body(content(${DOC_EL})))`;
const DOC_FIELDS = encodeURIComponent(`tabs(${DOC_TAB},childTabs(${DOC_TAB},childTabs(${DOC_TAB})))`);
const flatTabs = (tabs, out = []) => { for (const t of tabs || []) { out.push(t.tabProperties || {}); flatTabs(t.childTabs, out); } return out; };
// anchos reales (en em) de Lexend, la letra de las plantillas, sacados del PDF que exporta Google: Regular (etiquetas) y Bold (datos)
const LX = {
  r: { ' ': .28, '0': .607, '1': .5, '2': .548, '3': .529, '4': .62, '5': .568, '6': .557, '7': .542, '8': .579, '9': .551, '(': .366, ')': .366, ',': .267, '-': .394, '.': .228, ':': .228, '/': .56, "'": .199, '"': .396, '@': .9,
    A: .7, B: .681, C: .679, D: .748, E: .614, F: .593, G: .764, H: .761, I: .478, J: .632, K: .68, L: .599, M: .864, N: .793, O: .782, P: .622, Q: .782, R: .695, S: .624, T: .576, U: .747, V: .68, W: .996, X: .652, Y: .645, Z: .659,
    a: .633, b: .634, c: .535, d: .634, e: .586, f: .378, g: .649, h: .595, i: .278, j: .25, k: .56, l: .251, m: .921, n: .595, o: .615, p: .631, q: .634, r: .403, s: .479, t: .384, u: .605, v: .55, w: .771, x: .55, y: .581, z: .5 },
  b: { ' ': .32, '0': .675, '1': .561, '2': .548, '3': .591, '4': .662, '5': .596, '6': .579, '7': .553, '8': .599, '9': .577, '$': .634, '%': .968, "'": .252, '"': .45, '(': .39, ')': .39, ',': .287, '-': .448, '.': .257, '/': .595, ':': .257, '@': .965, '#': .7, '&': .75,
    A: .694, B: .701, C: .694, D: .772, E: .645, F: .618, G: .782, H: .779, I: .555, J: .665, K: .739, L: .609, M: .878, N: .807, O: .812, P: .662, Q: .812, R: .702, S: .634, T: .655, U: .765, V: .712, W: .993, X: .7, Y: .689, Z: .683,
    a: .659, b: .658, c: .545, d: .654, e: .586, f: .393, g: .669, h: .642, i: .319, j: .316, k: .626, l: .304, m: .962, n: .642, o: .641, p: .659, q: .654, r: .455, s: .495, t: .398, u: .642, v: .605, w: .834, x: .606, y: .62, z: .55 },
};
// letra sin tabla (acentos, otros alfabetos…): la de su letra base, o una ancha
const glyphW = (ch, bold) => { const t = bold ? LX.b : LX.r; return t[ch] ?? t[ch.normalize('NFD')[0]] ?? (/\p{Lu}/u.test(ch) ? .8 : .7); };
export async function docFromTemplate(env, docUrl, values, title) {
  const tok = await horizonToken(env);
  const d = docParts(docUrl);
  if (!d) throw new Error('The template’s Google Doc link is not valid.');
  // más rápido: la plantilla se lee A LA VEZ que se copia (la copia tiene el mismo texto en las mismas posiciones y casi
  // siempre los mismos ids de pestaña) y solo con lo necesario (texto, posiciones y estilo), no el documento entero
  const [copy, src] = await Promise.all([
    gapi(tok, `https://www.googleapis.com/drive/v3/files/${d.id}/copy?fields=id&supportsAllDrives=true`, { name: `HORIZON RCRDS — ${title}` }),
    gapi(tok, `https://docs.googleapis.com/v1/documents/${d.id}?includeTabsContent=true&fields=${DOC_FIELDS}`),
  ]);
  let tabObj = d.tab ? findTab(src.tabs, d.tab) : src.tabs?.[0];
  if (!tabObj) throw new Error('Could not find the template tab.');
  let tab = tabObj.tabProperties.tabId;
  const { text, idx, sty, tbl, ind } = docText(tabObj.documentTab?.body?.content);
  // ancho útil de la página (pt): tamaño menos márgenes
  const ds = tabObj.documentTab?.documentStyle || {}, pageW = (ds.pageSize?.width?.magnitude || 0) - (ds.marginLeft?.magnitude || 0) - (ds.marginRight?.magnitude || 0);
  // ningún dato puede quedarse sin poner: la plantilla puede llevar datos de otro contrato (o rayas «____»).
  // Solo los del sello (representante y firmante de HORIZON RCRDS) se quedan como estén si no se mandan.
  const valueOf = name => values[name] || (name === 'Artists clause name' ? values['Artist name'] : name === 'Artists clause legal' ? values['Legal name'] : '');
  const missing = [...new Set(findBlanks(text).filter(b => !String(valueOf(b.name) || '').trim() && !/^label /i.test(b.name)).map(b => b.name.replace(/^Artists clause name$/, 'Artist name').replace(/^Artists clause legal$/, 'Legal name')))];
  if (missing.length) {
    await gapi(tok, `https://www.googleapis.com/drive/v3/files/${copy.id}?supportsAllDrives=true`, null, 'PATCH', { trashed: true }).catch(() => {});   // la copia a medias, a la papelera
    throw new Error(`Missing in the contract: ${missing.join(', ')}. Fill them in and try again.`);
  }
  const requests = [];
  for (const b of findBlanks(text).reverse()) {
    // cláusula 1.2 («Artista, also known as Nombre legal»): con varias copias lleva a todos los artistas; si no, el del contrato
    const v = valueOf(b.name);
    if (!v) continue;   // (solo los del sello)
    const line = /^(_+|X{3,}|XX\.XX\.XXXX)$/.test(String(b.value).trim());
    const extra = 0;   // (los espacios de la plantilla se respetan: mueven el dato a su columna)
    const startIndex = idx[b.start - extra], endIndex = idx[b.end - 1] + 1;
    const pre = '';
    requests.push({ deleteContentRange: { range: { startIndex, endIndex, tabId: tab } } }, { insertText: { location: { index: startIndex, tabId: tab }, text: pre + v } });
    // si era una raya «____» (o XXX), el dato lleva la letra de su etiqueta («Artist Name:»…), en negrita y sin subrayado
    if (line) {
      let k = b.start - 1 - extra; while (k > 0 && /\s/.test(text[k])) k--;
      // datos del artista en negrita (la fecha no); letra y tamaño los de la etiqueta (si la etiqueta no los fija, los del párrafo)
      const ls = sty[k] || {}, style = { underline: false, italic: !!ls.italic, smallCaps: !!ls.smallCaps, strikethrough: false, bold: !/date/i.test(b.name) };
      const fields = ['underline', 'italic', 'smallCaps', 'strikethrough', 'bold', 'weightedFontFamily', 'fontSize', 'foregroundColor'];
      for (const f of ['weightedFontFamily', 'fontSize', 'foregroundColor']) if (ls[f]) style[f] = ls[f];
      requests.push({ updateTextStyle: { range: { startIndex: startIndex + pre.length, endIndex: startIndex + pre.length + v.length, tabId: tab }, textStyle: style, fields: fields.join(',') } });
    }
    // dato largo (p. ej. una dirección): se reduce SOLO la letra de ese dato lo justo para que su línea siga siendo una
    // (si saltara a otra, bajaría todo el texto y las firmas se irían a otra página). Mínimo 5 pt. Vale para cualquier hueco
    // (rayas «____», {{dato}} o datos de otro contrato). Se mide con los anchos reales de la letra de las plantillas (Lexend,
    // sacados del PDF que hace Google), el tamaño de cada letra, la sangría del párrafo y los tabuladores (cada 36 pt desde el
    // margen), con un 4 % de margen. La raya «____» de la plantilla no cuenta (se quita).
    {
      let ls0 = b.start; while (ls0 > 0 && text[ls0 - 1] !== '\n') ls0--;
      let le = b.end; while (le < text.length && text[le] !== '\n') le++;
      let k = b.start - 1; while (k > ls0 && /\s/.test(text[k])) k--;
      const pb = sty.slice(ls0, le).find(x => x.fontSize?.magnitude)?.fontSize?.magnitude || 11;
      const vSize = (line && (sty[k] || {}).fontSize?.magnitude) || sty[b.start]?.fontSize?.magnitude || pb, vBold = line ? !/date/i.test(b.name) : !!sty[b.start]?.bold;
      const run = (x, str, sz, bold) => { for (const ch of str) x = ch === '\t' ? (Math.floor(x / 36 + 1e-6) + 1) * 36 : x + sz * glyphW(ch, bold); return x; };
      const tmpl = (x, a, z) => { for (let i = a; i < z; i++) x = run(x, text[i], sty[i]?.fontSize?.magnitude || pb, !!sty[i]?.bold); return x; };
      const pi = ind[b.start] || { x0: 0, end: 0 };
      const x0 = tbl[b.start] ? 0 : pi.x0, right = tbl[b.start] || !(pageW > 100) ? tmpl(0, ls0, le) : pageW - pi.end;   // (en tablas: lo que ocupaba la línea)
      const start = tmpl(x0, ls0, b.start), valW = run(0, v, vSize, vBold), tail = tmpl(0, b.end, le);
      const room = (right - start - tail) * 0.96;
      if (valW > room && room > vSize * 2) {
        const size = Math.max(5, Math.floor(vSize * room / valW * 10) / 10);
        requests.push({ updateTextStyle: { range: { startIndex, endIndex: startIndex + v.length, tabId: tab }, textStyle: { fontSize: { magnitude: size, unit: 'PT' } }, fields: 'fontSize' } });
      }
    }
  }
  if (requests.length) {
    try { await gapi(tok, `https://docs.googleapis.com/v1/documents/${copy.id}:batchUpdate`, { requests }); }
    catch (e) {
      // la copia cambió el id de la pestaña (raro): se busca la misma pestaña por su posición en la copia y se repite
      const q = `?includeTabsContent=true&fields=${encodeURIComponent('tabs(tabProperties(tabId,index),childTabs(tabProperties(tabId,index),childTabs(tabProperties(tabId,index))))')}`;
      const ta = flatTabs(src.tabs), tb = flatTabs((await gapi(tok, `https://docs.googleapis.com/v1/documents/${copy.id}${q}`)).tabs);
      const id = tb[ta.findIndex(t => t.tabId === tab)]?.tabId;
      if (!id || id === tab) throw e;
      const swap = o => JSON.parse(JSON.stringify(o).split(`"tabId":"${tab}"`).join(`"tabId":"${id}"`));
      tab = id;
      await gapi(tok, `https://docs.googleapis.com/v1/documents/${copy.id}:batchUpdate`, { requests: swap(requests) });
    }
  }
  return `https://docs.google.com/document/d/${copy.id}/edit${tab ? '?tab=' + tab : ''}`;
}

// los datos que pone ahora el Doc de un contrato (si se corrigió algo a mano en Google Docs, p. ej. un nombre legal)
export async function docValues(env, docUrl) {
  const tok = await horizonToken(env), d = docParts(docUrl);
  if (!d) return {};
  const src = await gapi(tok, `https://docs.googleapis.com/v1/documents/${d.id}?includeTabsContent=true&fields=${DOC_FIELDS}`);
  const tab = d.tab ? findTab(src.tabs, d.tab) : src.tabs?.[0];
  if (!tab) return {};
  const { text } = docText(tab.documentTab?.body?.content), out = {};
  for (const b of findBlanks(text)) {
    const v = b.value.replace(/\s+/g, ' ').trim();
    if (v && !isBlank(v) && !/^\{\{/.test(v) && !(b.name in out)) out[b.name] = v;
  }
  return out;
}

/* Guardar el contrato firmado en Drive: carpeta raíz → Año → «HRZ#xxx - Nombre» (se crean si no existen) */
const FOLDER = 'application/vnd.google-apps.folder';
async function gDrive(tok, path, opts = {}) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}${path.includes('?') ? '&' : '?'}supportsAllDrives=true`, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) cached = null; throw new Error(`Google Drive: ${j.error?.message || 'error ' + r.status}`); }
  return j;
}
export async function subfolders(tok, parent) {
  const q = encodeURIComponent(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`);
  return (await gDrive(tok, `files?q=${q}&fields=files(id,name)&pageSize=1000&includeItemsFromAllDrives=true`)).files || [];
}
const moveFolder = (tok, id, from, to) => gDrive(tok, `files/${id}?addParents=${to}&removeParents=${from}&fields=id`, { method: 'PATCH', json: {} });
const relNum = name => catNum((String(name).match(/^\[?[^\s\]-]*\d+/) || [''])[0]);
/* Calendario → Drive: cada carpeta de release («[HRZ#105] …») va en el año de su fecha en el calendario.
   Si cambia de año (p. ej. de 2028 a 2027), se mueve; si el año no tiene carpeta, se crea. Nunca se borra nada. */
export async function placeReleaseFolders(env, root, list) {
  const want = new Map(list.filter(x => relNum(x.cat) !== null).map(x => [relNum(x.cat), String(x.year)]));
  if (!want.size) return [];
  const tok = await horizonToken(env), moved = [];
  const years = (await subfolders(tok, root)).filter(y => /^\d{4}$/.test(y.name.trim()));
  for (const y of years) for (const f of await subfolders(tok, y.id)) {
    const target = want.get(relNum(f.name));
    if (!target || target === y.name.trim()) continue;
    let ty = years.find(x => x.name.trim() === target);
    if (!ty) { ty = await mkFolder(tok, root, target); years.push(ty); }
    await moveFolder(tok, f.id, y.id, ty.id);
    moved.push(`${f.name}: ${y.name.trim()} → ${target}`);
  }
  return moved;
}
const mkFolder = (tok, parent, name) => gDrive(tok, 'files?fields=id,name', { method: 'POST', json: { name, mimeType: FOLDER, parents: [parent] } });
const catNum = v => { const m = String(v || '').match(/(\d+)\s*$/) || String(v || '').match(/(\d+)/); return m ? Number(m[1]) : null; };
// carpeta de cada release: «[HRZ#105] Artista 1 & Artista 2 - Track», dentro del año en que sale.
// Si ya existe una carpeta con ese número (en cualquier año), se usa esa.
// cal: { year } si el calendario tiene la fecha de este release; known: [{ n, year }] releases del calendario con su año.
// Si no está en el calendario, va al año del release anterior más cercano por número (calendario o carpetas del Drive):
// los números van en orden, así que el HRZ#105 va donde está el HRZ#104 (o después). Si no existe la carpeta del año, se crea.
export async function saveToDrive(env, root, c, bytes, cal = {}) {
  const tok = await horizonToken(env);
  const years = (await subfolders(tok, root)).filter(y => /^\d{4}$/.test(y.name.trim())).sort((a, b) => b.name.localeCompare(a.name));
  const n = catNum(c.release_cat), known = [...(cal.known || [])];
  let dest = null, path = '';
  if (n !== null) for (const y of years) {
    const rels = await subfolders(tok, y.id);
    for (const x of rels) { const k = catNum((x.name.match(/^\[?[^\s\]-]*\d+/) || [''])[0]); if (k !== null) known.push({ n: k, year: Number(y.name) }); }
    const f = rels.find(x => catNum((x.name.match(/^\[?[^\s\]-]*\d+/) || [''])[0]) === n);
    if (!f) continue;
    if (cal.year && String(cal.year) !== y.name.trim()) {
      // la carpeta está en otro año que el del calendario: se mueve a su año (no se crea otra)
      const ty = years.find(x => x.name.trim() === String(cal.year)) || await mkFolder(tok, root, String(cal.year));
      await moveFolder(tok, f.id, y.id, ty.id);
      dest = f; path = `${cal.year} / ${f.name}`; break;
    }
    dest = f; path = `${y.name} / ${f.name}`; break;
  }
  if (!dest) {
    const prev = n === null ? null : known.filter(x => x.n < n).sort((a, b) => b.n - a.n || b.year - a.year)[0];
    const year = String(cal.year || prev?.year || new Date(c.signed_at || Date.now()).getFullYear());
    const y = years.find(f => f.name.trim() === year) || await mkFolder(tok, root, year);
    dest = y; path = year;
    if (c.release_cat) {
      const artists = String(c.artist || '').split(/\s*(?:,|&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean).join(' & ');
      const who = [artists, c.release_name].filter(Boolean).join(' - ');
      const name = `[${c.release_cat}]${who ? ' ' + who : ''}`.split('/').join('-');
      dest = (await subfolders(tok, y.id)).find(x => catNum((x.name.match(/^\[?[^\s\]-]*\d+/) || [''])[0]) === n) || await mkFolder(tok, y.id, name);
      path += ' / ' + dest.name;
    }
  }
  // como el asunto de los correos: «HORIZON RCRDS RELEASE CONTRACT ǀ Artista - Track.pdf»
  const name = `${mailName(c).replace(/\|/g, 'ǀ').replace(/[\/:*?"<>]+/g, '').trim()}.pdf`, B = 'hz' + crypto.randomUUID().replace(/-/g, '');
  const head = `--${B}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [dest.id], mimeType: 'application/pdf' })}\r\n--${B}\r\nContent-Type: application/pdf\r\n\r\n`;
  const body = new Blob([head, bytes, `\r\n--${B}--`]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${B}` }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive: ${j.error?.message || 'error ' + r.status}`);
  return { id: j.id, path };
}
