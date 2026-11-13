// Antes de publicar en Cloudflare: lista los archivos de assets/ que van con la web (nombre, tamaño y huella),
// para que el panel sepa qué hay y pueda poner ?v=… a las imágenes. Lo ejecuta wrangler solo (build.command).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'assets');
const out = {};
for (const name of fs.readdirSync(dir).sort()) {
  const file = path.join(dir, name);
  const st = fs.statSync(file);
  if (!st.isFile() || name.startsWith('.')) continue;
  out[name] = { v: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8), size: st.size };
}
fs.writeFileSync(path.join(here, 'static-files.json'), JSON.stringify(out) + '\n');
console.log(`static-files.json: ${Object.keys(out).length} archivos`);
