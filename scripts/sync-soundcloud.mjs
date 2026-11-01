// HORIZON RCRDS — keeps the website in sync with SoundCloud.
// Runs on GitHub Actions every few hours (.github/workflows/soundcloud-sync.yml).
//
// Reads the public SoundCloud RSS feed of the label and adds whatever is new:
//   · "HORIZON RCRDS Mixtape #011 | Guest"  → mixtapes.json (Radio) + cover + preview clip from the drop
//   · "Artist - Title"                      → releases.json (next HRZ#) + cover + release_preview.mp3 from the drop
//   · anything else (IDs, Extended Mix versions…) → ignored
// Nothing older than "Kris m - Lights" (HRZ#047, 28 Jan 2026) is ever looked at: the site starts there.
// One exception to "never edits": a release on the site with no Spotify button gets the Spotify link as soon
// as it appears in its SoundCloud description (it is only filled in, never replaced).
// Whatever was deleted in the admin panel is listed in sync-ignore.json and never comes back.
// Links come from the SoundCloud description: "Stream / Download: <smart link>" and, if present,
// an open.spotify.com/track or /album link. Nothing is ever deleted or edited here: the admin panel
// (/admin/) is still the place to fix or remove things.
//
// Env (all optional): SITE_DIR (repo root, default .), FEED_URL / FEED_FILE, FFMPEG (binary),
// SYNC_REQUIRE_FROM (a path inside the folder where `sharp` is installed), DRY=1 (no writes),
// GITHUB_OUTPUT (set by Actions), SYNC_MESSAGE_FILE (commit message is written there).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const FEED_URL = process.env.FEED_URL || 'https://feeds.soundcloud.com/users/soundcloud:users:1309373238/sounds.rss';
const ROOT = path.resolve(process.env.SITE_DIR || '.');
const DRY = process.env.DRY === '1';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SINCE = new Date(process.env.SYNC_SINCE || '2026-01-28T00:00:00Z');   // day of Kris m - Lights
const MAX_NEW = 6;              // safety: never add more than this per run and per type
const COVER_PX = 1000;          // same size as the covers already on the site
const RELEASE_CLIP = 30;        // seconds (release_preview.mp3)
const MIX_CLIP = 45;            // seconds (mixtape preview)
const sharp = createRequire(process.env.SYNC_REQUIRE_FROM || import.meta.url)('sharp');

const log = (...a) => console.log('[sync]', ...a);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return fallback; } };

/* ---------- Feed ---------- */
const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]).trim() : ''; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`)); return m ? decode(m[1]) : ''; };

async function readFeed() {
  const xml = process.env.FEED_FILE ? fs.readFileSync(process.env.FEED_FILE, 'utf8') : await (await fetch(FEED_URL)).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]).map(x => ({
    title: tag(x, 'title'),
    link: tag(x, 'link'),
    date: new Date(tag(x, 'pubDate')),
    text: `${tag(x, 'description')}
${tag(x, 'itunes:summary')}`,
    audio: attr(x, 'enclosure', 'url'),
    image: attr(x, 'itunes:image', 'href'),
  }));
  if (!items.length) throw new Error('The SoundCloud feed is empty or could not be read.');
  return items.filter(it => it.date >= SINCE).sort((a, b) => b.date - a.date);   // newest first
}

/* ---------- What is what ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const scKey = u => String(u || '').split('?')[0].replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '').toLowerCase();
function classify(item) {
  const t = item.title.replace(/\s+/g, ' ').trim();
  const mix = t.match(/mixtape\s*#?\s*(\d+)/i);
  if (mix) {
    const guest = (t.split('|')[1] || '').trim();
    return { kind: 'mixtape', number: '#' + mix[1].padStart(3, '0'), title: t.split('|')[0].trim(), artist: guest };
  }
  if (/\bIDs?\b/.test(t)) return null;                       // IDs, previews of unreleased music
  if (/\bextended\b/i.test(t)) return null;                  // "(Extended Mix)": same release, longer version
  const i = t.indexOf(' - ');
  if (i < 1) return null;
  const artist = t.slice(0, i).trim();
  const title = t.slice(i + 3).replace(/\s*\[[^\]]*\]\s*$/, '').trim();   // "[ADE Sampler 2026]" out
  if (!artist || !title) return null;
  return { kind: 'release', artist, title };
}
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const clean = u => u.replace(/[.,;:!?)\]]+$/, '');
function links(text) {
  const all = (text.match(URL_RE) || []).map(clean);
  const labelled = text.match(/(?:stream|download|listen|out now|pre-?save)[^\n:]*:\s*(https?:\/\/[^\s<>"')]+)/i);
  const SMART = /(^|\.)(too\.fm|ffm\.to|lnk\.to|fanlink\.to|smarturl\.it|hypeddit\.com|distrokid\.com|bfan\.link|orcd\.co|song\.link|album\.link|linktr\.ee)$/i;
  let stream = labelled ? clean(labelled[1]) : '';
  if (!stream) stream = all.find(u => { try { return SMART.test(new URL(u).hostname); } catch { return false; } }) || '';
  const spotify = all.find(u => /^https:\/\/open\.spotify\.com\/(intl-[a-z-]+\/)?(track|album)\//i.test(u)) || '';
  return { stream, spotify };
}

/* ---------- Covers ---------- */
function pickColor(d, s) {   // same as the admin panel: most present vivid hue, brightened to read on black
  const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const light = { w: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, sat = mx ? (mx - mn) / mx : 0;
    if (v > .55) { const w = v * v; light.w += w; light.r += r * w; light.g += g * w; light.b += b * w; }
    if (v < .18 || sat < .25) continue;
    let hue = 0;
    if (mx !== mn) hue = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    const bin = bins[Math.floor(hue * 4) % 24], w = sat * sat * v;
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
  }
  const top = bins.map((b, i) => ({ i, w: b.w + bins[(i + 23) % 24].w * .5 + bins[(i + 1) % 24].w * .5 })).sort((a, b) => b.w - a.w)[0];
  const pick = top.w > s * s * .015 ? bins[top.i] : light.w ? light : { w: 1, r: 1, g: 1, b: 1 };
  let [r, g, b] = [pick.r / pick.w, pick.g / pick.w, pick.b / pick.w];
  const mx = Math.max(r, g, b);
  if (mx > 0 && mx < .82) { const k = .82 / mx; r *= k; g *= k; b *= k; }
  return '#' + [r, g, b].map(v => Math.round(Math.min(1, v) * 255).toString(16).padStart(2, '0')).join('');
}
async function saveCover(url, base) {
  let buf = null;
  for (const u of [url, url.replace(/-t\d+x\d+\./, '-t500x500.')]) {
    const r = await fetch(u).catch(() => null);
    if (r?.ok && /^image\//.test(r.headers.get('content-type') || '')) { buf = Buffer.from(await r.arrayBuffer()); break; }
  }
  if (!buf) throw new Error(`Cover not available: ${url}`);
  const img = await sharp(buf).resize(COVER_PX, COVER_PX, { fit: 'cover', withoutEnlargement: true }).flatten({ background: '#000' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  const px = await sharp(img).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  let name = `${base}.jpg`;
  if (fs.existsSync(path.join(ROOT, 'assets', name))) name = `${base}-${Date.now().toString(36)}.jpg`;
  if (!DRY) fs.writeFileSync(path.join(ROOT, 'assets', name), img);
  return { image: name, color: pickColor(px, 48) };
}

/* ---------- Preview clip from the drop ---------- */
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Audio not available (${r.status})`);
  const file = path.join(os.tmpdir(), `hz-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
/* Loudness every half second; the drop = the clip-long window with the most energy, favouring a
   sudden rise right at its start. Ignores the first and last bits (intro / outro). */
function findDrop(file, clip) {
  const RATE = 4000, STEP = RATE / 2;
  const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(pcm.length / 2 / STEP), e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < STEP; k += 4) { const v = pcm.readInt16LE((i * STEP + k) * 2) / 32768; sum += v * v; }
    e[i] = Math.sqrt(sum / (STEP / 4));
  }
  const w = clip * 2, total = n / 2;
  if (n <= w + 4) return 0;
  const from = Math.floor(n * 0.12), to = Math.max(from + 1, Math.min(n - w, Math.floor(n * 0.85)));
  const pre = 8;   // 4 s before the start
  let best = from, bestScore = -1, sum = 0;
  for (let i = from; i < from + w; i++) sum += e[i];
  for (let s = from; s < to; s++) {
    if (s > from) sum += e[s + w - 1] - e[s - 1];
    let before = 0, after = 0;
    for (let k = 1; k <= pre; k++) before += e[Math.max(0, s - k)];
    for (let k = 0; k < pre; k++) after += e[s + k];
    const score = sum / w + 0.6 * Math.max(0, (after - before) / pre);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return Math.min(best / 2, Math.max(0, total - clip));
}
function cutClip(file, start, clip, out) {
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', start.toFixed(2), '-t', String(clip), '-i', file,
    '-af', `afade=t=in:st=0:d=0.5,afade=t=out:st=${clip - 2.5}:d=2.5`, '-ac', '2', '-ar', '44100', '-b:a', '160k', out]);
}
async function previewFrom(url, clip, outName) {
  const file = await download(url);
  try {
    const start = findDrop(file, clip);
    if (!DRY) cutClip(file, start, clip, path.join(ROOT, 'assets', outName));
    log(`  preview ${outName}: from ${Math.floor(start / 60)}:${String(Math.round(start % 60)).padStart(2, '0')}`);
    return outName;
  } finally { fs.rmSync(file, { force: true }); }
}

/* ---------- Main ---------- */
const feed = await readFeed();
const releases = readJson('releases.json', null);
const mixtapes = readJson('mixtapes.json', []);
const ignored = readJson('sync-ignore.json', []);
const isIgnored = item => Array.isArray(ignored) && ignored.some(x =>
  (x.soundcloud_link && scKey(x.soundcloud_link) === scKey(item.link)) || (x.title && norm(x.title) === norm(item.title)));
if (!Array.isArray(releases) || !releases.length) throw new Error('releases.json is missing or empty.');

const relKnown = item => isIgnored(item) || releases.some(r =>
  (r.soundcloud_link && scKey(r.soundcloud_link) === scKey(item.link)) ||
  norm(`${r.artist}${r.title}`) === norm(`${item.c.artist}${item.c.title}`) ||
  norm(r.title) === norm(item.c.title) && norm(r.artist).includes(norm(item.c.artist).slice(0, 6)));
const mixKnown = item => isIgnored(item) || mixtapes.some(m =>
  (m.soundcloud_link && scKey(m.soundcloud_link) === scKey(item.link)) || (m.number && norm(m.number) === norm(item.c.number)));

/* SYNC_AUDIT=1: list every upload since the cut-off and what the sync makes of it (changes nothing). */
if (process.env.SYNC_AUDIT === '1') {
  for (const it of feed) {
    const c = classify(it), x = { ...it, c };
    const state = !c ? 'ignored' : isIgnored(x) ? 'deleted in panel' : (c.kind === 'release' ? relKnown(x) : mixKnown(x)) ? 'on the site' : 'NEW';
    console.log(`${it.date.toISOString().slice(0, 10)}  ${(c?.kind || '-').padEnd(7)}  ${state.padEnd(16)}  ${it.title}`);
  }
  process.exit(0);
}

/* New = everything newer than the first one already on the site (per type). If none of them is on the
   site, nothing is added: that would mean the feed or the names changed, and a person should look. */
function newOnes(kind, known) {
  const list = feed.map(it => ({ ...it, c: classify(it) })).filter(it => it.c?.kind === kind);
  const out = [];
  for (const it of list) {
    if (known(it)) return out.slice(0, MAX_NEW);
    out.push(it);
  }
  log(`${kind}: nothing in the feed matches the site, skipping for safety.`);
  return [];
}

const addedRel = [], addedMix = [];
const newRel = newOnes('release', relKnown);
if (newRel.length) {
  let n = Math.max(0, ...releases.map(r => Number(String(r.catalog || r.catalog_number || '').replace(/\D/g, '')) || 0));
  const prefix = (String(releases[0].catalog || 'HRZ#').match(/^\D*/) || ['HRZ#'])[0] || 'HRZ#';
  for (const it of [...newRel].reverse()) {   // oldest first, so the newest gets the highest number
    n += 1;
    const num = String(n).padStart(3, '0'), id = `${prefix.replace(/\W/g, '').toLowerCase()}${num}`;
    const { image, color } = await saveCover(it.image, id);
    const { stream, spotify } = links(it.text);
    const entry = { id, catalog: `${prefix}${num}`, artist: it.c.artist, title: it.c.title, image, color };
    if (stream) entry.stream_link = stream;
    if (spotify) entry.spotify_link = spotify;
    entry.soundcloud_link = it.link;
    releases.unshift(entry);
    addedRel.unshift(entry);
    log(`release ${entry.catalog} — ${entry.artist} - ${entry.title}`);
  }
  try { await previewFrom(newRel[0].audio, RELEASE_CLIP, 'release_preview.mp3'); }
  catch (e) { log('  preview skipped:', e.message); }
}

const newMix = newOnes('mixtape', mixKnown);
for (const it of [...newMix].reverse()) {
  const id = `mix${it.c.number.replace(/\D/g, '')}`;
  const { image, color } = await saveCover(it.image, id);
  const entry = { id, number: it.c.number, title: it.c.title, artist: it.c.artist, image, color, soundcloud_link: it.link };
  if (!entry.artist) delete entry.artist;
  if (it === newMix[0]) {   // only the latest one plays on the home page
    try { entry.preview = await previewFrom(it.audio, MIX_CLIP, `${id}.mp3`); }
    catch (e) { log('  preview skipped:', e.message); }
  }
  // keep the order of keys the panel uses
  const ordered = { id: entry.id, number: entry.number, title: entry.title, ...(entry.artist && { artist: entry.artist }), image: entry.image, color: entry.color, ...(entry.preview && { preview: entry.preview }), soundcloud_link: entry.soundcloud_link };
  mixtapes.unshift(ordered);
  addedMix.unshift(ordered);
  log(`mixtape ${entry.number}${entry.artist ? ' — ' + entry.artist : ''}`);
}

/* Spotify link added to the description later: fill it in where the site has none (never replaces). */
const filled = [];
for (const it of feed) {
  const c = classify(it);
  if (c?.kind !== 'release') continue;
  const i = releases.findIndex(r => (r.soundcloud_link && scKey(r.soundcloud_link) === scKey(it.link)) || norm(`${r.artist}${r.title}`) === norm(`${c.artist}${c.title}`));
  if (i < 0 || releases[i].spotify_link) continue;
  const { spotify } = links(it.text);
  if (!spotify) continue;
  const r = releases[i], out = {};
  for (const [k, v] of Object.entries(r)) { out[k] = v; if (k === 'stream_link') out.spotify_link = spotify; }
  if (!out.spotify_link) { delete out.soundcloud_link; out.spotify_link = spotify; if (r.soundcloud_link) out.soundcloud_link = r.soundcloud_link; }
  releases[i] = out;
  filled.push(out);
  log(`spotify link for ${out.catalog || out.title}`);
}

const changed = addedRel.length + addedMix.length + filled.length > 0;
if (changed && !DRY) {
  if (addedRel.length || filled.length) fs.writeFileSync(path.join(ROOT, 'releases.json'), JSON.stringify(releases, null, 2) + '\n');
  if (addedMix.length) fs.writeFileSync(path.join(ROOT, 'mixtapes.json'), JSON.stringify(mixtapes, null, 2) + '\n');
}
const lines = [
  ...addedRel.map(r => `Add release ${r.catalog} — ${r.title}`),
  ...addedMix.map(m => `Add mixtape ${m.number}${m.artist ? ' — ' + m.artist : ''}`),
  ...filled.filter(r => !addedRel.includes(r)).map(r => `Add Spotify link to ${r.catalog} — ${r.title}`),
];
const message = lines.length === 1 ? lines[0] : `Sync from SoundCloud\n\n${lines.join('\n')}`;
if (process.env.SYNC_MESSAGE_FILE) fs.writeFileSync(process.env.SYNC_MESSAGE_FILE, message + '\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
log(changed ? `done: ${lines.length} new` : 'up to date');
