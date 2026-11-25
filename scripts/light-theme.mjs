/* Genera admin/light.css (modo claro del panel) a partir de admin/admin.css.
   Los colores neutros (negros, grises, blancos) se invierten; los que tienen color (rojo, verde, el del release…)
   se quedan igual. Las sombras siguen siendo sombras (más suaves). Así el texto se dibuja nítido (sin filtros).
   Uso, después de tocar admin.css:  node scripts/light-theme.mjs   (y subir ?v= de light.css) */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('admin/admin.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^()]*\)|\b(?:white|black)\b/gi;
const SHADOW = /^(box-shadow|text-shadow)$/;

function parse(c) {
  c = c.toLowerCase();
  if (c === 'white') return [255, 255, 255, 1];
  if (c === 'black') return [0, 0, 0, 1];
  if (c[0] === '#') {
    let h = c.slice(1); if (h.length <= 4) h = [...h].map(x => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const p = c.replace(/rgba?\(|\)/g, '').split(/[\s,/]+/).filter(Boolean);
  if (p.length < 3 || p.some(x => x.startsWith('var'))) return null;
  return [+p[0], +p[1], +p[2], p[3] == null ? 1 : +p[3]];
}
const fmt = ([r, g, b, a]) => a >= 1 ? '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('') : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;
const neutral = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 26;

// un valor con colores → el mismo valor en claro (o null si no cambia nada)
function lighten(prop, val) {
  let changed = false;
  const out = val.replace(COLOR, m => {
    const c = parse(m); if (!c || !neutral(c)) return m;
    const lum = (c[0] + c[1] + c[2]) / 3;
    let n;
    if (SHADOW.test(prop)) n = lum > 128 ? [0, 0, 0, c[3] * .12] : [0, 0, 0, Math.min(.18, c[3] * .3)];   // brillos blancos → sombra suave
    else { const v = 255 - lum; n = [v, v, v, c[3]]; }   // gris puro (sin tono)
    changed = true; return fmt(n);
  });
  return changed ? out : null;
}
// «html…» y «:root» ya son la raíz: se les añade .light; lo demás va dentro de html.light
function scope(sel) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean).map(s => {
    if (s.startsWith(':root')) return 'html.light' + s.slice(5);
    if (/^html\b/.test(s)) return s.replace(/^html/, 'html.light');
    if (s.startsWith('::view-transition')) return null;
    return 'html.light ' + s;
  }).filter(Boolean).join(', ');
}
// recorre las reglas (con @media dentro) y apunta cada declaración en orden
const entries = [];
function split(sel) { const parts = []; let depth = 0, cur = ''; for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { parts.push(cur.trim()); cur = ''; } else cur += ch; } parts.push(cur.trim()); return parts.filter(Boolean); }
function walk(css, media = '') {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i); if (open < 0) break;
    const head = css.slice(i, open).trim();
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      let d = 1, j = open + 1; while (j < css.length && d) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; }
      walk(css.slice(open + 1, j - 1), head); i = j; continue;
    }
    if (head.startsWith('@')) { let d = 1, j = open + 1; while (j < css.length && d) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; } i = j; continue; }
    const close = css.indexOf('}', open), body = css.slice(open + 1, close);
    for (const d of body.split(/;(?![^(]*\))/)) {
      const k = d.indexOf(':'); if (k < 0) continue;
      const prop = d.slice(0, k).trim(), val = d.slice(k + 1).trim().replace(/\s*!important$/, '');
      if (!prop || prop.startsWith('--') && !/^--(bg|panel|panel-2|line|line-2|text|muted|faint)$/.test(prop)) continue;
      if (/^(-webkit-)?mask|filter$/.test(prop)) continue;
      for (const sel of split(head)) entries.push({ media, sel, prop, val, imp: /!important/.test(d) });
    }
    i = close + 1;
  }
}
walk(src);
// familia de propiedades (un «background» posterior pisa a un «background-color» anterior y al revés)
const fam = p => /^background(-color|-image)?$/.test(p) ? 'background' : /^border(-(top|right|bottom|left))?(-color)?$/.test(p) ? 'border:' + (p.match(/top|right|bottom|left/) || ['all'])[0] : p;
const last = new Map();
entries.forEach((e, i) => { const key = e.media + '|' + e.sel + '|' + fam(e.prop); last.set(key, i); if (fam(e.prop).startsWith('border:all')) for (const side of ['top', 'right', 'bottom', 'left']) last.set(e.media + '|' + e.sel + '|border:' + side, i); });
// solo cuenta la última declaración de cada selector y propiedad (si la última ya tiene color propio, no se toca)
const groups = new Map();
entries.forEach((e, i) => {
  if (last.get(e.media + '|' + e.sel + '|' + fam(e.prop)) !== i) return;
  const v = lighten(e.prop, e.val); if (v == null) return;
  const sel = scope(e.sel); if (!sel) return;
  const g = e.media + '\u0000' + sel;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(`${e.prop}: ${v}${e.imp ? ' !important' : ''}`);
});
let body = '';
for (const [g, decls] of groups) { const [media, sel] = g.split('\u0000'); body += media ? `${media} { ${sel} { ${decls.join('; ')}; } }\n` : `${sel} { ${decls.join('; ')}; }\n`; }
// retoques a mano (lo que la conversión automática no puede saber)
const FIX = `
html.light .hm-me { -webkit-background-clip: text; background-clip: text; color: transparent; }
html.light .pub-sw.on .pub-knob { background: #22c55e; }
html.light .pub-sw.on .pub-knob::after { background: #fff; }
html.light .pub-sw.on { color: #15803d; }
html.light .tag.ok { color: #15803d; }
html.light .lv-card { background: linear-gradient(180deg, rgba(255,255,255,.95), rgba(245,245,245,.95)); color: #111; box-shadow: 0 18px 40px -16px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.06); }
html.light .lv-txt small { color: #52525b; }
/* quien tiene el color blanco: en claro se ve en gris oscuro */
html.light [style*="--c:#ffffff"], html.light [style*="--c:#fff;"], html.light [style*="--c:#FFFFFF"] { --c: #27272a !important; }
`;
const css = `/* MODO CLARO del panel — generado por scripts/light-theme.mjs a partir de admin.css (no editar a mano). */
html.light { color-scheme: light; --accent: #111111 !important; --accent-rgb: 17, 17, 17 !important; }
${body}${FIX}`;
writeFileSync('admin/light.css', css);
console.log('admin/light.css:', css.split('\n').length, 'líneas');
