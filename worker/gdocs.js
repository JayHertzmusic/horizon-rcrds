import { mailName } from './contract-mail.js';
/* Google Docs y Drive con la cuenta de Horizon, hechos por el servidor (así cualquiera del equipo con permiso de
   Contracts crea contratos sin iniciar sesión en Google). El permiso lo da el script de Apps Script de Horizon
   (aplicación web, GSCRIPT_URL): devuelve un token de Google de la cuenta de Horizon; aquí se guarda ~50 min. */
let cached = null;
export async function horizonToken(env) {
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const kv = await env.FILES.get('google/token', { type: 'json' }).catch(() => null);
  if (kv?.token && kv.exp > Date.now() + 60e3) { cached = kv; return kv.token; }
  if (!env.GSCRIPT_URL || !env.GFORM_SECRET) throw new Error('Google is not connected yet (the Horizon script is missing).');
  const r = await fetch(env.GSCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.GFORM_SECRET, action: 'token' }), redirect: 'follow' });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Google did not give access. Check the Horizon script (Deploy → Web app).');
  cached = { token: j.token, exp: Date.now() + 50 * 60e3 };
  await env.FILES.put('google/token', JSON.stringify(cached), { expirationTtl: 3000 });
  return j.token;
}
async function gapi(tok, url, body) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
const flatTabs = (tabs, out = []) => { for (const t of tabs || []) { out.push(t.tabProperties || {}); flatTabs(t.childTabs, out); } return out; };
export async function docFromTemplate(env, docUrl, values, title) {
  const tok = await horizonToken(env);
  const d = docParts(docUrl);
  if (!d) throw new Error('The template’s Google Doc link is not valid.');
  const copy = await gapi(tok, `https://www.googleapis.com/drive/v3/files/${d.id}/copy?fields=id&supportsAllDrives=true`, { name: `HORIZON RCRDS — ${title}` });
  // la copia conserva casi siempre los ids de las pestañas: se lee una vez y solo si no está la pestaña se busca por su posición
  let tab = d.tab;
  const full = await gapi(tok, `https://docs.googleapis.com/v1/documents/${copy.id}?includeTabsContent=true`);
  let tabObj = tab ? findTab(full.tabs, tab) : full.tabs?.[0];
  if (!tabObj && tab) {
    const q = '?includeTabsContent=true&fields=tabs(tabProperties(tabId,index),childTabs(tabProperties(tabId,index),childTabs(tabProperties(tabId,index))))';
    const ta = flatTabs((await gapi(tok, `https://docs.googleapis.com/v1/documents/${d.id}${q}`)).tabs), tb = flatTabs(full.tabs);
    const id = tb[ta.findIndex(t => t.tabId === tab)]?.tabId;
    tabObj = id ? findTab(full.tabs, id) : null;
  }
  if (!tabObj) throw new Error('Could not find the template tab in the copy.');
  tab = tabObj.tabProperties.tabId;
  const { text, idx, sty } = docText(tabObj.documentTab?.body?.content);
  const requests = [];
  for (const b of findBlanks(text).reverse()) {
    // cláusula 1.2 («Artista, also known as Nombre legal»): con varias copias lleva a todos los artistas; si no, el del contrato
    const v = values[b.name] || (b.name === 'Artists clause name' ? values['Artist name'] : b.name === 'Artists clause legal' ? values['Legal name'] : '');
    if (!v) continue;
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
  if (requests.length) await gapi(tok, `https://docs.googleapis.com/v1/documents/${copy.id}:batchUpdate`, { requests });
  return `https://docs.google.com/document/d/${copy.id}/edit${tab ? '?tab=' + tab : ''}`;
}

/* Guardar el contrato firmado en Drive: carpeta raíz → Año → «HRZ#xxx - Nombre» (se crean si no existen) */
const FOLDER = 'application/vnd.google-apps.folder';
async function gDrive(tok, path, opts = {}) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}${path.includes('?') ? '&' : '?'}supportsAllDrives=true`, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) cached = null; throw new Error(`Google Drive: ${j.error?.message || 'error ' + r.status}`); }
  return j;
}
async function subfolders(tok, parent) {
  const q = encodeURIComponent(`'${parent}' in parents and mimeType='${FOLDER}' and trashed=false`);
  return (await gDrive(tok, `files?q=${q}&fields=files(id,name)&pageSize=1000&includeItemsFromAllDrives=true`)).files || [];
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
    if (f && (!cal.year || String(cal.year) === y.name.trim())) { dest = f; path = `${y.name} / ${f.name}`; break; }
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
  // como el asunto de los correos: «HORIZON RCRDS RELEASE CONTRACT ｜ Artista - Track.pdf»
  const name = `${mailName(c).replace(/\|/g, '｜').replace(/[\/:*?"<>]+/g, '').trim()}.pdf`, B = 'hz' + crypto.randomUUID().replace(/-/g, '');
  const head = `--${B}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [dest.id], mimeType: 'application/pdf' })}\r\n--${B}\r\nContent-Type: application/pdf\r\n\r\n`;
  const body = new Blob([head, bytes, `\r\n--${B}--`]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${B}` }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive: ${j.error?.message || 'error ' + r.status}`);
  return { id: j.id, path };
}
