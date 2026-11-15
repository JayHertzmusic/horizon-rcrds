/* Calendario de HORIZON RCRDS (panel → Calendar): releases y mixtapes con su fecha.
   Permiso: sección «calendar» de los roles (ver / editar). Los owners siempre.
   Cada fecha puede ir ligada a un contrato firmado (así se ve qué firmado tiene ya fecha y cuál no). */
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
async function seed(DB) {
  const done = await DB.prepare("SELECT value FROM panel_settings WHERE key = 'calendar_seeded'").first();
  if (done) return;
  const t = Date.now();
  await DB.batch([
    ...SEED.map(([date, kind, artist, title, prog], i) => DB.prepare('INSERT OR IGNORE INTO calendar (id, date, kind, artist, title, programmed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`cal_seed${i}`, date, kind, artist, title, prog, 'discord', t, t)),
    DB.prepare("INSERT OR REPLACE INTO panel_settings (key, value) VALUES ('calendar_seeded', '1')"),
  ]);
}

export async function calendarApi(req, env, s, url, can, audit) {
  const DB = env.DB, m = req.method, p = url.pathname;
  if (!can('view')) throw new CalendarError(403, 'Your role has no Calendar access.');
  const edit = () => { if (!can('edit') || s.sync) throw new CalendarError(403, 'Your role can only view the calendar.'); };
  if (p === '/api/calendar' && m === 'GET') {
    await seed(DB);
    const items = (await DB.prepare('SELECT * FROM calendar ORDER BY date, created_at').all()).results;
    // contratos firmados que aún no tienen fecha en el calendario
    const signed = (await DB.prepare("SELECT id, title, artist, release_cat, release_name, signed_at FROM contracts WHERE status = 'signed' AND (kind IS NULL OR kind = 'contract') AND id NOT IN (SELECT contract_id FROM calendar WHERE contract_id IS NOT NULL) ORDER BY signed_at DESC LIMIT 50").all()).results;
    return { items, unscheduled: signed, canEdit: can('edit') && !s.sync };
  }
  if (p === '/api/calendar' && m === 'POST') {
    edit();
    const b = parse(await req.text()) || {};
    const date = clean(b.date, 10), title = clean(b.title, 160);
    if (!DATE.test(date)) throw new CalendarError(400, 'Choose a date.');
    if (!title) throw new CalendarError(400, 'Write the title.');
    const kind = KINDS.includes(b.kind) ? b.kind : 'release';
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
    await DB.prepare('DELETE FROM calendar WHERE id = ?').bind(r.id).run();
    await audit(`Removed from the calendar: ${r.date} · ${r.artist ? r.artist + ' - ' : ''}${r.title}`);
    return { ok: true };
  }
  throw new CalendarError(404, 'Not found.');
}
