/* ============================================================
   ARCADE home server
   A tiny, zero-dependency local server for your game library.
   - Serves the ARCADE front-end (arcade.html)
   - Serves your games from /games (with HTTP Range support)
   - Lists whatever you drop into games/gba and games/j2me
   - Builds a thumbnail for each game:
       1. a same-named image next to the game (Mario.gba + Mario.png)
       2. for .jar games, the icon embedded inside the jar
       3. (optional) online GBA box-art  -> set ARCADE_BOXART=1
   Run it with:  node server.js   (or use the start-* scripts)
   ============================================================ */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const zlib  = require('zlib');
const crypto = require('crypto');

const PORT  = process.env.PORT || 8080;
const ROOT  = __dirname;
const GAMES = path.join(ROOT, 'games');
const BOXART = process.env.ARCADE_BOXART === '1';   // optional online GBA covers
const PSP_MODE = process.env.ARCADE_PSP === '1';    // experimental: enables threads (needed by the PSP core)

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.wasm':'application/wasm', '.gba':'application/octet-stream',
  '.agb':'application/octet-stream', '.bin':'application/octet-stream', '.zip':'application/zip',
  '.7z':'application/x-7z-compressed', '.jar':'application/java-archive',
  '.jad':'text/vnd.sun.j2me.app-descriptor',
  '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2',
  '.data':'application/octet-stream', '.mem':'application/octet-stream', '.map':'application/json',
};
/* ---- systems registry: folder name -> accepted file extensions ---- */
const SYSTEMS = [
  { key: 'gba',     exts: ['.gba', '.agb', '.bin', '.zip'] },
  { key: 'nes',     exts: ['.nes', '.fds', '.unf', '.unif', '.zip'] },
  { key: 'snes',    exts: ['.sfc', '.smc', '.bs', '.zip'] },
  { key: 'genesis', exts: ['.md', '.gen', '.smd', '.bin', '.zip'] },
  { key: 'gb',      exts: ['.gb', '.gbc', '.dmg', '.zip'] },
  { key: 'n64',     exts: ['.n64', '.z64', '.v64', '.zip'] },
  { key: 'psx',     exts: ['.chd', '.pbp', '.iso', '.m3u', '.zip'] },
  { key: 'psp',     exts: ['.iso', '.cso', '.pbp', '.chd', '.zip'] },
  { key: 'j2me',    exts: ['.jar', '.jad'] },
];
const SYS_KEYS = SYSTEMS.map(s => s.key);
const BIOS_SYSTEMS = ['psx'];   // systems that can use an optional BIOS file (bios/<sys>/)
const IMG_EXT  = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const ACCENTS = { gba:'#3fe0cf', nes:'#e0584f', snes:'#9b8bff', genesis:'#4f9be0', gb:'#8bd07a',
                  n64:'#e0a52f', psx:'#d56fb0', psp:'#c3c7cf', j2me:'#f2b545' };
const LABELS  = { gba:'GBA', nes:'NES', snes:'SNES', genesis:'GENESIS', gb:'GAME BOY',
                  n64:'N64', psx:'PS1', psp:'PSP', j2me:'JAVA' };
// libretro-thumbnails repo names, used by the optional boxart downloader
const LIBRETRO = { gba:'Nintendo_-_Game_Boy_Advance', nes:'Nintendo_-_Nintendo_Entertainment_System',
                   snes:'Nintendo_-_Super_Nintendo_Entertainment_System', genesis:'Sega_-_Mega_Drive_-_Genesis',
                   gb:'Nintendo_-_Game_Boy', n64:'Nintendo_-_Nintendo_64', psx:'Sony_-_PlayStation',
                   psp:'Sony_-_PlayStation_Portable' };
const thumbCache = new Map();   // key -> {data,ct} | null
const rooms = new Map();        // room code -> Set of TV (display) SSE responses
const roomPlayers = new Map();  // room code -> Map(controllerId -> {slot, ts})
const PLAYER_TTL = 25000;       // a controller unseen this long frees its slot

function assignSlot(room, cid) {
  let m = roomPlayers.get(room); if (!m) { m = new Map(); roomPlayers.set(room, m); }
  const now = Date.now();
  for (const [k, v] of m) { if (now - v.ts > PLAYER_TTL) m.delete(k); }
  const cur = m.get(cid);
  if (cur) { cur.ts = now; return cur.slot; }
  const used = new Set([...m.values()].map(v => v.slot));
  let slot = 0; while (slot < 4 && used.has(slot)) slot++;
  if (slot >= 4) slot = m.size % 4;          // more than 4 controllers: wrap
  m.set(cid, { slot, ts: now });
  return slot;
}
function setSlot(room, cid, slot) {
  let m = roomPlayers.get(room); if (!m) { m = new Map(); roomPlayers.set(room, m); }
  m.set(cid, { slot, ts: Date.now() });
}
function freeSlot(room, cid) {
  const m = roomPlayers.get(room); if (m) { m.delete(cid); if (!m.size) roomPlayers.delete(room); }
}

/* ---- optional BIOS: first file dropped in bios/<system>/ ---- */
function biosFor(sys) {
  const dir = path.join(ROOT, 'bios', sys);
  try {
    const f = fs.readdirSync(dir).filter(n => !n.startsWith('.') && !n.startsWith('_') && fs.statSync(path.join(dir, n)).isFile())[0];
    if (f) return '/bios/' + sys + '/' + encodeURIComponent(f);
  } catch (e) {}
  return null;
}

/* ---- network addresses (for the WiFi URL) ---- */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const ni of ifaces[name] || [])
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  return out;
}

/* ---- find a same-named image sitting next to a game ---- */
function sidecar(dir, base) {
  for (const e of IMG_EXT) {
    const p = path.join(dir, base + e);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ---- scan one games sub-folder ---- */
function listGames(sub, exts) {
  const dir = path.join(GAMES, sub);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  let list = names
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => {
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
      return {
        name: f.replace(/\.[^.]+$/, ''), file: f,
        ext: path.extname(f).toLowerCase().slice(1), size,
        url:   '/games/' + sub + '/' + encodeURIComponent(f),
        thumb: '/thumb/' + sub + '/' + encodeURIComponent(f),
      };
    });
  // J2ME: a game is a runnable .jar, sometimes paired with a .jad text
  // descriptor of the same name. Collapse a pair into ONE card (the .jar,
  // which is what actually runs), keeping the .jad alongside it. A .jad with
  // no matching .jar can't run on its own, so flag it.
  if (sub === 'j2me') {
    const byName = {};
    for (const g of list) (byName[g.name] = byName[g.name] || {})[g.ext] = g;
    list = Object.keys(byName).map(name => {
      const pair = byName[name];
      if (pair.jar) { if (pair.jad) pair.jar.jad = pair.jad.url; return pair.jar; }
      return Object.assign(pair.jad, { jadOnly: true });
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/* ===================  tiny ZIP reader (for .jar icons)  =================== */
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
    if (entry.method === 0) return comp;             // stored
    if (entry.method === 8) return zlib.inflateRawSync(comp); // deflate
  } catch (e) {}
  return null;
}
function jarIcon(jarPath) {
  let buf;
  try { buf = fs.readFileSync(jarPath); } catch (e) { return null; }
  const entries = zipEntries(buf);
  if (!entries.length) return null;

  // 1. icon declared in the manifest
  let iconPath = null;
  const man = entries.find(e => e.name.toUpperCase() === 'META-INF/MANIFEST.MF');
  if (man) {
    const raw = zipRead(buf, man);
    if (raw) {
      const txt = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n /g, '');
      const grab = re => { const m = re.exec(txt); return m ? m[1].trim() : null; };
      iconPath = grab(/MIDlet-Icon:\s*(.+)/i);
      if (!iconPath) {
        const m1 = grab(/MIDlet-1:\s*(.+)/i);
        if (m1) { const parts = m1.split(','); if (parts.length >= 2) iconPath = parts[1].trim(); }
      }
    }
  }
  const norm = p => p.replace(/^\//, '').toUpperCase();
  let entry = null;
  if (iconPath) entry = entries.find(e => e.name.toUpperCase() === norm(iconPath));

  // 2. fallback: an image entry that looks like an icon, else the first image
  if (!entry) {
    const imgs = entries.filter(e => /\.(png|gif|jpe?g)$/i.test(e.name));
    entry = imgs.find(e => /icon/i.test(e.name)) || imgs[0] || null;
  }
  if (!entry) return null;
  const data = zipRead(buf, entry);
  if (!data || !data.length) return null;
  const ext = (entry.name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const ct = MIME['.' + (ext ? ext.toLowerCase() : 'png')] || 'image/png';
  return { data, ct };
}

/* ===================  optional online GBA box-art  =================== */
function libretroName(n) { return n.replace(/[&*/:`<>?\\|]/g, '_'); }
function httpsGet(url, redirects = 3) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 3500, headers: { 'User-Agent': 'ARCADE' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume(); return resolve(httpsGet(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
async function gbaBoxart(name) {
  const base = 'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Game_Boy_Advance/master/Named_Boxarts/';
  const data = await httpsGet(base + encodeURIComponent(libretroName(name)) + '.png');
  return data ? { data, ct: 'image/png' } : null;
}

/* ===================  generated offline cover tiles  =================== */
function hashStr(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))>>>0; return h; }
function svgEsc(s){ return String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
function hexToRgb(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
function rgbToHex(r,g,b){ const f=x=>Math.max(0,Math.min(255,Math.round(x))).toString(16).padStart(2,'0'); return '#'+f(r)+f(g)+f(b); }
function mixBlack(hex,t){ const [r,g,b]=hexToRgb(hex); return rgbToHex(r*(1-t),g*(1-t),b*(1-t)); }
function shiftHue(hex,deg){
  let [r,g,b]=hexToRgb(hex); r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2; let h=0,s=0;
  if(mx!==mn){ const d=mx-mn; s=l>0.5?d/(2-mx-mn):d/(mx+mn);
    h=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4; h/=6; }
  h=(h+deg/360)%1; if(h<0)h+=1;
  const hue2rgb=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  let R,G,B;
  if(s===0){ R=G=B=l; } else { const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q; R=hue2rgb(p,q,h+1/3); G=hue2rgb(p,q,h); B=hue2rgb(p,q,h-1/3); }
  return rgbToHex(R*255,G*255,B*255);
}
function monogram(name){
  const clean=name.replace(/[\(\[\{].*$/,'').replace(/[^A-Za-z0-9 ]/g,' ').trim();
  const w=clean.split(/\s+/).filter(Boolean);
  if(!w.length) return '★';
  if(w.length===1) return w[0].slice(0,2).toUpperCase();
  return (w[0][0]+w[1][0]).toUpperCase();
}
function genCover(kind, name){
  const accent = ACCENTS[kind] || '#7a8290';
  const h = hashStr(kind + '|' + name);
  const c = shiftHue(accent, (h % 46) - 23);     // stay in the system's colour family
  const top = mixBlack(c, 0.80), bot = mixBlack(c, 0.55);
  const mono = monogram(name), label = LABELS[kind] || kind.toUpperCase();
  const style = h % 3;
  let pat = '';
  if (style === 0) {                              // dot grid
    let d=''; const o=h%6;
    for(let y=18;y<140;y+=22) for(let x=14+(((y/22)|0)%2?11:0);x<320;x+=22) d+=`<circle cx='${x+o}' cy='${y}' r='2.2'/>`;
    pat = `<g fill='${c}' fill-opacity='0.10'>${d}</g>`;
  } else if (style === 1) {                       // diagonal stripes
    let d=''; for(let x=-140;x<340;x+=26) d+=`<line x1='${x}' y1='0' x2='${x+140}' y2='140'/>`;
    pat = `<g stroke='${c}' stroke-opacity='0.09' stroke-width='9'>${d}</g>`;
  } else {                                        // nested frames
    let d=''; for(let i=0;i<6;i++){ const m=8+i*13; d+=`<rect x='${m}' y='${m}' width='${320-2*m}' height='${140-2*m}' rx='9'/>`; }
    pat = `<g fill='none' stroke='${c}' stroke-opacity='0.08' stroke-width='3'>${d}</g>`;
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='140' viewBox='0 0 320 140'>`+
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${top}'/><stop offset='1' stop-color='${bot}'/></linearGradient></defs>`+
    `<rect width='320' height='140' fill='url(#g)'/>${pat}`+
    `<text x='160' y='82' font-family='Arial,Helvetica,sans-serif' font-weight='800' font-size='62' fill='${c}' fill-opacity='0.24' text-anchor='middle' dominant-baseline='middle'>${svgEsc(mono)}</text>`+
    `<text x='16' y='26' font-family='Arial,Helvetica,sans-serif' font-weight='700' font-size='12' letter-spacing='2' fill='${c}'>${svgEsc(label)}</text>`+
    `</svg>`;
  return { data: Buffer.from(svg, 'utf8'), ct: 'image/svg+xml' };
}

/* ===================  embedded game icons (offline)  =================== */
// PSP / PSN-PS1 EBOOT (.pbp): ICON0.PNG sits between header offsets 0x0C and 0x10
function pbpIcon(full){
  let fd; try { fd = fs.openSync(full, 'r'); } catch (e) { return null; }
  try {
    const head = Buffer.alloc(40); fs.readSync(fd, head, 0, 40, 0);
    if (!(head[0]===0x00 && head[1]===0x50 && head[2]===0x42 && head[3]===0x50)) return null; // "\0PBP"
    const off0 = head.readUInt32LE(0x0C), off1 = head.readUInt32LE(0x10);
    const len = off1 - off0;
    if (!(len > 8) || len > 5*1024*1024) return null;
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off0);
    if (!(buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47)) return null; // PNG sig
    return { data: buf, ct: 'image/png' };
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
}
// PSP .iso (ISO9660): read PSP_GAME/ICON0.PNG without loading the whole image
function isoFindInDir(fd, lba, size, target, wantDir){
  const sectors = Math.min(Math.ceil(size / 2048), 64);   // dirs are tiny; cap reads
  if (sectors <= 0) return null;
  const buf = Buffer.alloc(2048 * sectors);
  fs.readSync(fd, buf, 0, buf.length, lba * 2048);
  let pos = 0;
  while (pos + 33 < buf.length) {
    const len = buf[pos];
    if (len === 0) { pos = (Math.floor(pos / 2048) + 1) * 2048; continue; }
    if (pos + len > buf.length) break;
    const exLba = buf.readUInt32LE(pos + 2), dataLen = buf.readUInt32LE(pos + 10);
    const flags = buf[pos + 25], nameLen = buf[pos + 32];
    let name = buf.toString('latin1', pos + 33, pos + 33 + nameLen).split(';')[0].toUpperCase();
    if (name === target && (!!(flags & 2)) === wantDir) return { lba: exLba, size: dataLen };
    pos += len;
  }
  return null;
}
function isoIcon(full){
  let fd; try { fd = fs.openSync(full, 'r'); } catch (e) { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (st.size < 0x8000 + 2048) return null;
    const pvd = Buffer.alloc(2048); fs.readSync(fd, pvd, 0, 2048, 16 * 2048);
    if (pvd[0] !== 1 || pvd.toString('latin1', 1, 6) !== 'CD001') return null;
    const game = isoFindInDir(fd, pvd.readUInt32LE(156 + 2), pvd.readUInt32LE(156 + 10), 'PSP_GAME', true);
    if (!game) return null;
    const icon = isoFindInDir(fd, game.lba, game.size, 'ICON0.PNG', false);
    if (!icon || icon.size <= 8 || icon.size > 5*1024*1024) return null;
    const buf = Buffer.alloc(icon.size); fs.readSync(fd, buf, 0, icon.size, icon.lba * 2048);
    if (!(buf[0]===0x89 && buf[1]===0x50)) return null;
    return { data: buf, ct: 'image/png' };
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
}
// real boxart downloaded earlier by get-boxart.js into boxart/<sys>/<name>.<img>
function localBoxart(kind, base){
  const dir = path.join(ROOT, 'boxart', kind);
  for (const e of IMG_EXT) {
    const p = path.join(dir, base + e);
    if (fs.existsSync(p)) { try { return { data: fs.readFileSync(p), ct: MIME[e] || 'image/png' }; } catch (_) {} }
  }
  return null;
}

/* =================== per-user profiles + saved games =================== */
const USERS = path.join(ROOT, 'users');
const sessions = new Map();                 // token -> { user, ts }
const SESSION_TTL = 1000 * 60 * 60 * 12;    // 12h
const safeName = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
const safeGame = s => String(s || '').replace(/[^A-Za-z0-9 ._()\[\]+-]/g, '_').slice(0, 120) || 'game';
const userDir  = u => path.join(USERS, u);
function listUsers(){
  try { return fs.readdirSync(USERS).filter(d => { try { return fs.statSync(path.join(USERS, d, 'profile.json')).isFile(); } catch (e) { return false; } }); }
  catch (e) { return []; }
}
function readProfile(u){ try { return JSON.parse(fs.readFileSync(path.join(userDir(u), 'profile.json'), 'utf8')); } catch (e) { return null; } }
function hashPin(pin, salt){ return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function pinOk(pin, prof){
  if (!prof || !prof.salt || !prof.hash) return false;
  const h = hashPin(pin, prof.salt);
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(prof.hash, 'hex')); } catch (e) { return false; }
}
function newToken(){ return crypto.randomBytes(18).toString('hex'); }
function userForToken(tok){
  const s = sessions.get(tok); if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(tok); return null; }
  s.ts = Date.now(); return s.user;
}
function savePaths(u, system, game, kind){
  const dir = path.join(userDir(u), 'saves', safeName(system));
  const ext = kind === 'srm' ? '.srm' : '.state';
  return { dir, file: path.join(dir, safeGame(game) + ext) };
}
function readJsonBody(req, cb){
  let b = ''; req.on('data', c => { b += c; if (b.length > 8192) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb(null); } });
  req.on('error', () => cb(null));
}
function readRawBody(req, max, cb){
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > max) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', () => cb(null));
}
const jsonRes = (res, obj, code) => { res.writeHead(code || 200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(obj)); };

/* ---- resolve a thumbnail for one game ---- */
async function resolveThumb(kind, file) {
  if (!SYS_KEYS.includes(kind)) return null;
  const dir = path.join(GAMES, kind);
  const full = path.join(dir, file);
  if (path.dirname(full) !== dir || !fs.existsSync(full)) return null;

  let st; try { st = fs.statSync(full); } catch (e) { return null; }
  const key = kind + '|' + file + '|' + st.size + '|' + (+st.mtime);
  if (thumbCache.has(key)) return thumbCache.get(key);

  const base = file.replace(/\.[^.]+$/, '');
  const ext  = path.extname(file).toLowerCase();
  let result = null;

  const side = sidecar(dir, base);                            // 1. same-named image (any system)
  if (side) {
    try { result = { data: fs.readFileSync(side), ct: MIME[path.extname(side).toLowerCase()] || 'image/png' }; } catch (e) {}
  }
  if (!result) result = localBoxart(kind, base);              // 2. real boxart fetched by get-boxart.js
  if (!result && kind === 'j2me') result = jarIcon(full);     // 3. icon inside the .jar
  if (!result && ext === '.pbp') result = pbpIcon(full);      // 4. ICON0.PNG inside a PSP/PS1 EBOOT
  if (!result && kind === 'psp' && ext === '.iso') result = isoIcon(full); // 5. ICON0.PNG inside a PSP ISO
  if (!result && kind === 'gba' && BOXART) result = await gbaBoxart(base);  // 6. live GBA box-art (legacy)
  if (!result) result = genCover(kind, base);                 // 7. always: generated offline cover tile

  thumbCache.set(key, result);
  return result;
}

/* ---- generic file serving with Range ---- */
function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end   = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, 'Content-Type': type, 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.normalize(path.join(ROOT, decoded));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  // PSP mode needs SharedArrayBuffer (multi-threading). Cross-origin isolation enables it;
  // COEP credentialless keeps the cross-origin Java-phone iframe and CDN loading.
  if (PSP_MODE) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  }
  let url = req.url.split('?')[0];
  if (url === '/') url = '/arcade.html';

  const q = new URL(req.url, 'http://localhost');
  const room = (q.searchParams.get('room') || '').toUpperCase().slice(0, 8);

  /* ---- phone-as-controller relay (Server-Sent Events) ----
     The TV opens /events?room=CODE and keeps it open.
     A phone POSTs button presses to /input?room=CODE.
     The server pushes each press down the TV's open stream. */
  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!room) { res.write('event: error\ndata: "no room"\n\n'); return; }
    let set = rooms.get(room); if (!set) { set = new Set(); rooms.set(room, set); }
    set.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) rooms.delete(room); });
    return;
  }
  if (url === '/input') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let player = null;
      if (body) {
        try {
          const msg = JSON.parse(body);
          if (msg && msg.cid) {
            if (msg.t === 'hello') { player = assignSlot(room, msg.cid); msg.p = player; }
            else if (msg.t === 'claim' && Number.isInteger(msg.p) && msg.p >= 0 && msg.p < 4) { setSlot(room, msg.cid, msg.p); }
            else if (msg.t === 'bye') { freeSlot(room, msg.cid); }
          }
          body = JSON.stringify(msg);     // re-serialize so the stamped player reaches the TV
        } catch (e) { /* not JSON: relay as-is */ }
      }
      const set = rooms.get(room);
      let n = 0;
      if (set && body) {
        const out = 'data: ' + body.replace(/[\r\n]+/g, ' ') + '\n\n';
        for (const r of set) { try { r.write(out); n++; } catch (e) {} }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, displays: n, player }));
    });
    return;
  }
  if (url === '/api/net') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
  }

  /* ---- player profiles (username + 4-digit PIN) ---- */
  if (url === '/api/users') {                         // list profile names (never PINs)
    return jsonRes(res, { users: listUsers().map(u => ({ name: u, display: (readProfile(u) || {}).display || u })) });
  }
  if (url === '/api/user/create' && req.method === 'POST') {
    return readJsonBody(req, body => {
      if (!body) return jsonRes(res, { ok: false, error: 'bad request' }, 400);
      const name = safeName(body.username), pin = String(body.pin || '');
      if (name.length < 2) return jsonRes(res, { ok: false, error: 'Pick a name (letters/numbers, 2+).' }, 400);
      if (!/^\d{4}$/.test(pin)) return jsonRes(res, { ok: false, error: 'PIN must be exactly 4 digits.' }, 400);
      if (fs.existsSync(path.join(userDir(name), 'profile.json'))) return jsonRes(res, { ok: false, error: 'That name is taken.' }, 409);
      try {
        fs.mkdirSync(path.join(userDir(name), 'saves'), { recursive: true });
        const salt = crypto.randomBytes(12).toString('hex');
        fs.writeFileSync(path.join(userDir(name), 'profile.json'),
          JSON.stringify({ display: String(body.username || name).slice(0, 24), salt, hash: hashPin(pin, salt), created: Date.now() }, null, 2));
      } catch (e) { return jsonRes(res, { ok: false, error: 'Could not create profile.' }, 500); }
      const token = newToken(); sessions.set(token, { user: name, ts: Date.now() });
      return jsonRes(res, { ok: true, token, name });
    });
  }
  if (url === '/api/user/login' && req.method === 'POST') {
    return readJsonBody(req, body => {
      if (!body) return jsonRes(res, { ok: false }, 400);
      const name = safeName(body.username); const prof = readProfile(name);
      if (!prof || !pinOk(String(body.pin || ''), prof)) return jsonRes(res, { ok: false, error: 'Wrong name or PIN.' }, 401);
      const token = newToken(); sessions.set(token, { user: name, ts: Date.now() });
      return jsonRes(res, { ok: true, token, name });
    });
  }

  /* ---- per-user saved games (each profile has its own folder) ---- */
  if (url === '/api/save' && req.method === 'POST') {
    const user = userForToken(q.searchParams.get('token'));
    if (!user) return jsonRes(res, { ok: false, error: 'not logged in' }, 401);
    const system = q.searchParams.get('system'), game = q.searchParams.get('game');
    const kind = q.searchParams.get('kind') === 'srm' ? 'srm' : 'state';
    if (!system || !game) return jsonRes(res, { ok: false }, 400);
    return readRawBody(req, 64 * 1024 * 1024, buf => {       // states can be a few MB (PS1/N64)
      if (!buf || !buf.length) return jsonRes(res, { ok: false, error: 'empty' }, 400);
      const p = savePaths(user, system, game, kind);
      try { fs.mkdirSync(p.dir, { recursive: true }); fs.writeFileSync(p.file, buf); }
      catch (e) { return jsonRes(res, { ok: false, error: 'write failed' }, 500); }
      return jsonRes(res, { ok: true, bytes: buf.length });
    });
  }
  if (url === '/api/load') {
    const user = userForToken(q.searchParams.get('token'));
    if (!user) { res.writeHead(401); return res.end(); }
    const p = savePaths(user, q.searchParams.get('system'), q.searchParams.get('game'),
                        q.searchParams.get('kind') === 'srm' ? 'srm' : 'state');
    fs.readFile(p.file, (err, data) => {
      if (err || !data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  if (url === '/api/has') {
    const user = userForToken(q.searchParams.get('token'));
    if (!user) return jsonRes(res, { state: false, srm: false });
    const system = q.searchParams.get('system'), game = q.searchParams.get('game');
    const st = savePaths(user, system, game, 'state'), sr = savePaths(user, system, game, 'srm');
    return jsonRes(res, { state: fs.existsSync(st.file), srm: fs.existsSync(sr.file) });
  }

  if (url === '/api/library') {
    const lib = { boxart: BOXART, bios: {}, ejsLocal: fs.existsSync(path.join(ROOT, 'emulatorjs', 'loader.js')), isolated: PSP_MODE,
                  pspWeb: fs.existsSync(path.join(ROOT, 'psp-ppsspp', 'index.html')),
                  j2meWeb: fs.existsSync(path.join(ROOT, 'j2me-web', 'web', 'index.html')) };
    for (const s of SYSTEMS) lib[s.key] = listGames(s.key, s.exts);
    for (const s of BIOS_SYSTEMS) lib.bios[s] = biosFor(s);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(lib));
  }

  const tm = /^\/thumb\/([a-zA-Z0-9]+)\/(.+)$/.exec(url);
  if (tm) {
    let file; try { file = decodeURIComponent(tm[2]); } catch (e) { res.writeHead(400); return res.end(); }
    try {
      const t = await resolveThumb(tm[1], file);
      if (!t) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': t.ct, 'Content-Length': t.data.length, 'Cache-Control': 'max-age=120' });
      return res.end(t.data);
    } catch (e) { res.writeHead(404); return res.end(); }
  }

  if (url === '/users' || url.startsWith('/users/')) { res.writeHead(403); return res.end('Forbidden'); }
  const filePath = safeResolve(url);
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  let target = filePath;
  // serve index.html for a directory request (e.g. /j2me-web/web/)
  try { if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html'); } catch (e) {}
  // FreeJ2ME-web links to extensionless routes (e.g. /j2me-web/web/run?app=ID),
  // which GitHub Pages serves as run.html. Mirror that for the local copy.
  if (url.startsWith('/j2me-web/') && !path.extname(target) && !fs.existsSync(target) && fs.existsSync(target + '.html')) {
    target = target + '.html';
  }
  serveFile(req, res, target);
});

server.listen(PORT, '0.0.0.0', () => {
  try { fs.mkdirSync(USERS, { recursive: true }); } catch (e) {}
  const ips = lanAddresses();
  const line = '------------------------------------------------------------';
  console.log('\n  Starting the ARCADE home server...');
  console.log('  Leave this window OPEN while anyone is playing.');
  console.log('  Close it (or press Ctrl+C) to stop the server.\n');
  console.log(line);
  console.log('  ARCADE home server is running.\n');
  console.log('  On THIS computer:        http://localhost:' + PORT);
  if (ips.length) {
    console.log('  On phones/TVs (same WiFi): http://' + ips[0] + ':' + PORT);
    for (let i = 1; i < ips.length; i++) console.log('                             http://' + ips[i] + ':' + PORT);
  }
  console.log(line);
  console.log('\n  Drop games into these folders, then refresh the page:');
  console.log('    games/gba      .gba .zip          games/nes      .nes .zip');
  console.log('    games/snes     .sfc .smc .zip      games/genesis  .md .gen .zip');
  console.log('    games/gb       .gb .gbc .zip       games/n64      .n64 .z64 .zip');
  console.log('    games/psx      .chd .pbp .iso      games/j2me     .jar .jad');
  console.log('  PS1 BIOS (optional): drop a file in bios/psx/');
  console.log('  Covers: auto-generated for every game; .jar/PSP use their own icons;');
  console.log('          drop a same-named .png next to a game to override; or run');
  console.log('          download-boxart-* (online, once) to fetch real box-art.');
  if (BOXART) console.log('  Online GBA box-art: ON');
  if (PSP_MODE) console.log('  PSP mode: ON (threads enabled — experimental; Java-phone still works)');
  console.log('  Phone remote: click "Phone", scan the code, browse & play.');
  console.log('  Players: pick a profile (name + 4-digit PIN) to keep saves separate.');
  console.log('  Then refresh the page in your browser.\n');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use. Try another, e.g.:');
    console.error('    PORT=8090 node server.js\n');
  } else console.error(e);
});
