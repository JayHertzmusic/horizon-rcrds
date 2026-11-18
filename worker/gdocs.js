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
  let text = ''; const idx = [], sty = [];
  const walk = els => { for (const el of els || []) {
    if (el.paragraph) for (const pe of el.paragraph.elements || []) { const t = pe.textRun?.content; if (t) for (let k = 0; k < t.length; k++) { text += t[k]; idx.push(pe.startIndex + k); sty.push(pe.textRun.textStyle || {}); } }
    if (el.table) for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content);
  } };
  walk(content);
  return { text, idx, sty };
}
const findTab = (tabs, id) => { for (const t of tabs || []) { if (t.tabProperties?.tabId === id) return t; const c = findTab(t.childTabs, id); if (c) return c; } return null; };
const docParts = u => { const m = String(u).match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/), t = String(u).match(/[?&#]tab=(t\.[\w]+)/); return m ? { id: m[1], tab: t ? t[1] : '' } : null; };
// lo único que se lee de un Doc: pestañas, texto con su posición y el estilo que se copia a los datos
const DOC_EL = 'paragraph(elements(startIndex,textRun(content,textStyle(italic,smallCaps,weightedFontFamily,fontSize,foregroundColor)))),table(tableRows(tableCells(content(paragraph(elements(startIndex,textRun(content,textStyle(italic,smallCaps,weightedFontFamily,fontSize,foregroundColor))))))))';
const DOC_TAB = `tabProperties(tabId,index),documentTab(body(content(${DOC_EL})))`;
const DOC_FIELDS = encodeURIComponent(`tabs(${DOC_TAB},childTabs(${DOC_TAB},childTabs(${DOC_TAB})))`);
const flatTabs = (tabs, out = []) => { for (const t of tabs || []) { out.push(t.tabProperties || {}); flatTabs(t.childTabs, out); } return out; };
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
  const { text, idx, sty } = docText(tabObj.documentTab?.body?.content);
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
