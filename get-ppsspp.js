#!/usr/bin/env node
/*
 * ARCADE — fetch a fully-offline copy of PPSSPP (the good PSP engine).
 *
 * Run ONCE while online. It mirrors the built PPSSPP-Web app into the
 * psp-ppsspp/ folder, so ARCADE serves it locally with no internet.
 * The built app uses a relative base href, so the copy works as-is.
 *
 *   node get-ppsspp.js
 *
 * Source: https://github.com/root-hunter/ppsspp-web  (PPSSPP by Henrik
 * Rydgard, GPL-2.0+). Games/BIOS are NOT downloaded (PSP needs no BIOS).
 * The download is sizeable (the emulator's WebAssembly is tens of MB).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE   = 'https://root-hunter.github.io/ppsspp-web/';
const ORIGIN = new URL(BASE).origin;            // https://root-hunter.github.io
const PREFIX = new URL(BASE).pathname;          // /ppsspp-web/
const OUT    = path.join(__dirname, 'psp-ppsspp');

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, data: null }); }
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: 200, data: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const human = n => n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB';

// turn a manifest key ("/ppsspp-web/build-wasm/x.wasm") into URL + local path
function resolveEntry(key) {
  const url = key.startsWith('/') ? ORIGIN + key : new URL(key, BASE).toString();
  let rel = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key.replace(/^\//, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  return { url, rel };
}

async function fetchTo(url, rel) {
  const dest = path.join(OUT, rel);
  process.stdout.write('  get  ' + rel + ' ... ');
  let r; try { r = await get(url); } catch (e) { console.log('network error (' + e.message + ')'); return false; }
  if (r.status !== 200 || !r.data) { console.log('skip (' + r.status + ')'); return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.data);
  console.log('ok (' + human(r.data.length) + ')');
  return true;
}

(async () => {
  console.log('\nARCADE — downloading PPSSPP for offline use');
  console.log('Source: ' + BASE);
  console.log('Target: ' + OUT + '\n');
  fs.mkdirSync(OUT, { recursive: true });

  console.log('Reading file list (ngsw.json)…');
  let man; try { man = await get(BASE + 'ngsw.json'); } catch (e) { man = { status: 0 }; }
  if (man.status !== 200 || !man.data) {
    console.log('\n! Could not read the app manifest (' + (man.status || 'no response') + ').');
    console.log('  The site may be unreachable, or its layout changed. Easiest alternative:');
    console.log('  open the PSP tab in ARCADE, click "Open PPSSPP", then use your browser\'s');
    console.log('  "Install app" option — that caches it for offline use too.\n');
    process.exit(1);
  }

  let keys = [];
  try {
    const j = JSON.parse(man.data.toString());
    if (j.hashTable && typeof j.hashTable === 'object') keys = Object.keys(j.hashTable);
    if (Array.isArray(j.assetGroups)) for (const g of j.assetGroups) if (Array.isArray(g.urls)) keys.push(...g.urls);
  } catch (e) {}
  keys = [...new Set(keys)];
  if (!keys.length) { console.log('\n! Manifest had no file list. Use the "Install app" route instead.\n'); process.exit(1); }

  console.log('Downloading ' + keys.length + ' files…\n');
  let ok = 0, fail = 0;
  for (const key of keys) { const { url, rel } = resolveEntry(key); (await fetchTo(url, rel)) ? ok++ : fail++; }

  // make sure index.html exists even if it wasn't in the manifest
  if (!fs.existsSync(path.join(OUT, 'index.html'))) await fetchTo(BASE + 'index.html', 'index.html');

  console.log('\nDone — ' + ok + ' files saved' + (fail ? (', ' + fail + ' skipped') : '') + '.');
  if (fs.existsSync(path.join(OUT, 'index.html'))) {
    console.log('ARCADE will now show "Open PPSSPP (offline copy)" and serve it locally.');
    console.log('For full speed, start ARCADE in PSP mode (start-*-psp).\n');
  } else {
    console.log('index.html is missing, so the local copy may not work — try the "Install app" route.\n');
  }
})().catch(e => { console.error('\nUnexpected error:', e.message, '\n'); process.exit(1); });
