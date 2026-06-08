/* ARCADE - get-j2me.js
   Mirrors the FreeJ2ME-web handset (zb3/freej2me-web) into ./j2me-web/ so the
   Java phone can run EMBEDDED inside ARCADE (same origin), instead of opening
   the github.io copy in a separate tab (which browsers refuse to embed).

   What this downloads: the built web app (web/ + resources/ shaders). It does
   NOT download CheerpJ itself - that proprietary Java runtime is loaded from
   leaningtech's CDN at run time, so JAVA GAMES STILL NEED AN INTERNET
   CONNECTION even after mirroring. Every other system works fully offline.

   Run it with the download-j2me-* launcher for your OS, or:  node get-j2me.js
*/
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'j2me-web');
const REPO = process.env.ARCADE_J2ME_REPO || 'zb3/freej2me-web';
const REF = process.env.ARCADE_J2ME_REF || 'main';
const TREE_URL = 'https://api.github.com/repos/' + REPO + '/git/trees/' + REF + '?recursive=1';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/' + REF + '/';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'ARCADE-get-j2me', 'Accept': '*/*' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

function human(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

// Known runtime file set - used if the GitHub API can't be listed (e.g. rate
// limited). The tree API is preferred so new files are picked up automatically.
const FALLBACK_FILES = [
  'web/index.html', 'web/run.html', 'web/freej2me-web.jar', 'web/init.zip',
  'web/src/launcher.js', 'web/src/main.js', 'web/src/key.js', 'web/src/eventqueue.js', 'web/src/screenKbd.js',
  'web/libjs/libcanvasfont.js', 'web/libjs/libcanvasgraphics.js', 'web/libjs/libgles2.js',
  'web/libjs/libjsreference.js', 'web/libjs/libmediabridge.js', 'web/libjs/libmidibridge.js',
  'web/libmedia/libmedia.js', 'web/libmedia/transcode/transcode.js', 'web/libmedia/transcode/transcode.wasm', 'web/libmedia/transcode/worker.js',
  'web/libmidi/libmidi.js', 'web/libmidi/libmidi.wasm', 'web/libmidi/worklet.js',
  'resources/m3d_shaders/color.fsh', 'resources/m3d_shaders/color.vsh', 'resources/m3d_shaders/simple.fsh', 'resources/m3d_shaders/simple.vsh',
  'resources/m3d_shaders/sprite.fsh', 'resources/m3d_shaders/sprite.vsh', 'resources/m3d_shaders/tex.fsh', 'resources/m3d_shaders/tex.vsh',
  'resources/m3g_shaders/background_fragment.glsl', 'resources/m3g_shaders/background_vertex.glsl',
  'resources/m3g_shaders/mesh_fragment.glsl', 'resources/m3g_shaders/mesh_vertex.glsl',
  'resources/m3g_shaders/sprite_fragment.glsl', 'resources/m3g_shaders/sprite_vertex.glsl',
];

// runtime files only: the web app + shader resources. skip Java sources, the
// docker builder, test fixtures, wasm build trees, and stray vcs files.
function isRuntimeFile(p) {
  if (!(p.startsWith('web/') || p.startsWith('resources/'))) return false;
  if (p.indexOf('/test/') !== -1) return false;       // libmedia/test, libmidi/test
  if (p.indexOf('/wasm/') !== -1) return false;        // wasm build sources
  if (p.endsWith('.gitignore') || p.endsWith('.wat')) return false;
  return true;
}

async function fetchTo(relPath) {
  const dest = path.join(OUT, relPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('  have   ' + relPath); return true; }
  process.stdout.write('  get    ' + relPath + ' ... ');
  let r;
  try { r = await get(RAW + relPath.split('/').map(encodeURIComponent).join('/')); }
  catch (e) { console.log('network error (' + e.message + ')'); return false; }
  if (r.status !== 200 || !r.data || !r.data.length) { console.log('FAILED (' + r.status + ')'); return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.data);
  console.log('ok (' + human(r.data.length) + ')');
  return true;
}

(async () => {
  console.log('ARCADE - mirroring the FreeJ2ME-web Java handset into ./j2me-web/');
  console.log('(needs internet now AND when playing Java games - CheerpJ is loaded from its CDN)\n');

  console.log('Listing files from ' + REPO + '@' + REF + ' ...');
  let files = null;
  try {
    const r = await get(TREE_URL);
    if (r.status !== 200) throw new Error('GitHub API returned ' + r.status + (r.status === 403 ? ' (rate limited)' : ''));
    const tree = JSON.parse(r.data.toString('utf8')).tree || [];
    files = tree.filter(t => t.type === 'blob' && isRuntimeFile(t.path)).map(t => t.path);
    if (!files.length) throw new Error('no runtime files in tree');
  } catch (e) {
    console.log('  (file listing unavailable: ' + e.message + ' - using built-in list)');
    files = FALLBACK_FILES.slice();
  }

  // make sure the entry point is in the set
  if (files.indexOf('web/index.html') === -1) files.push('web/index.html');
  console.log('Mirroring ' + files.length + ' files.\n');

  let ok = 0, fail = 0;
  for (const f of files) { (await fetchTo(f)) ? ok++ : fail++; }

  const entry = path.join(OUT, 'web', 'index.html');
  console.log('\nDone: ' + ok + ' files ready' + (fail ? ', ' + fail + ' failed' : '') + '.');
  if (fs.existsSync(entry)) {
    console.log('Java handset is now self-hosted. Restart ARCADE - Java games will run embedded in the app.');
  } else {
    console.log('The handset entry point is missing - re-run this once you have a connection.');
    process.exit(1);
  }
})();
