#!/usr/bin/env node
/*
 * ARCADE — set up the host emulators for STREAMING mode (Windows).
 *
 * Run ONCE (or any time): ready-made folders + manifests already sit in
 * emulators/ for Project64 (N64), PCSX2 (PS2), PPSSPP (PSP), xemu (XBOX),
 * FreeJ2ME and KEmulator nnmod (Java). This script finishes the job:
 *
 *   - PORTABLE emulators (xemu, KEmulator, FreeJ2ME): downloaded from their
 *     official GitHub releases into emulators/<name>/app/ and wired up.
 *     Already have the zip? Extract it into that app/ folder yourself and
 *     this script just verifies it.
 *   - INSTALLER emulators (PCSX2, PPSSPP, Project64): Windows installers
 *     can't be installed silently/legally-cleanly from a script, so run the
 *     installer you downloaded; the manifests already point at the default
 *     install paths and this script tells you which ones it found.
 *
 *   node get-emulators.js        (or double-click download-emulators-windows.bat)
 *
 * Zero dependencies: zips are unpacked with Node's own zlib.
 */
'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const EMU  = path.join(ROOT, 'emulators');
const q = p => /\s/.test(p) ? '"' + p + '"' : p;
const human = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

/* ---- what to set up ------------------------------------------------------ */
const CATALOG = [
  { id: 'pcsx2',     kind: 'installer', name: 'PCSX2 (PS2)',
    exe: 'C:\\Program Files\\PCSX2\\pcsx2-qt.exe',
    installer: 'PCSX2-v…-windows-x64-installer.exe', site: 'https://pcsx2.net' },
  { id: 'ppsspp',    kind: 'installer', name: 'PPSSPP (PSP)',
    exe: 'C:\\Program Files\\PPSSPP\\PPSSPPWindows64.exe',
    installer: 'PPSSPPSetup.exe', site: 'https://www.ppsspp.org' },
  { id: 'project64', kind: 'installer', name: 'Project64 (N64)',
    exe: 'C:\\Program Files (x86)\\Project64 3.0\\Project64.exe',
    installer: 'Setup Project64 3.0.1….exe', site: 'https://www.pj64-emu.com' },
  { id: 'xemu',      kind: 'github', name: 'xemu (Original XBOX)',
    repo: 'xemu-project/xemu',
    asset: /win.*\.zip$/i, prefer: /x86_64.*release/i, avoid: /debug|pdb|aarch64|arm/i,
    main: /^xemu\.exe$/i,
    cmd: p => q(p) + ' -full-screen -dvd_path {rom}',
    manualZip: 'xemu-…-windows-x86_64.zip' },
  { id: 'kemulator', kind: 'github', name: 'KEmulator nnmod (Java)',
    repo: 'shinovon/KEmulator',
    asset: /\.zip$/i, prefer: /x64/i, avoid: /source|linux|mac/i,
    main: /^kemulator.*\.exe$/i, mainAlt: /^kemulator.*\.jar$/i,
    cmd: p => /\.jar$/i.test(p) ? 'java -jar ' + q(p) + ' {rom}' : q(p) + ' {rom}',
    manualZip: 'kemnnmod….zip' },
  { id: 'freej2me',  kind: 'github', name: 'FreeJ2ME (Java)',
    repo: 'hex007/freej2me', repoAlt: 'TASEmulators/freej2me-plus',
    asset: /\.(jar|zip)$/i, prefer: /freej2me(?!.*(libretro|web))/i, avoid: /libretro|web|source/i,
    main: /^freej2me.*\.jar$/i,
    cmd: p => 'java -jar ' + q(p) + ' {rom}',
    manualZip: 'freej2me_….zip (copy the main jar in as app/freej2me.jar)' },
];

/* ---- tiny HTTPS client (follows redirects; GitHub needs a User-Agent) ---- */
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 180000, headers: { 'User-Agent': 'ARCADE-setup', 'Accept': '*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      const chunks = []; let got = 0;
      const total = parseInt(res.headers['content-length'] || '0', 10);
      const meter = total > 1048576 && process.stdout.isTTY;   // live progress only on a real terminal
      res.on('data', d => { chunks.push(d); got += d.length;
        if (meter) process.stdout.write('\r    downloading… ' + human(got) + ' / ' + human(total) + '   '); });
      res.on('end', () => { if (meter) process.stdout.write('\r'); resolve({ status: res.statusCode, data: Buffer.concat(chunks) }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ---- minimal zip extraction (stored + deflate), pure Node ---- */
function zipEntries(buf) {
  const EOCD = 0x06054b50, CEN = 0x02014b50;
  const min = Math.max(0, buf.length - 22 - 65536);
  let i = buf.length - 22;
  for (; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) break;
  if (i < min) return [];
  let off = buf.readUInt32LE(i + 16), count = buf.readUInt16LE(i + 10);
  const out = [];
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const comp = buf.slice(start, start + entry.compSize);
  try {
    if (entry.method === 0) return comp;
    if (entry.method === 8) return zlib.inflateRawSync(comp);
  } catch (e) {}
  return null;
}
function extractZip(buf, destDir) {
  const entries = zipEntries(buf).filter(e => e.name && !e.name.endsWith('/'));
  if (!entries.length) return 0;
  // if everything lives under one top-level folder, strip it (zip-of-a-folder)
  const roots = new Set(entries.map(e => e.name.split('/')[0]));
  const strip = (roots.size === 1 && entries.every(e => e.name.includes('/'))) ? ([...roots][0].length + 1) : 0;
  let written = 0;
  for (const e of entries) {
    const relName = e.name.slice(strip);
    if (!relName) continue;
    const dest = path.normalize(path.join(destDir, relName));
    if (!dest.startsWith(destDir + path.sep)) continue;       // zip-slip guard
    const data = zipRead(buf, e);
    if (data == null) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
  }
  return written;
}

/* ---- helpers ---- */
function findFile(dir, re) {
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { return null; }
  for (const n of names) {
    const full = path.join(dir, n);
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) { const r = findFile(full, re); if (r) return r; }
    else if (re.test(n)) return full;
  }
  return null;
}
function pickAsset(assets, def) {
  const ok = (assets || []).filter(a => def.asset.test(a.name) && !(def.avoid && def.avoid.test(a.name)));
  if (!ok.length) return null;
  return ok.find(a => def.prefer && def.prefer.test(a.name)) || ok[0];
}
// point the manifest's cmd at the binary we found, keeping every other field
function repairManifest(def, binAbs) {
  const mf = path.join(EMU, def.id, 'emulator.json');
  let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { m = null; }
  const cmd = def.cmd(rel(binAbs));
  if (m && m.cmd === cmd) return;
  if (!m) m = { name: def.name, capture: 'auto', needsRom: true };
  m.cmd = cmd;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
}

async function setupGithub(def) {
  const appDir = path.join(EMU, def.id, 'app');
  const existing = findFile(appDir, def.main) || (def.mainAlt && findFile(appDir, def.mainAlt));
  if (existing) { repairManifest(def, existing); return { ok: true, note: 'already set up (' + rel(existing) + ')' }; }

  for (const repo of [def.repo, def.repoAlt].filter(Boolean)) {
    let relInfo;
    try { relInfo = await get('https://api.github.com/repos/' + repo + '/releases/latest'); }
    catch (e) { continue; }
    let j; try { j = JSON.parse(relInfo.data.toString()); } catch (e) { j = null; }
    if (!j || relInfo.status !== 200) {
      const msg = (j && j.message) ? j.message.split('.')[0] : ('HTTP ' + relInfo.status);
      return { ok: false, note: 'GitHub said: ' + msg + ' — try again later, or set up manually (see _SETUP.txt)' };
    }
    const asset = pickAsset(j.assets, def);
    if (!asset) continue;                                     // try the alt repo
    console.log('    found ' + asset.name + ' (' + human(asset.size) + ', release ' + (j.tag_name || '?') + ')');
    let file;
    try { file = await get(asset.browser_download_url); } catch (e) { return { ok: false, note: 'download failed: ' + e.message }; }
    if (file.status !== 200 || !file.data || !file.data.length) return { ok: false, note: 'download failed (HTTP ' + file.status + ')' };
    fs.mkdirSync(appDir, { recursive: true });
    if (/\.jar$/i.test(asset.name)) fs.writeFileSync(path.join(appDir, 'freej2me.jar'), file.data);
    else {
      const n = extractZip(file.data, appDir);
      if (!n) return { ok: false, note: 'could not unpack ' + asset.name };
      console.log('    unpacked ' + n + ' files');
    }
    const bin = findFile(appDir, def.main) || (def.mainAlt && findFile(appDir, def.mainAlt));
    if (!bin) return { ok: false, note: 'unpacked, but no main program found — see _SETUP.txt' };
    repairManifest(def, bin);
    return { ok: true, note: 'downloaded -> ' + rel(bin) };
  }
  return { ok: false, note: 'no matching download found — set up manually (you may already have ' + def.manualZip + '; see _SETUP.txt)' };
}

function setupInstaller(def) {
  if (fs.existsSync(def.exe)) return { ok: true, note: 'found ' + def.exe };
  return { ok: false, note: 'not installed yet — run ' + def.installer + ' (from ' + def.site + ').\n      The manifest already points at the default install path; if you pick\n      a different folder, edit emulators/' + def.id + '/emulator.json.' };
}

module.exports = { _internals: { CATALOG, get, zipEntries, zipRead, extractZip, findFile, pickAsset, repairManifest, setupGithub, setupInstaller } };
if (require.main === module) (async () => {
  console.log('\nARCADE — host emulator setup (streaming mode)\n');
  if (process.platform !== 'win32')
    console.log('  NOTE: the bundled manifests use Windows paths. On Linux/macOS, copy a\n  folder from emulators/_examples/ instead and edit its cmd.\n');
  const hasJava = (() => { try { return spawnSync('java', ['-version']).status !== null; } catch (e) { return false; } })();

  let ready = 0, todo = 0;
  for (const def of CATALOG) {
    console.log('  ' + def.name);
    let r;
    try { r = def.kind === 'installer' ? setupInstaller(def) : await setupGithub(def); }
    catch (e) { r = { ok: false, note: e.message }; }
    console.log('    ' + (r.ok ? '✓ ' : '… ') + r.note);
    r.ok ? ready++ : todo++;
  }
  if (!hasJava) console.log('\n  NOTE: Java was not found on this computer. FreeJ2ME (and the "nojre"\n  KEmulator build) need it — install from https://adoptium.net');
  console.log('\n  ' + ready + ' ready, ' + todo + ' still need a step (details above).');
  console.log('  Games go in: games/n64, games/ps2, games/psp, games/xbox, games/j2me');
  console.log('  Then start:  start-windows-stream.bat\n');
})().catch(e => { console.error('\nUnexpected error:', e.message, '\n'); process.exit(1); });
