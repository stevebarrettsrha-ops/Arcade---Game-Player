#!/usr/bin/env node
/*
 * ARCADE — auto-fix host-emulator paths (STREAMING mode).
 *
 * The manifests in emulators/<name>/emulator.json ship with the *default*
 * install paths (e.g. "C:\Program Files (x86)\Project64 3.0\Project64.exe").
 * If you installed an emulator somewhere else — or dropped a portable build
 * straight into its emulators/<name>/ folder — those paths don't match and
 * the host-emulator button "does nothing" (the launch silently fails).
 *
 * This script scans the emulators/ folder, finds where each emulator REALLY
 * lives on this machine, and rewrites the "cmd" path to match. It also checks
 * each emulator's games ("roms") folder, creates it if missing, and tells you
 * how many games it can see.
 *
 *   node fix-emulator-paths.js              (rewrite manifests in place)
 *   node fix-emulator-paths.js --dry-run    (just report; change nothing)
 *
 * Re-run it any time you install/move an emulator. Zero dependencies.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT    = __dirname;
const EMU_DIR = path.join(ROOT, 'emulators');
const DRY     = process.argv.includes('--dry-run') || process.argv.includes('-n');

const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m', off: '\x1b[0m' };
const paint = process.stdout.isTTY;
const col = (c, s) => paint ? c + s + C.off : s;

/* ---- quote-aware tokenizer (same rules the streamer uses to launch) ----
   "cmd": "\"C:\\Program Files\\PCSX2\\pcsx2-qt.exe\" -fullscreen {rom}"   */
function tokenize(cmd) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of String(cmd)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
// re-quote a single token only if it contains whitespace
const quote = t => /\s/.test(t) ? '"' + t + '"' : t;
const rel   = p => path.relative(ROOT, p).split(path.sep).join('/');

/* ---- which token in a cmd is the launchable file we need to locate? ----
   - "java -jar foo.jar {rom}"        -> the .jar token
   - "\"...\\Project64.exe\" {rom}"   -> the .exe token
   - "flatpak run net.pcsx2.PCSX2"    -> none (runs via a launcher on PATH)
   Bare commands with no path/extension (java, flatpak, retroarch, xemu on
   PATH) are left alone — there's nothing to repoint. */
const LAUNCHER_RE = /\.(exe|jar|app|bat|cmd|com|sh|appimage)$/i;
function targetIndex(tokens) {
  // a real file token carries an extension we know, or a path separator
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.includes('{rom}')) continue;
    if (LAUNCHER_RE.test(t)) return i;
  }
  // fall back to the first token if it looks like a path (has a separator)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.includes('{rom}')) continue;
    if (t.includes('/') || t.includes('\\')) return i;
  }
  return -1;
}

/* ---- where to look, per emulator, beyond its own folder ----
   Keyed by the folder name in emulators/. These are the common install
   roots for the pre-wired Windows emulators; unknown emulators just get
   the generic search (their own folder + the standard program roots). */
const HINTS = {
  project64: ['C:\\Program Files (x86)\\Project64 3.0', 'C:\\Program Files\\Project64 3.0',
              'C:\\Program Files (x86)\\Project64', 'C:\\Program Files\\Project64'],
  pcsx2:     ['C:\\Program Files\\PCSX2', 'C:\\Program Files (x86)\\PCSX2'],
  ppsspp:    ['C:\\Program Files\\PPSSPP', 'C:\\Program Files (x86)\\PPSSPP'],
  dolphin:   ['C:\\Program Files\\Dolphin', 'C:\\Program Files\\Dolphin-x64'],
  rpcs3:     ['C:\\Program Files\\RPCS3'],
  retroarch: ['C:\\RetroArch-Win64', 'C:\\Program Files\\RetroArch',
              'C:\\Program Files\\RetroArch-Win64'],
};
function programRoots() {
  const env = process.env;
  return [
    env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramW6432'],
    env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'Programs'),
    env['HOME'] && path.join(env['HOME'], 'Applications'),   // macOS user apps
    '/Applications', '/usr/bin', '/usr/local/bin', '/opt',
  ].filter(Boolean);
}

/* ---- bounded recursive search for a filename (case-insensitive) ----
   Walks at most `budget` directories and `maxDepth` levels so a sweep of
   C:\Program Files can't run away. Returns the first matching full path. */
function findFile(roots, basename, maxDepth, budget) {
  const want = basename.toLowerCase();
  const queue = roots.map(r => ({ dir: r, depth: 0 }));
  let visited = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (visited++ > budget) break;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    const subs = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      let isDir = false, isFile = false;
      try { isDir = e.isDirectory(); isFile = e.isFile(); }
      catch (x) { try { const st = fs.statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch (y) {} }
      if (isFile && e.name.toLowerCase() === want) return full;
      if (isDir && depth < maxDepth) subs.push(full);
    }
    for (const s of subs) queue.push({ dir: s, depth: depth + 1 });
  }
  return null;
}

/* ---- locate a launchable for one emulator folder ---- */
function locate(id, basename) {
  const own = path.join(EMU_DIR, id);
  // 1) inside the emulator's own folder (portable build dropped in here)
  let hit = findFile([own], basename, 6, 5000);
  if (hit) return hit;
  // 2) per-emulator known install dirs
  const hints = (HINTS[id] || []).filter(d => { try { return fs.existsSync(d); } catch (e) { return false; } });
  hit = findFile(hints, basename, 4, 4000);
  if (hit) return hit;
  // 3) the standard program roots (depth-limited so it stays quick)
  const roots = programRoots().filter(d => { try { return fs.existsSync(d); } catch (e) { return false; } });
  hit = findFile(roots, basename, 3, 8000);
  return hit;
}

/* ---- rewrite the file token in a cmd, keeping its args + quoting ---- */
function rebuild(tokens, idx, newPath) {
  const copy = tokens.slice();
  // prefer a repo-relative path when the file lives inside ARCADE (portable),
  // otherwise keep the absolute path the OS needs.
  let p = newPath;
  const inside = path.normalize(newPath).startsWith(path.normalize(ROOT) + path.sep);
  if (inside) p = rel(newPath);
  else p = newPath;
  copy[idx] = p;
  return copy.map(t => t.includes('{rom}') ? t : quote(t)).join(' ');
}

/* ---- count games in a manifest's roms folder ---- */
function countGames(roms, exts) {
  const cand = path.normalize(path.join(ROOT, String(roms)));
  if (!cand.startsWith(path.normalize(ROOT) + path.sep)) return { dir: null, n: 0, made: false };
  let made = false;
  if (!fs.existsSync(cand)) {
    if (!DRY) { try { fs.mkdirSync(cand, { recursive: true }); made = true; } catch (e) {} }
    else made = true;
  }
  let n = 0;
  try {
    const list = Array.isArray(exts) ? exts.map(x => String(x).toLowerCase()) : [];
    n = fs.readdirSync(cand).filter(f => {
      if (f.startsWith('.') || f.startsWith('_')) return false;
      try { if (!fs.statSync(path.join(cand, f)).isFile()) return false; } catch (e) { return false; }
      return !list.length || list.includes(path.extname(f).toLowerCase());
    }).length;
  } catch (e) {}
  return { dir: cand, n, made };
}

/* ---- main ---- */
function main() {
  console.log(col(C.dim, 'ARCADE — scanning emulators/ for host-emulator paths' + (DRY ? '  (dry run)' : '')));
  console.log(col(C.dim, 'root: ' + ROOT));
  console.log('');

  let names = [];
  try { names = fs.readdirSync(EMU_DIR); }
  catch (e) { console.error(col(C.err, 'No emulators/ folder here — run this from the ARCADE folder.')); process.exit(1); }

  let changed = 0, ready = 0, missing = 0, scanned = 0;

  for (const id of names.sort()) {
    if (id.startsWith('.') || id.startsWith('_')) continue;        // _examples etc. are ignored
    const mf = path.join(EMU_DIR, id, 'emulator.json');
    let raw; try { raw = fs.readFileSync(mf, 'utf8'); } catch (e) { continue; }
    let m; try { m = JSON.parse(raw); } catch (e) {
      console.log(col(C.err, '✗ ' + id) + col(C.dim, '  emulator.json is not valid JSON — skipped'));
      continue;
    }
    if (!m.cmd) continue;
    scanned++;
    const label = m.name || id;

    const tokens = tokenize(m.cmd);
    const idx = targetIndex(tokens);

    // ---- launchable path ----
    if (idx === -1) {
      // bare command on PATH (java/flatpak/retroarch on its own) — nothing to fix
      console.log(col(C.ok, '• ' + label) + col(C.dim, '  runs via a command on PATH — left as-is'));
    } else {
      const cur = tokens[idx];
      const basename = path.basename(cur.replace(/\\/g, '/'));
      const curAbs = path.isAbsolute(cur) ? cur : path.join(ROOT, cur);
      let found = fs.existsSync(curAbs) ? curAbs : null;
      if (!found) found = locate(id, basename);

      if (!found) {
        missing++;
        console.log(col(C.warn, '⚠ ' + label));
        console.log(col(C.dim, '    could not find ' + basename + ' — install it, or drop a portable build in emulators/' + id + '/'));
      } else {
        const newCmd = rebuild(tokens, idx, found);
        if (newCmd !== m.cmd) {
          changed++;
          console.log(col(C.ok, '✓ ' + label) + col(C.dim, '  found ' + rel(found)));
          console.log(col(C.dim, '    cmd  ' + m.cmd));
          console.log(col(C.ok,  '    ->   ' + newCmd));
          m.cmd = newCmd;
        } else {
          ready++;
          console.log(col(C.ok, '✓ ' + label) + col(C.dim, '  path already correct'));
        }
      }
    }

    // ---- games folder ----
    if (m.roms) {
      const g = countGames(m.roms, m.exts);
      if (g.dir) {
        const note = g.made ? '(created — empty)' : (g.n ? g.n + ' game' + (g.n === 1 ? '' : 's') : 'empty — add games here');
        console.log(col(C.dim, '    games  ' + String(m.roms) + '   ' + note));
      }
    }

    // ---- write back if cmd changed ----
    if (!DRY) {
      try { fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n'); }
      catch (e) { console.log(col(C.err, '    could not write ' + rel(mf) + ': ' + e.message)); }
    }
    console.log('');
  }

  const verb = DRY ? 'would update' : 'updated';
  console.log(col(C.dim, '─'.repeat(48)));
  console.log('scanned ' + scanned + ' emulator' + (scanned === 1 ? '' : 's') + '  ·  ' +
    col(C.ok, verb + ' ' + changed) + '  ·  ' +
    col(C.ok, ready + ' already ok') + '  ·  ' +
    (missing ? col(C.warn, missing + ' not found') : '0 not found'));
  if (DRY && changed) console.log(col(C.dim, 'run again without --dry-run to apply.'));
  if (!scanned) console.log(col(C.warn, 'No emulator.json manifests found under emulators/.'));
  console.log(col(C.dim, 'Then start ARCADE with the streaming launcher (start-windows-stream.bat) and pick "🖥️ Host emulators".'));
}

main();
