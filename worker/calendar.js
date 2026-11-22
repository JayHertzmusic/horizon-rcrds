/* Calendario de HORIZON RCRDS (panel → Calendar): releases y mixtapes con su fecha.
   Permiso: sección «calendar» de los roles (ver / editar). Los owners siempre.
   Cada fecha puede ir ligada a un contrato firmado (así se ve qué firmado tiene ya fecha y cuál no). */
import { horizonToken, subfolders, placeReleaseFolders } from './gdocs.js';

export class CalendarError extends Error { constructor(status, message) { super(message); this.status = status; } }
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['release', 'mixtape', 'other'];

export const CALENDAR_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS calendar (id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'release', artist TEXT, title TEXT NOT NULL, cat TEXT, note TEXT, programmed INTEGER NOT NULL DEFAULT 0, contract_id TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS calendar_date ON calendar (date)`,
];

// lo que ya teníais en Discord (#horizon-calendar), se pone una vez
const SEED = [
  ['2026-12-02', 'mixtape', 'Jay Hertz', 'Mixtape #012 - December', 0],
  ['2026-12-25', 'mixtape', '', 'YEARMIX 2026 - December', 1],
  ['2026-11-20', 'release', 'VENTA', 'Back', 0],
  ['2026-11-27', 'release', 'PEBR', 'Your Love', 0],
  ['2027-01-22', 'release', 'Saint Abloh', 'FXXK Up The Club', 0],
  ['2027-01-29', 'release', 'LucidZhou', 'Turn Up The Bass', 0],
  ['2027-02-05', 'release', 'Ball VRP & Novel Soul', 'Be With U', 0],
  ['2027-02-12', 'release', 'VeloNeon & Epiclight', 'I’ll Be Gone', 0],
  ['2027-02-19', 'release', 'MAGZ', 'Goodbyes', 0],
  ['2027-02-26', 'release', 'PEBR', 'A Dream', 0],
  ['2027-03-05', 'release', 'Symon Jump', 'Tharsis', 0],
  ['2027-03-12', 'release', 'Jay Hertz & Neutro', 'Clarity', 0],
  ['2027-03-19', 'release', 'DVSTG', 'Future Sight (Meduza)', 0],
  ['2027-03-26', 'release', 'Ryat. & XuBCter', 'Never Leave U', 0],
  ['2027-04-02', 'release', 'SunsetStation & Mike Rivera', 'Follow Me', 0],
  ['2027-04-09', 'release', 'Synthesis', 'Beyond The World', 0],
];
// números de release de esas fechas (los de las carpetas del Drive de contratos)
const SEED_CATS = ['HRZ#091', 'HRZ#092', 'HRZ#093', 'HRZ#094', 'HRZ#095', 'HRZ#096', 'HRZ#097', 'HRZ#098', 'HRZ#099', 'HRZ#100', 'HRZ#101', 'HRZ#102', 'HRZ#103', 'HRZ#104'];
async function seed(DB) {
  const done = await DB.prepare("SELECT value FROM panel_settings WHERE key = 'calendar_seeded'").first();
  if (done) {
    if (done.value === '1') await DB.batch([
      ...SEED_CATS.map((cat, i) => DB.prepare('UPDATE calendar SET cat = ? WHERE id = ? AND cat IS NULL').bind(cat, `cal_seed${i + 2}`)),
      DB.prepare("UPDATE panel_settings SET value = '2' WHERE key = 'calendar_seeded'"),
    ]);
    return;
  }
  const t = Date.now();
  await DB.batch([
    ...SEED.map(([date, kind, artist, title, prog], i) => DB.prepare('INSERT OR IGNORE INTO calendar (id, date, kind, artist, title, programmed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`cal_seed${i}`, date, kind, artist, title, prog, 'discord', t, t)),
    ...SEED_CATS.map((cat, i) => DB.prepare('UPDATE calendar SET cat = ? WHERE id = ?').bind(cat, `cal_seed${i + 2}`)),
    DB.prepare("INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('calendar_seeded', '2')"),
  ]);
}

export async function calendarApi(req, env, s, url, can, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!can('view')) throw new CalendarError(403, 'Your role has no Calendar access.');
  const edit = () => { if (!can('edit') || s.sync) throw new CalendarError(403, 'Your role can only view the calendar.'); };
  // rol con «Mixtapes only»: solo ve y cambia las fechas de mixtapes (ni releases, ni contratos)
  const mixOnly = !s.owner && !!s.perms?.calendar?.mixtapes;
  if (p === '/api/calendar' && m === 'GET') {
    await seed(DB);
    const items = (await DB.prepare(`SELECT * FROM calendar ${mixOnly ? "WHERE kind = 'mixtape' " : ''}ORDER BY date, created_at`).all()).results;
    if (mixOnly) return { items, unscheduled: [], discord: parse((await DB.prepare("SELECT value FROM panel_settings WHERE key = 'calendar_discord'").first())?.value), canEdit: can('edit') && !s.sync, mixOnly: true };
    // contratos firmados que aún no tienen fecha en el calendario
    const signed = (await DB.prepare("SELECT id, title, artist, release_cat, release_name, signed_at FROM contracts WHERE status = 'signed' AND (kind IS NULL OR kind = 'contract') AND id NOT IN (SELECT contract_id FROM calendar WHERE contract_id IS NOT NULL) ORDER BY signed_at DESC LIMIT 50").all()).results;
    const dc = parse((await DB.prepare("SELECT value FROM panel_settings WHERE key = 'calendar_discord'").first())?.value);
    // un contrato también tiene fecha si en el calendario está su release (las fechas de Discord no van enlazadas al contrato):
    // mismo número (HRZ#…) o mismo artista principal y título
    const first = a => norm(String(a || '').split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\b\.?|\bft\b\.?)\s*/i)[0]);
    const has = c => items.some(i => i.kind === 'release' && ((c.release_cat && i.cat && norm(i.cat) === norm(c.release_cat))
      || (c.release_name && norm(i.title) === norm(c.release_name) && (!i.artist || !c.artist || first(i.artist) === first(c.artist)))));
    return { items, unscheduled: signed.filter(c => !has(c)), discord: dc, canEdit: can('edit') && !s.sync };
  }
  if (p === '/api/calendar' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const date = clean(b.date, 10), title = clean(b.title, 160);
    if (!DATE.test(date)) throw new CalendarError(400, 'Choose a date.');
    if (!title) throw new CalendarError(400, 'Write the title.');
    const kind = mixOnly ? 'mixtape' : KINDS.includes(b.kind) ? b.kind : 'release';
    if (mixOnly && b.id && (await DB.prepare('SELECT kind FROM calendar WHERE id = ?').bind(String(b.id)).first())?.kind !== 'mixtape') throw new CalendarError(403, 'Your role can only change mixtape dates.');
    const row = [date, kind, clean(b.artist, 160), title, clean(b.cat, 40) || null, clean(b.note, 500) || null, b.programmed ? 1 : 0, clean(b.contract_id, 40) || null];
    const t = Date.now();
    if (b.id) {
      const r = await DB.prepare('UPDATE calendar SET date = ?, kind = ?, artist = ?, title = ?, cat = ?, note = ?, programmed = ?, contract_id = COALESCE(?, contract_id), updated_at = ? WHERE id = ?').bind(...row, t, String(b.id)).run();
      if (!r.meta.changes) throw new CalendarError(404, 'That date no longer exists.');
      await audit(`Changed the calendar: ${date} · ${row[2] ? row[2] + ' - ' : ''}${title}`);
      return { ok: true, id: b.id };
    }
    const id = 'cal_' + crypto.randomUUID().slice(0, 10);
    await DB.prepare('INSERT INTO calendar (date, kind, artist, title, cat, note, programmed, contract_id, id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...row, id, s.email, t, t).run();
    await audit(`Added to the calendar: ${date} · ${row[2] ? row[2] + ' - ' : ''}${title}`);
    return { ok: true, id };
  }
  const mm = p.match(/^\/api\/calendar\/([\w-]+)$/);
  if (mm && m === 'DELETE') {
    edit();
    const r = await DB.prepare('SELECT * FROM calendar WHERE id = ?').bind(mm[1]).first();
    if (!r) throw new CalendarError(404, 'That date no longer exists.');
    if (mixOnly && r.kind !== 'mixtape') throw new CalendarError(403, 'Your role can only change mixtape dates.');
    await DB.prepare('DELETE FROM calendar WHERE id = ?').bind(r.id).run();
    await audit(`Removed from the calendar: ${r.date} · ${r.artist ? r.artist + ' - ' : ''}${r.title}`);
    return { ok: true };
  }
  throw new CalendarError(404, 'Not found.');
}

/* ---------- #horizon-calendar (Discord) → Calendar ----------
   El bot de Discord manda cada 10 min los mensajes del canal. Las líneas con fecha («20.11.26 - VENTA - Back»,
   «02.12.26 | Mixtape #012 | Jay Hertz - December») se convierten en fechas del calendario: lo que cambia en Discord
   cambia aquí, lo nuevo se añade y lo que ya no está (y aún no ha salido) se quita. Lo añadido a mano en la web se respeta. */
const norm = v => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');   // letras de cualquier idioma (chino, cirílico…): antes un nombre chino quedaba vacío y se confundía con otros
// Fechas de #horizon-calendar. Se entienden muchas formas de escribirlas (no solo «16/04/2027 - Artista - Título»):
// 16/04/2027, 16.04.27, 16-04-2027, 16/04 (sin año: la próxima vez que llegue), «16 April 2027», «16 de abril»,
// «April 16, 2027», con viñetas delante (•, -, >) y también con la fecha al final («Artista - Título - 16/04/2027»).
const MONTHS = { jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7, aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9,
  septiembre: 9, setiembre: 9, oct: 10, october: 10, octubre: 10, nov: 11, november: 11, noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12 };
const SEP = '[|\\-–—:]';
function mkDate(d, m, y, today) {
  d = Number(d); m = Number(m);
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return '';
  let year = y ? (String(y).length === 2 ? 2000 + Number(y) : Number(y)) : today.getUTCFullYear();
  const iso = yy => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // sin año: la próxima vez que llega esa fecha (si ya pasó hace más de 2 meses, la del año que viene)
  if (!y && Date.parse(iso(year)) < today.getTime() - 60 * 864e5) year++;
  const out = iso(year), t = Date.parse(out);
  return isNaN(t) || new Date(t).getUTCDate() !== d ? '' : out;
}
function lineDate(line, today) {
  let m;
  // 1) la fecha delante: 16/04/2027 · 16.04.27 · 16-04-2027 · 16/04
  if ((m = line.match(new RegExp(`^(\\d{1,2})[./-](\\d{1,2})(?:[./-](\\d{2,4}))?(?![\\d])\\s*${SEP}?\\s*(.+)$`)))) return { date: mkDate(m[1], m[2], m[3], today), rest: m[4] };
  // 2) «16 April 2027», «16th April», «16 de abril de 2027»
  if ((m = line.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:de\\s+)?([a-záé]{3,10})\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?\\s*${SEP}?\\s*(.+)$`, 'i'))) && MONTHS[m[2].toLowerCase()])
    return { date: mkDate(m[1], MONTHS[m[2].toLowerCase()], m[3], today), rest: m[4] };
  // 3) «April 16, 2027»
  if ((m = line.match(new RegExp(`^([a-záé]{3,10})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s*${SEP}?\\s*(.+)$`, 'i'))) && MONTHS[m[1].toLowerCase()])
    return { date: mkDate(m[2], MONTHS[m[1].toLowerCase()], m[3], today), rest: m[4] };
  // 4) la fecha al final: «Tedexon - Wild Ones - 16/04/2027», «Tedexon - Wild Ones (16.04.27)»
  if ((m = line.match(new RegExp(`^(.+?)\\s*(?:${SEP}|[(\\[])\\s*(\\d{1,2})[./-](\\d{1,2})(?:[./-](\\d{2,4}))?\\s*[)\\]]?$`)))) return { date: mkDate(m[2], m[3], m[4], today), rest: m[1] };
  return null;
}
export function parseDiscordCalendar(messages, skipped = [], today = new Date()) {
  const out = [];
  for (const m of messages || []) {
    let kind = 'release';
    for (let line of String(m.content || '').split('\n')) {
      line = line.replace(/\*\*|__|~~|`|\*/g, '').replace(/\s+/g, ' ').trim().replace(/^[•·>\-–—+]\s*/, '').replace(/^\d{1,2}[.)]\s+(?=\d)/, '').trim();
      if (!line) continue;
      const hit = lineDate(line, today);
      if (!hit || !hit.date) {
        if (!/\d/.test(line.slice(0, 3)) && /mixtape/i.test(line)) kind = 'mixtape';
        else if (!/\d/.test(line.slice(0, 3)) && /release/i.test(line)) kind = 'release';
        // parece un release pero no se entiende la fecha: se avisa en el panel (nunca se pierde en silencio)
        else if (/\s-\s|\|/.test(line) || /\d/.test(line)) skipped.push(line.slice(0, 120));
        continue;
      }
      let rest = hit.rest.trim();
      const programmed = /\[\s*programmed\s*\]/i.test(rest);
      rest = rest.replace(/\[\s*programmed\s*\]/ig, '').replace(/^[|\-–—:\s]+|[|\-–—:\s]+$/g, '').trim();
      if (!rest) { skipped.push(line.slice(0, 120)); continue; }
      let artist = '', title = rest;
      const parts = rest.split(/\s*\|\s*/).filter(Boolean);
      if (parts.length >= 2) {   // «Mixtape #012 | Jay Hertz - December»
        const [a, ...b] = parts[1].split(/\s+[-–—]\s+/);
        artist = b.length ? a : '';
        title = b.length ? `${parts[0]} - ${b.join(' - ')}` : `${parts[0]} - ${parts[1]}`;
      } else if (kind === 'release') {   // «VENTA - Back»
        const [a, ...b] = rest.split(/\s+[-–—]\s+/);
        if (b.length) { artist = a; title = b.join(' - '); }
      }
      out.push({ date: hit.date, kind, artist: artist.trim(), title: title.trim(), programmed });
    }
  }
  return out;
}
export async function discordCalendarHook(req, env) {
  // solo desde el bot (enlace interno entre Workers: no viene de internet)
  if ((req.headers.get('cf-connecting-ip') && env.DEV_LOGIN !== '1') || req.headers.get('x-horizon-bot') !== '1') throw new CalendarError(404, 'Not found.');   // (en local, para probar)
  const DB = env.DB, b = parse(await req.text()) || {};
  // del más viejo al más nuevo (Discord los da del más nuevo al más viejo): así, si un release sale en dos mensajes,
  // vale la fecha del mensaje más reciente y no la del antiguo
  const sid = m => /^\d{5,25}$/.test(String(m?.id || '')) ? String(m.id).padStart(25, '0') : '';
  const msgs = (Array.isArray(b.messages) ? b.messages.slice(0, 50) : []).map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => sid(x) && sid(y) ? (sid(x) < sid(y) ? -1 : 1) : i - j).map(([m]) => m);
  // si una fecha sale varias veces (mensajes viejos y nuevos), vale la del mensaje más reciente
  const skipped = [];
  const lines = [...new Map(parseDiscordCalendar(msgs, skipped).map(x => [x.kind + norm(x.artist) + norm(x.title), x])).values()];
  const status = { at: Date.now(), messages: msgs.length, lines: lines.length, skipped: [...new Set(skipped)].slice(0, 10), noText: msgs.length > 0 && msgs.every(m => !m.content), noAccess: b.error === 'no-access' };
  await DB.prepare("INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('calendar_discord', ?)").bind(JSON.stringify(status)).run();
  if (!lines.length) return { ok: true, ...status };
  await seed(DB);
  const hash = JSON.stringify(lines);
  const last = await DB.prepare("SELECT value FROM panel_settings WHERE key = 'calendar_discord_hash'").first();
  // (antes, si el texto de Discord no cambiaba no se miraba nada: una fecha que faltara en la web no volvía nunca.
  //  Ahora siempre se compara con el calendario y solo se escribe si algo no cuadra)
  const rows = (await DB.prepare('SELECT * FROM calendar').all()).results, used = new Set(), t = Date.now(), ops = [];
  const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 864e5).toISOString().slice(0, 10);   // (margen de un día por la zona horaria)
  for (const x of lines) {
    const key = x.kind + norm(x.artist) + norm(x.title);
    const r = rows.find(y => !used.has(y.id) && y.kind + norm(y.artist) + norm(y.title) === key)
      || rows.find(y => !used.has(y.id) && y.kind === x.kind && norm(y.title) === norm(x.title) && (!x.artist || !y.artist || norm(y.artist) === norm(x.artist)));
    if (r) {
      used.add(r.id);
      if (r.date !== x.date || !!r.programmed !== x.programmed || r.artist !== x.artist || r.title !== x.title)
        ops.push(DB.prepare('UPDATE calendar SET date = ?, programmed = ?, artist = ?, title = ?, updated_at = ? WHERE id = ?').bind(x.date, x.programmed ? 1 : 0, x.artist, x.title, t, r.id));
    } else {
      const id = 'cal_' + crypto.randomUUID().slice(0, 10);
      used.add(id);
      ops.push(DB.prepare('INSERT INTO calendar (id, date, kind, artist, title, programmed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, x.date, x.kind, x.artist, x.title, x.programmed ? 1 : 0, 'discord', t, t));
    }
  }
  // lo que venía de Discord y ya no está (y todavía no ha salido) se quita; lo que ya salió (o sale hoy) se queda: en Discord se borra al salir
  for (const r of rows) if (!used.has(r.id) && r.created_by === 'discord' && r.date > soon) ops.push(DB.prepare('DELETE FROM calendar WHERE id = ?').bind(r.id));
  if (!ops.length && last?.value === hash) return { ok: true, unchanged: true };   // todo cuadra: no se escribe nada
  ops.push(DB.prepare("INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('calendar_discord_hash', ?)").bind(hash));
  await DB.batch(ops);
  await fillCats(env).catch(e => console.error('calendar cats', e));
  // si una fecha cambia de año, su carpeta del Drive de contratos se mueve a ese año
  let moved = [];
  try {
    const root = (await DB.prepare("SELECT value FROM panel_settings WHERE key = 'contracts_drive'").first())?.value;
    const rel = (await DB.prepare("SELECT date, cat FROM calendar WHERE kind = 'release' AND cat IS NOT NULL AND cat <> ''").all()).results;
    if (root) moved = await placeReleaseFolders(env, root, rel.map(r => ({ cat: r.cat, year: r.date.slice(0, 4) })));
    if (moved.length) await DB.prepare('INSERT INTO panel_audit (at, email, name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(Date.now(), '', 'Discord calendar', `Moved in Drive: ${moved.join(' · ')}`.slice(0, 500), '').run();
  } catch (e) { console.error('calendar drive', e); }
  return { ok: true, changed: ops.length - 1, moved };
}
// número de release de las fechas nuevas: el de su carpeta en el Drive de contratos («[HRZ#105] Nune - U»)
async function fillCats(env) {
  const DB = env.DB;
  let todo = (await DB.prepare("SELECT id, artist, title FROM calendar WHERE kind = 'release' AND (cat IS NULL OR cat = '')").all()).results;
  if (!todo.length) return;
  // primero, el número que tenga su contrato (mismo artista y track)
  const cts = (await DB.prepare("SELECT artist, release_name, release_cat FROM contracts WHERE release_cat IS NOT NULL AND release_cat <> '' AND (kind IS NULL OR kind = 'contract')").all()).results;
  const byContract = [];
  for (const r of todo) {
    const c = cts.find(x => norm(x.release_name) === norm(r.title) && norm(String(x.artist || '').split(/\s*(?:,|&|\band\b)\s*/i)[0]) === norm(String(r.artist || '').split(/\s*(?:,|&|\band\b)\s*/i)[0]));
    if (c) byContract.push(DB.prepare('UPDATE calendar SET cat = ? WHERE id = ?').bind(c.release_cat, r.id));
  }
  if (byContract.length) { await DB.batch(byContract); todo = (await DB.prepare("SELECT id, artist, title FROM calendar WHERE kind = 'release' AND (cat IS NULL OR cat = '')").all()).results; if (!todo.length) return; }
  const root = (await DB.prepare("SELECT value FROM panel_settings WHERE key = 'contracts_drive'").first())?.value;
  if (!root) return;
  const tok = await horizonToken(env), names = [];
  for (const y of await subfolders(tok, root)) if (/^\d{4}$/.test(y.name.trim()) && Number(y.name) >= new Date().getFullYear() - 1) names.push(...(await subfolders(tok, y.id)).map(f => f.name));
  const ops = [];
  for (const r of todo) {
    const want = norm(`${r.artist}${r.title}`);
    const f = names.find(nm => { const m = nm.match(/^\[([^\]]+)\]\s*(.+)$/); return m && norm(m[2]) === want; });
    const cat = f?.match(/^\[([^\]]+)\]/)?.[1];
    if (cat && /\d/.test(cat)) ops.push(DB.prepare('UPDATE calendar SET cat = ? WHERE id = ?').bind(cat, r.id));
  }
  if (ops.length) await DB.batch(ops);
}
