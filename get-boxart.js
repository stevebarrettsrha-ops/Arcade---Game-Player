#!/usr/bin/env node
/*
 * ARCADE — fetch real box-art for your games (optional, online, one-time).
 *
 * Run while online. For every game in games/<system>, it looks up matching
 * cover art in the community "libretro-thumbnails" set and saves it into
 * boxart/<system>/<same-name>.png. ARCADE then shows that cover instead of
 * the generated tile — no internet needed afterwards.
 *
 *   node get-boxart.js
 *
 * Matching is by file name, so it works best with standard (No-Intro / Redump)
 * names like "Super Mario World (USA).sfc". Anything it can't match keeps its
 * generated cover. Re-run any time you add games. Box-art is property of its
 * respective owners; downloaded for personal use only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT  = __dirname;
const GAMES = path.join(ROOT, 'games');
const OUT   = path.join(ROOT, 'boxart');
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const LIBRETRO = {
  gba:'Nintendo_-_Game_Boy_Advance', nes:'Nintendo_-_Nintendo_Entertainment_System',
  snes:'Nintendo_-_Super_Nintendo_Entertainment_System', genesis:'Sega_-_Mega_Drive_-_Genesis',
  gb:'Nintendo_-_Game_Boy', n64:'Nintendo_-_Nintendo_64', psx:'Sony_-_PlayStation',
  psp:'Sony_-_PlayStation_Portable',
};
const libretroName = n => n.replace(/[&*/:`<>?\\|]/g, '_');

function get(url, redirects = 3) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'ARCADE' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

(async () => {
  console.log('\nARCADE — downloading box-art for your games');
  console.log('Source: libretro-thumbnails (matched by file name)\n');
  let totalOk = 0, totalMiss = 0, totalGames = 0;

  for (const sys of Object.keys(LIBRETRO)) {
    const dir = path.join(GAMES, sys);
    let files; try { files = fs.readdirSync(dir); } catch (e) { continue; }
    const bases = [...new Set(files
      .filter(f => !f.startsWith('_') && !f.startsWith('.'))
      .filter(f => !IMG_EXT.includes(path.extname(f).toLowerCase()))
      .filter(f => /\.[a-z0-9]+$/i.test(f))
      .map(f => f.replace(/\.[^.]+$/, '')))];
    if (!bases.length) continue;

    console.log('[' + sys + '] ' + bases.length + ' game(s)…');
    const outDir = path.join(OUT, sys);
    let ok = 0, miss = 0;
    for (const base of bases) {
      totalGames++;
      const dest = path.join(outDir, base + '.png');
      if (fs.existsSync(dest)) { ok++; totalOk++; continue; }   // already have it
      const url = 'https://raw.githubusercontent.com/libretro-thumbnails/' + LIBRETRO[sys] +
                  '/master/Named_Boxarts/' + encodeURIComponent(libretroName(base)) + '.png';
      const data = await get(url);
      if (data && data.length > 100 && data[0] === 0x89 && data[1] === 0x50) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(dest, data);
        console.log('   ✓ ' + base);
        ok++; totalOk++;
      } else {
        console.log('   – ' + base + '  (no match)');
        miss++; totalMiss++;
      }
    }
    console.log('   → ' + ok + ' matched, ' + miss + ' unmatched\n');
  }

  if (!totalGames) {
    console.log('No games found in games/<system>. Drop some in, then run this again.\n');
    return;
  }
  console.log('Done — ' + totalOk + ' of ' + totalGames + ' games now have real box-art' +
              (totalMiss ? (', ' + totalMiss + ' kept their generated cover.') : '.'));
  console.log('Refresh ARCADE in your browser to see them.\n');
})().catch(e => { console.error('\nUnexpected error:', e.message, '\n'); process.exit(1); });
