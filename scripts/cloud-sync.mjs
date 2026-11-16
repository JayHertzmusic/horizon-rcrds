// HORIZON RCRDS — puente entre la sincronización con SoundCloud (GitHub Actions) y la web en Cloudflare.
//   node scripts/cloud-sync.mjs pull  → baja los datos de la web (releases, mixtapes…) y los archivos subidos
//                                       desde el panel a esta carpeta, y apunta cómo estaba todo.
//   node scripts/cloud-sync.mjs push  → manda a la web lo que sync-soundcloud.mjs ha cambiado.
// Se identifica con el token OIDC que GitHub da a este workflow (permissions: id-token: write): sin claves.
// Env: SITE_URL (por defecto la dirección de Cloudflare), SITE_DIR, SYNC_MESSAGE_FILE, SYNC_STATE (archivo de estado),
//      SYNC_TOKEN (solo para pruebas en local: una sesión del panel en vez del token de GitHub).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SITE = (process.env.SITE_URL || 'https://horizon-web.horizon-records.workers.dev').replace(/\/+$/, '');
const ROOT = path.resolve(process.env.SITE_DIR || '.');
const STATE = process.env.SYNC_STATE || path.join(process.env.RUNNER_TEMP || '/tmp', 'hz-cloud-state.json');
const LISTS = { releases: 'releases.json', mixtapes: 'mixtapes.json', playlists: 'playlists.json', ignore: 'sync-ignore.json' };
const PROTECTED = ['release_preview.mp3', 'logo.png', 'favicon_icon.png'];
const log = (...a) => console.log('[cloud]', ...a);
const hash = file => fs.existsSync(file) ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : '';
const pretty = v => JSON.stringify(v, null, 2) + '\n';

async function token() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, req = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !req) throw new Error('No hay token de GitHub (falta "permissions: id-token: write" en el workflow).');
  const r = await fetch(`${url}&audience=horizon-web`, { headers: { Authorization: `Bearer ${req}` } });
  if (!r.ok) throw new Error(`GitHub no dio el token (${r.status}).`);
  return (await r.json()).value;
}
async function call(method, p, body) {
  const r = await fetch(SITE + p, { method, headers: { Authorization: `Bearer ${await token()}` }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${r.status} ${j.message || ''}`);
  return j;
}

async function pull() {
  const d = await call('GET', '/api/data');
  for (const [k, f] of Object.entries(LISTS)) fs.writeFileSync(path.join(ROOT, f), pretty(d[k] || []));
  fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
  let got = 0;
  for (const name of Object.keys(d.files || {})) {
    const file = path.join(ROOT, 'assets', name);
    if (fs.existsSync(file) && !PROTECTED.includes(name)) continue;
    const r = await fetch(`${SITE}/assets/${encodeURIComponent(name)}`);
    if (!r.ok) { log(`no se pudo bajar ${name} (${r.status})`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (hash(file) !== crypto.createHash('sha1').update(buf).digest('hex')) { fs.writeFileSync(file, buf); got++; }
  }
  const files = {};
  for (const name of fs.readdirSync(path.join(ROOT, 'assets'))) if (fs.statSync(path.join(ROOT, 'assets', name)).isFile()) files[name] = hash(path.join(ROOT, 'assets', name));
  // números de release del Calendar del panel (sync-soundcloud.mjs los usa para los releases nuevos)
  fs.writeFileSync(process.env.SYNC_CAL || path.join(process.env.RUNNER_TEMP || '/tmp', 'hz-calendar.json'), JSON.stringify(d.calendar || []));
  fs.writeFileSync(STATE, JSON.stringify({ version: d.version, lists: Object.fromEntries(Object.keys(LISTS).map(k => [k, d[k] || []])), files }));
  log(`versión ${d.version} · ${got} archivos bajados de la web`);
}

async function push() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const lists = {};
  for (const [k, f] of Object.entries(LISTS)) {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8').trim() || '[]');
    if (JSON.stringify(v) !== JSON.stringify(st.lists[k])) lists[k] = v;
  }
  const form = new FormData(), sent = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'assets'))) {
    const file = path.join(ROOT, 'assets', name);
    if (!fs.statSync(file).isFile() || st.files[name] === hash(file)) continue;
    form.append('file:' + name, new Blob([fs.readFileSync(file)]), name);
    sent.push(name);
  }
  if (!Object.keys(lists).length && !sent.length) { log('nada que enviar'); return; }
  const message = (process.env.SYNC_MESSAGE_FILE && fs.existsSync(process.env.SYNC_MESSAGE_FILE)
    ? fs.readFileSync(process.env.SYNC_MESSAGE_FILE, 'utf8').trim().split('\n').filter(Boolean).join(' · ') : '') || 'Sync from SoundCloud';
  form.append('meta', JSON.stringify({ base: st.version, message, lists }));
  const res = await call('POST', '/api/publish', form);
  log(`enviado: ${Object.keys(lists).join(', ') || '-'} · archivos: ${sent.join(', ') || '-'} → versión ${res.version ?? st.version}`);
}

const cmd = process.argv[2];
if (cmd === 'pull') await pull();
else if (cmd === 'push') await push();
else { console.error('Uso: node scripts/cloud-sync.mjs pull|push'); process.exit(1); }
