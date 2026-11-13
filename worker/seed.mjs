// Pasa releases/mixtapes/playlists/sync-ignore.json de esta carpeta a la base de datos de Cloudflare.
// Uso: node worker/seed.mjs > seed.sql  y luego  wrangler d1 execute horizon-web --file=seed.sql (--local o --remote)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = { releases: 'releases.json', mixtapes: 'mixtapes.json', playlists: 'playlists.json', ignore: 'sync-ignore.json' };
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const t = Date.now();
const out = [
  `CREATE TABLE IF NOT EXISTS site_data (name TEXT PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, updated_by TEXT);`,
  `CREATE TABLE IF NOT EXISTS site_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);`,
  `INSERT OR IGNORE INTO site_meta (k, v) VALUES ('version', 0);`,
  `UPDATE site_meta SET v = v + 1 WHERE k = 'version';`,
];
for (const [k, f] of Object.entries(files)) {
  let v = [];
  try { v = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8').trim() || '[]'); } catch { v = []; }
  if (!Array.isArray(v)) v = [];
  out.push(`INSERT INTO site_data (name, json, version, updated_at, updated_by) VALUES (${q(k)}, ${q(JSON.stringify(v, null, 2) + '\n')}, (SELECT v FROM site_meta WHERE k = 'version'), ${t}, 'import') ON CONFLICT(name) DO UPDATE SET json = excluded.json, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by;`);
}
process.stdout.write(out.join('\n') + '\n');
