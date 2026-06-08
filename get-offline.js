#!/usr/bin/env node
/*
 * ARCADE — one-time offline setup.
 *
 * Run this ONCE while you have internet. It downloads the EmulatorJS engine
 * and the emulator cores into the local "emulatorjs/" folder. After it
 * finishes, ARCADE plays fully offline — no internet needed, ever.
 *
 *   node get-offline.js            download engine + cores for systems
 *                                  that currently have games in games/*
 *   node get-offline.js --all      download cores for ALL systems
 *   node get-offline.js --engine   download only the engine (cores get
 *                                  cached automatically the first time you
 *                                  play each system online)
 *
 * Cores are large (roughly 10-50 MB each), so this can take a while and use
 * a few hundred MB if you grab everything. It only downloads what's missing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CDN  = (process.env.ARCADE_CDN || 'https://cdn.emulatorjs.org/stable/data/').replace(/\/?$/, '/');
const ROOT = __dirname;
const OUT  = path.join(ROOT, 'emulatorjs');
const args = process.argv.slice(2);
const ALL    = args.includes('--all');
const ENGINE = args.includes('--engine');

// engine files (small, required)
const ENGINE_FILES = ['loader.js', 'emulator.min.js', 'emulator.min.css', 'version.json'];
const LOCALES = ['en-US.json'];   // optional, best-effort

// system -> candidate core basenames (we grab every candidate that exists so
// it works no matter which default the browser ends up choosing)
const CORES = {
  gba:     ['mgba'],
  nes:     ['fceumm', 'nestopia'],
  snes:    ['snes9x'],
  genesis: ['genesis_plus_gx'],
  gb:      ['gambatte'],
  n64:     ['mupen64plus_next', 'parallel_n64'],
  psx:     ['pcsx_rearmed', 'mednafen_psx_hw'],
  psp:     ['ppsspp'],     // experimental; threaded build
};

const http  = require('http');
function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { timeout: 60000 }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, data: null }); }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: 200, data: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function human(n){ return n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }

async function fetchTo(relUrl, relPath, { optional = false } = {}) {
  const dest = path.join(OUT, relPath);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('  have   ' + relPath); return true; }
  process.stdout.write('  get    ' + relPath + ' ... ');
  let r;
  try { r = await get(CDN + relUrl); }
  catch (e) { console.log('network error (' + e.message + ')'); return false; }
  if (r.status !== 200 || !r.data) { console.log(optional ? 'skip (' + r.status + ')' : 'FAILED (' + r.status + ')'); return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.data);
  console.log('ok (' + human(r.data.length) + ')');
  return true;
}

function systemsWithGames() {
  const out = [];
  for (const sys of Object.keys(CORES)) {
    const dir = path.join(ROOT, 'games', sys);
    try {
      const has = fs.readdirSync(dir).some(n => !n.startsWith('.') && !n.startsWith('_') && fs.statSync(path.join(dir, n)).isFile());
      if (has) out.push(sys);
    } catch (e) {}
  }
  return out;
}

(async () => {
  console.log('\nARCADE offline setup');
  console.log('Source: ' + CDN);
  console.log('Target: ' + OUT + '\n');
  fs.mkdirSync(OUT, { recursive: true });

  console.log('Engine files:');
  let engineOk = true;
  for (const f of ENGINE_FILES) engineOk = (await fetchTo(f, f, { optional: f === 'version.json' })) && engineOk;
  for (const l of LOCALES) await fetchTo('localization/' + l, path.join('localization', l), { optional: true });

  if (!engineOk) {
    console.log('\n! Could not download the engine. Check your internet connection and that');
    console.log('  ' + CDN + 'loader.js is reachable, then run this again.\n');
    process.exit(1);
  }

  if (ENGINE) {
    console.log('\nEngine ready. Cores will be cached automatically the first time you play');
    console.log('each system while online. Re-run without --engine to pre-download them.\n');
    return;
  }

  const targets = ALL ? Object.keys(CORES) : systemsWithGames();
  if (!targets.length) {
    console.log('\nNo games found in games/* yet, so no cores were downloaded.');
    console.log('Add some games and run this again, or use --all to grab every core now.\n');
  } else {
    console.log('\nCores for: ' + targets.join(', ') + (ALL ? '  (--all)' : '  (systems with games)'));
    for (const sys of targets) {
      console.log('[' + sys + ']');
      for (const core of CORES[sys]) {
        // 1) the report JSON tells EmulatorJS which build to use (WebGL2 vs
        //    legacy) and enables caching. WITHOUT it, EmulatorJS assumes no
        //    WebGL2 and asks for a "-legacy" core, causing "Network Error".
        await fetchTo('cores/reports/' + core + '.json', path.join('cores', 'reports', core + '.json'), { optional: true });
        // 2) grab every core build variant that exists so it works on any
        //    browser/mode: normal, no-WebGL2 (legacy), and threaded (PSP etc.)
        const variants = ['-wasm', '-legacy-wasm', '-thread-wasm', '-thread-legacy-wasm'];
        let got = 0;
        for (const v of variants) {
          if (await fetchTo('cores/' + core + v + '.data', path.join('cores', core + v + '.data'), { optional: true })) got++;
        }
        if (!got) console.log('   ! could not download any build of core "' + core + '" - check your connection and re-run');
      }
    }
  }

  console.log('\nDone. ARCADE will now use the local engine + cores (no internet needed).');
  console.log('Start the server and play. The page shows "OFFLINE" when running locally.\n');
})().catch(e => { console.error('\nUnexpected error:', e.message, '\n'); process.exit(1); });
