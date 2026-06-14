#!/usr/bin/env node
/*
 * ARCADE — fetch ViGEmClient.dll (the user-mode library that lets host-
 * streaming mode present a virtual Xbox controller to native emulators).
 *
 * Run ONCE while online, on the Windows host. It saves ViGEmClient.dll next
 * to server.js, so start-windows-stream.bat auto-enables the virtual gamepad
 * (true analog stick + every button, with NO per-emulator key mapping).
 *
 *   node get-vigem.js
 *
 * You ALSO need the ViGEmBus DRIVER installed separately (a normal Windows
 * driver installer) — see SETUP-STREAMING.txt section 4a.
 *
 * Source: nefarius's official build server (buildbot.nefarius.at), the
 * upstream author of ViGEm. Nothing else is bundled or downloaded.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const LISTING = 'https://buildbot.nefarius.at/builds/ViGEmClient/master/';
const FALLBACK_VERSION = '1.16.106.0';            // used if the listing can't be read
const OUT = path.join(__dirname, 'ViGEmClient.dll');
const UA  = 'Mozilla/5.0 (ARCADE get-vigem)';

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': UA, 'Accept': '*/*' } }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const human  = n => n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB';
const dllUrl = v => LISTING + v + '/bin/release/x64/ViGEmClient.dll';

// pull "1.16.106.0"-style version folders out of the directory listing, newest first
function parseVersions(html) {
  const set = new Set(); const re = /(\d+\.\d+\.\d+\.\d+)/g; let m;
  while ((m = re.exec(html))) set.add(m[1]);
  const cmp = (a, b) => { const A=a.split('.').map(Number), B=b.split('.').map(Number);
    for (let i=0;i<4;i++){ if((A[i]||0)!==(B[i]||0)) return (B[i]||0)-(A[i]||0); } return 0; };
  return [...set].sort(cmp);
}

(async () => {
  console.log('\nARCADE — downloading ViGEmClient.dll (virtual Xbox controller)');
  console.log('Source: ' + LISTING);
  console.log('Target: ' + OUT + '\n');

  // try the newest build the listing advertises, then fall back to a pinned one
  let versions = [];
  try { const r = await get(LISTING); if (r.status === 200 && r.data) versions = parseVersions(r.data.toString()); } catch (e) {}
  if (!versions.includes(FALLBACK_VERSION)) versions.push(FALLBACK_VERSION);

  let saved = false;
  for (const v of versions) {
    process.stdout.write('  try  v' + v + ' ... ');
    let r; try { r = await get(dllUrl(v)); } catch (e) { console.log('network error (' + e.message + ')'); continue; }
    if (r.status !== 200 || !r.data || !r.data.length) { console.log('skip (' + r.status + ')'); continue; }
    // a real DLL is a PE file -> starts with "MZ"; this rejects HTML error pages
    if (r.data.length < 10000 || r.data[0] !== 0x4D || r.data[1] !== 0x5A) { console.log('skip (not a DLL)'); continue; }
    fs.writeFileSync(OUT, r.data);
    console.log('ok (' + human(r.data.length) + ')');
    saved = true; break;
  }

  if (saved) {
    console.log('\nDone — ViGEmClient.dll saved next to server.js.');
    console.log('Make sure the ViGEmBus DRIVER is installed too (SETUP-STREAMING.txt 4a),');
    console.log('then run start-windows-stream.bat — it should say "Virtual Xbox controller: ON".\n');
  } else {
    console.log('\n! Could not download ViGEmClient.dll automatically.');
    console.log('  Get it by hand from the official build server:');
    console.log('    ' + LISTING);
    console.log('  open the newest version > bin/release/x64/ > ViGEmClient.dll,');
    console.log('  and save it next to server.js. (See SETUP-STREAMING.txt section 4a.)\n');
    process.exit(1);
  }
})().catch(e => { console.error('\nUnexpected error:', e.message, '\n'); process.exit(1); });
