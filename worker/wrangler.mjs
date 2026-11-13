// Ejecuta wrangler para la web con la sesión de Cloudflare de HORIZON (la misma que usa el bot),
// desde esta carpeta. Uso:  node worker/wrangler.mjs dev | deploy | d1 … | secret …
// HZ_BOT_DIR = carpeta del bot (donde están wrangler y la sesión .wrangler-home).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bot = process.env.HZ_BOT_DIR || 'D:/HORIZON/HRZ - DISCORD BOT';
const env = { ...process.env, XDG_CONFIG_HOME: path.join(bot, '.wrangler-home') };
const wrangler = path.join(bot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const child = spawn(process.execPath, [wrangler, ...process.argv.slice(2)], { cwd: web, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
