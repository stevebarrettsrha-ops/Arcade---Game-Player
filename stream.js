/* ============================================================
   ARCADE — host-side streaming mode (OPT-IN)
   ------------------------------------------------------------
   Instead of every TV/phone running the emulator in its own browser (WASM),
   the HOST (a gaming PC / Steam Deck / mini-PC) runs the REAL native emulator
   with all its capabilities, and ARCADE streams the picture to the clients as
   MJPEG, shown inside an iframe. Clients just display the video and send
   button presses from pad.html — so weak TVs do almost no work, and you get
   the heavy / "impossible" systems (PS2, original XBOX, GameCube/Wii, PS3,
   flawless N64/PSP) a browser can't do.

   HOW EMULATORS ARE REGISTERED
   Drop one folder per emulator into  emulators/<name>/  with a manifest:
       emulators/pcsx2/emulator.json
       {
         "name":    "PCSX2 (PS2)",
         "cmd":     "pcsx2-qt -fullscreen {rom}",
         "capture": "auto",          // auto | x11 | gdigrab | avfoundation | kms | test
         "window":  "PCSX2",         // window title (for input focus on X11); optional
         "needsRom": true,           // does cmd use {rom}?
         "system":  "PS2",           // label shown on the cards; optional
         "roms":    "games/ps2",     // folder (inside ARCADE) listed as launchable games; optional
         "exts":    [".iso",".chd"]  // which files in that folder count as games; optional
       }
   ARCADE lists every emulator it finds; with a "roms" folder its games appear
   as cards in the picker AND in the phone pad's Games drawer, so a phone can
   start a PS2/XBOX/N64/PSP game on the TV directly. A same-named icon.png in
   the folder is used as art.

   CAPTURE + INPUT are cross-platform:
     - capture "auto" picks the right grabber for the host OS:
         Windows -> gdigrab, macOS -> avfoundation, Linux -> x11grab
     - controller input from pad.html is injected as keyboard presses
       (RetroArch's default keyboard layout) using:
         Linux  -> xdotool (per event)
         Windows-> a persistent PowerShell helper (stream-input.ps1, keybd_event)
         macOS  -> a persistent `osascript -i` (System Events key down/up)
       Set ARCADE_STREAM_INPUT=none to disable injection.

   Loaded ONLY when ARCADE_STREAM=1, so normal browser mode is untouched. It
   shells out to host programs (ffmpeg for capture/encode) — see
   SETUP-STREAMING.txt.

   Logic self-test (no ffmpeg/emulator needed):  node stream.js --selftest
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT    = __dirname;
const EMU_DIR = path.join(ROOT, 'emulators');

/* ---- platform defaults (pure, testable via the platform arg) ---- */
function defaultCapture(platform) {
  platform = platform || process.platform;
  if (platform === 'win32')  return 'gdigrab';
  if (platform === 'darwin') return 'avfoundation';
  return 'x11';
}
function defaultInputTool(platform) {
  platform = platform || process.platform;
  if (platform === 'win32')  return 'powershell';
  if (platform === 'darwin') return 'osascript';
  return 'xdotool';
}
function resolveCapture(capture, platform) {
  return (!capture || capture === 'auto') ? defaultCapture(platform) : capture;
}
function resolveInputTool(tool, platform) {
  return (!tool || tool === 'auto') ? defaultInputTool(platform) : tool;
}

/* ---- global capture/encode defaults (overridable via env) ---- */
function config() {
  const e = process.env;
  return {
    capture:   e.ARCADE_STREAM_CAPTURE || 'auto',     // auto = right grabber for this OS
    display:   e.ARCADE_STREAM_DISPLAY || ':0',       // X display, or avfoundation device
    size:      e.ARCADE_STREAM_SIZE    || '1280x720',
    fps:       e.ARCADE_STREAM_FPS     || '30',
    quality:   e.ARCADE_STREAM_QUALITY || '6',        // ffmpeg mjpeg -q:v (2 best .. 31 worst)
    ffmpeg:    e.ARCADE_STREAM_FFMPEG  || 'ffmpeg',
    inputTool: e.ARCADE_STREAM_INPUT   || 'auto',     // auto | xdotool | powershell | osascript | none
  };
}

/* ---- scan a roms folder declared by a manifest ---- */
function listRoms(dir, exts) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(f => !f.startsWith('.') && !f.startsWith('_'))
    .filter(f => !exts.length || exts.includes(path.extname(f).toLowerCase()))
    .filter(f => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; } })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 500)
    .map(f => ({ name: f.replace(/\.[^.]+$/, ''), file: f }));
}

/* ---- scan the emulators/ folder for manifests (pure-ish, testable via dir args) ---- */
function scanEmulators(dir, root) {
  dir = dir || EMU_DIR; root = root || ROOT;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const mf = path.join(dir, name, 'emulator.json');
    let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { continue; }
    if (!m || !m.cmd) continue;
    // optional roms folder: must stay inside the ARCADE folder
    let romDir = null, games = [];
    if (m.roms) {
      const cand = path.normalize(path.join(root, String(m.roms)));
      if (cand.startsWith(root + path.sep)) {
        romDir = cand;
        const exts = Array.isArray(m.exts) ? m.exts.map(x => String(x).toLowerCase()) : [];
        games = listRoms(romDir, exts);
      }
    }
    out.push({
      id: name,
      name: String(m.name || name),
      cmd: String(m.cmd),
      capture: m.capture || null,
      window: m.window || '',
      needsRom: !!m.needsRom,
      system: m.system ? String(m.system) : '',
      romDir, games,
      icon: fs.existsSync(path.join(dir, name, 'icon.png')) ? '/emulators/' + encodeURIComponent(name) + '/icon.png' : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- ffmpeg capture+encode args -> concatenated-JPEG stream on stdout (pure) ---- */
function captureArgs(cfg, capture, platform) {
  capture = resolveCapture(capture || cfg.capture, platform);
  const a = ['-loglevel', 'error'];
  const width = parseInt(cfg.size, 10) || 1280;
  let scale = false;
  if (capture === 'x11') {
    a.push('-f', 'x11grab', '-video_size', cfg.size, '-framerate', cfg.fps, '-i', cfg.display);
  } else if (capture === 'gdigrab') {                                // Windows desktop
    a.push('-f', 'gdigrab', '-framerate', cfg.fps, '-i', 'desktop');
    scale = true;
  } else if (capture === 'avfoundation') {                           // macOS screen
    const dev = /^[:]/.test(cfg.display) ? 'Capture screen 0' : cfg.display;
    a.push('-f', 'avfoundation', '-capture_cursor', '1', '-framerate', cfg.fps, '-i', dev + ':none');
    scale = true;
  } else if (capture === 'kms') {
    a.push('-f', 'kmsgrab', '-framerate', cfg.fps, '-i', '-');       // advanced; see docs
  } else {                                                           // 'test'
    a.push('-f', 'lavfi', '-i', `testsrc=size=${cfg.size}:rate=${cfg.fps}`);
  }
  // full-desktop grabs are scaled down to the target width (keeps aspect, saves WiFi bandwidth)
  const vf = scale ? `scale=${width}:-2,format=yuvj420p` : 'format=yuvj420p';
  a.push('-vf', vf, '-c:v', 'mjpeg', '-q:v', String(cfg.quality), '-f', 'image2pipe', '-');
  return a;
}

/* ---- emulator launch args from a manifest cmd (pure, quote-aware) ----
   Quotes let Windows/macOS paths with spaces work:
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
function launchArgs(emu, romPath) {
  if (!emu || !emu.cmd) return null;
  return tokenize(emu.cmd)
    .map(p => p.includes('{rom}') ? p.split('{rom}').join(romPath || '') : p)
    .filter(Boolean);
}

/* ---- controller -> RetroArch-style default keyboard mapping (pure) ----
   Same layout on every host OS, expressed in each injector's key names. */
const KEYMAP = {                                       // xdotool key names (Linux/X11)
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  b: 'z', a: 'x', y: 'a', x: 's', l: 'q', r: 'w', l2: 'e', r2: 't',
  start: 'Return', select: 'shift',
};
const HOTKEY = { save: 'F2', load: 'F4', ff_on: 'space', ff_off: 'space' };
const VKMAP = {                                        // Windows virtual-key codes
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  b: 0x5A, a: 0x58, y: 0x41, x: 0x53, l: 0x51, r: 0x57, l2: 0x45, r2: 0x54,
  start: 0x0D, select: 0x10,
};
const VKHOT = { save: 0x71, load: 0x73, ff_on: 0x20, ff_off: 0x20 };   // F2 F4 space
// macOS System Events can hold character keys but not arrow keys, so the D-pad
// maps to I/K/J/L there — bind those in the emulator on a macOS host.
const OSAMAP = {
  up: 'i', down: 'k', left: 'j', right: 'l',
  b: 'z', a: 'x', y: 'a', x: 's', l: 'q', r: 'w', l2: 'e', r2: 't',
  start: 'return', select: 'shift',
};
const OSAHOT = { save: 'code:120', load: 'code:118', ff_on: 'space', ff_off: 'space' };

function inputArgs(cfg, key, down, window) {           // xdotool argv (kept pure for tests)
  if (cfg.inputTool !== 'xdotool') return null;
  const act = down ? 'keydown' : 'keyup';
  // focus the emulator window by title first if we know it, else send to the active window
  if (window) return ['xdotool', 'search', '--name', window, 'windowfocus', act, key];
  return ['xdotool', act, key];
}
function osaLine(key, down) {                          // one `osascript -i` line (pure)
  if (key.startsWith('code:')) return 'tell application "System Events" to key code ' + key.slice(5);
  const k = key.length === 1 ? '"' + key + '"' : key;  // letters quoted; return/shift/space are constants
  return 'tell application "System Events" to key ' + (down ? 'down ' : 'up ') + k;
}

/* ---- persistent key-injector helpers (Windows / macOS) ---- */
let psProc = null, osaProc = null;
function psSend(vk, down) {
  if (!psProc) {
    try {
      psProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(ROOT, 'stream-input.ps1')], { stdio: ['pipe', 'ignore', 'ignore'] });
      psProc.on('error', () => { psProc = null; });
      psProc.on('close', () => { psProc = null; });
    } catch (e) { psProc = null; return; }
  }
  try { psProc.stdin.write((down ? 'down ' : 'up ') + vk + '\n'); } catch (e) { psProc = null; }
}
function osaSend(key, down) {
  if (!osaProc) {
    try {
      osaProc = spawn('osascript', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      osaProc.on('error', () => { osaProc = null; });
      osaProc.on('close', () => { osaProc = null; });
    } catch (e) { osaProc = null; return; }
  }
  try { osaProc.stdin.write(osaLine(key, down) + '\n'); } catch (e) { osaProc = null; }
}
function stopInjectors() {
  for (const p of [psProc, osaProc]) { if (p) { try { p.kill('SIGTERM'); } catch (e) {} } }
  psProc = osaProc = null;
}

/* ---- JPEG frame splitter: ffmpeg's concatenated JPEGs -> discrete frames (testable) ---- */
class JpegSplitter {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const soi = this.buf.indexOf('\xff\xd8', 0, 'binary');
      if (soi < 0) { if (this.buf.length > 1 << 20) this.buf = Buffer.alloc(0); return; }
      const eoi = this.buf.indexOf('\xff\xd9', soi + 2, 'binary');
      if (eoi < 0) { if (soi > 0) this.buf = this.buf.slice(soi); return; }
      this.onFrame(this.buf.slice(soi, eoi + 2));
      this.buf = this.buf.slice(eoi + 2);
    }
  }
}

/* ---- one capture session, fanned out to many browser iframes via MJPEG ---- */
const BOUNDARY = 'arcadeframe';
class StreamSession {
  constructor(cfg) {
    this.cfg = cfg; this.subscribers = new Set();
    this.lastFrame = null; this.ffmpeg = null; this.emulator = null;
    this.running = false; this.emu = null; this._err = null;
  }
  start(emu, romPath) {
    this.stop();
    this.emu = emu; this._err = null;
    if (emu && emu.cmd) {
      const la = launchArgs(emu, romPath);
      if (la && la.length) { try { this.emulator = spawn(la[0], la.slice(1), { stdio: 'ignore' }); this.emulator.on('error', e => { this._err = 'emulator: ' + e.message; }); } catch (e) { this._err = 'emulator: ' + e.message; } }
    }
    const splitter = new JpegSplitter(f => { this.lastFrame = f; this._broadcast(f); });
    try {
      this.ffmpeg = spawn(this.cfg.ffmpeg, captureArgs(this.cfg, emu && emu.capture), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { this._err = 'ffmpeg: ' + e.message; return { ok: false, error: this._err }; }
    this.ffmpeg.stdout.on('data', d => splitter.push(d));
    this.ffmpeg.stderr.on('data', d => { this._err = (this._err ? this._err + ' ' : '') + d.toString().trim().slice(0, 160); });
    this.ffmpeg.on('error', e => { this._err = 'ffmpeg: ' + e.message; this.running = false; });
    this.ffmpeg.on('close', () => { this.running = false; });
    this.running = true;
    return { ok: true };
  }
  stop() {
    this.running = false;
    for (const p of [this.ffmpeg, this.emulator]) { if (p) { try { p.kill('SIGTERM'); } catch (e) {} } }
    this.ffmpeg = this.emulator = null;
    for (const res of this.subscribers) { try { res.end(); } catch (e) {} }
    this.subscribers.clear();
  }
  addSubscriber(res) {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY,
      'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'Connection': 'close' });
    this.subscribers.add(res);
    if (this.lastFrame) this._write(res, this.lastFrame);
    res.on('close', () => this.subscribers.delete(res));
  }
  _write(res, jpeg) {
    try {
      res.write('--' + BOUNDARY + '\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n');
      res.write(jpeg); res.write('\r\n');
    } catch (e) { this.subscribers.delete(res); }
  }
  _broadcast(jpeg) { for (const res of this.subscribers) this._write(res, jpeg); }
  inject(action, down) {
    const tool = resolveInputTool(this.cfg.inputTool);
    if (tool === 'none') return;
    if (tool === 'powershell') {
      const vk = (action in VKHOT) ? VKHOT[action] : VKMAP[action];
      if (vk != null) psSend(vk, down);
      return;
    }
    if (tool === 'osascript') {
      const k = (action in OSAHOT) ? OSAHOT[action] : OSAMAP[action];
      if (k) { if (k.startsWith('code:')) { if (down) osaSend(k, true); } else osaSend(k, down); }
      return;
    }
    if (tool !== 'xdotool') return;
    const key = (action in HOTKEY) ? HOTKEY[action] : KEYMAP[action];
    if (!key) return;
    const args = inputArgs({ inputTool: 'xdotool' }, key, down, this.emu && this.emu.window);
    if (!args) return;
    try { const p = spawn(args[0], args.slice(1), { stdio: 'ignore' }); p.on('error', () => {}); } catch (e) {}
  }
}

/* ---- module singleton + HTTP routes ---- */
let CFG = null, session = null;
function ensure() { if (!CFG) CFG = config(); if (!session) session = new StreamSession(CFG); return session; }
// public emulator list for /api/library (no host filesystem paths leak to clients)
function listEmulators() {
  return scanEmulators().map(e => ({
    id: e.id, name: e.name, icon: e.icon, needsRom: e.needsRom,
    system: e.system, games: e.games,
  }));
}
function active() { return !!(session && session.running); }

// translate a relayed phone-pad message into a host key press
function injectInput(msg) {
  if (!session || !session.running || !msg) return;
  if (msg.t === 'down' || msg.t === 'up') { session.inject(msg.b, msg.t === 'down'); return; }
  if (msg.t === 'hk') {
    if (msg.a === 'ff_on')  return session.inject('ff_on', true);
    if (msg.a === 'ff_off') return session.inject('ff_off', false);
    if (msg.a === 'save' || msg.a === 'load') {       // tap: press AND release, or the key stays held
      session.inject(msg.a, true);
      setTimeout(() => { try { session.inject(msg.a, false); } catch (e) {} }, 40);
    }
  }
  // the analog stick also arrives as digital up/down/left/right presses, so games
  // stay playable; true analog needs a virtual gamepad (uinput) — a later step
}

function handle(req, res, urlPath, q) {
  if (urlPath === '/stream/video') {
    const s = ensure();
    if (!s.running) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('stream not started'); return true; }
    s.addSubscriber(res); return true;
  }
  if (urlPath === '/stream/start') {
    const s = ensure();
    const id = q.get('emu') || '';
    const emu = scanEmulators().find(e => e.id === id);
    if (!emu) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"unknown emulator"}'); return true; }
    // optional rom: a bare file name inside the emulator's declared roms folder
    let romPath = '';
    const romFile = q.get('rom') || '';
    if (romFile) {
      const bad = !emu.romDir || romFile.includes('/') || romFile.includes('\\') || romFile.includes('..');
      const full = bad ? null : path.join(emu.romDir, romFile);
      if (!full || !fs.existsSync(full)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"unknown game file"}'); return true;
      }
      romPath = full;
    }
    const r = s.start(emu, romPath);
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return true;
  }
  if (urlPath === '/stream/stop') {
    if (session) session.stop();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return true;
  }
  if (urlPath === '/stream/status') {
    const cfg = CFG || config();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: true, running: active(),
      emulator: session && session.emu ? session.emu.name : null,
      viewers: session ? session.subscribers.size : 0,
      capture: resolveCapture(cfg.capture), input: resolveInputTool(cfg.inputTool),
      error: session ? session._err : null }));
    return true;
  }
  return false;
}

module.exports = {
  handle, injectInput, active, listEmulators,
  shutdown() { if (session) session.stop(); stopInjectors(); },
  _internals: { config, scanEmulators, listRoms, captureArgs, tokenize, launchArgs, inputArgs, osaLine,
    defaultCapture, defaultInputTool, resolveCapture, resolveInputTool,
    KEYMAP, HOTKEY, VKMAP, VKHOT, OSAMAP, OSAHOT, JpegSplitter, StreamSession, EMU_DIR },
};

/* ===================  self-test (node stream.js --selftest)  =================== */
if (require.main === module && process.argv.includes('--selftest')) {
  const os = require('os');
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

  ok('captureArgs test', captureArgs(config(), 'test').join(' ').includes('testsrc'));
  ok('captureArgs x11 override', captureArgs(config(), 'x11').includes('x11grab'));
  ok('captureArgs gdigrab (Windows)', captureArgs(config(), 'gdigrab').join(' ').includes('-f gdigrab -framerate 30 -i desktop'));
  ok('captureArgs avfoundation (macOS)', captureArgs(config(), 'avfoundation').join(' ').includes('Capture screen 0:none'));
  ok('captureArgs scales desktop grabs', captureArgs(config(), 'gdigrab').join(' ').includes('scale=1280:-2'));
  ok('captureArgs auto resolves per-OS', captureArgs(config(), 'auto', 'win32').includes('gdigrab')
       && captureArgs(config(), 'auto', 'darwin').includes('avfoundation')
       && captureArgs(config(), 'auto', 'linux').includes('x11grab'));
  ok('resolveInputTool auto per-OS', resolveInputTool('auto', 'win32') === 'powershell'
       && resolveInputTool('auto', 'darwin') === 'osascript' && resolveInputTool('auto', 'linux') === 'xdotool');
  ok('resolveInputTool explicit kept', resolveInputTool('none', 'win32') === 'none');

  ok('launchArgs substitutes {rom}', (launchArgs({ cmd: 'pcsx2 {rom}' }, '/g/x.iso') || []).join(' ') === 'pcsx2 /g/x.iso');
  ok('launchArgs drops empty rom', (launchArgs({ cmd: 'retroarch {rom}' }, '') || []).join(' ') === 'retroarch');
  const winArgs = launchArgs({ cmd: '"C:\\Program Files\\PCSX2\\pcsx2-qt.exe" -fullscreen {rom}' }, 'C:\\games\\a b.iso') || [];
  ok('launchArgs quoted path with spaces', winArgs.length === 3 && winArgs[0] === 'C:\\Program Files\\PCSX2\\pcsx2-qt.exe' && winArgs[2] === 'C:\\games\\a b.iso');
  ok('launchArgs {rom} inside a token', (launchArgs({ cmd: 'xemu --dvd_path={rom}' }, '/g/x.iso') || []).join(' ') === 'xemu --dvd_path=/g/x.iso');

  ok('inputArgs xdotool active window', (inputArgs({ inputTool: 'xdotool' }, 'x', true, '') || []).join(' ') === 'xdotool keydown x');
  ok('inputArgs xdotool by window name', (inputArgs({ inputTool: 'xdotool' }, 'x', true, 'PCSX2') || []).join(' ') === 'xdotool search --name PCSX2 windowfocus keydown x');
  ok('inputArgs none -> null', inputArgs({ inputTool: 'none' }, 'x', true, '') === null);
  ok('keymap A->x B->z', KEYMAP.a === 'x' && KEYMAP.b === 'z');
  ok('hotkey save->F2', HOTKEY.save === 'F2');
  ok('VK map matches layout', VKMAP.a === 0x58 && VKMAP.b === 0x5A && VKMAP.up === 0x26 && VKHOT.save === 0x71);
  ok('osaLine letter down/up', osaLine('x', true) === 'tell application "System Events" to key down "x"'
       && osaLine('x', false) === 'tell application "System Events" to key up "x"');
  ok('osaLine constants + key codes', osaLine('return', true).endsWith('key down return')
       && osaLine('code:120', true).endsWith('key code 120'));

  // scanEmulators against a temp folder (incl. a roms folder)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-'));
  fs.mkdirSync(path.join(tmp, 'emulators', 'pcsx2'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'games', 'ps2'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'games', 'ps2', 'My Game.iso'), 'x');
  fs.writeFileSync(path.join(tmp, 'games', 'ps2', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(tmp, 'emulators', 'pcsx2', 'emulator.json'),
    JSON.stringify({ name: 'PCSX2 (PS2)', cmd: 'pcsx2 {rom}', capture: 'x11', window: 'PCSX2', needsRom: true,
                     system: 'PS2', roms: 'games/ps2', exts: ['.iso', '.chd'] }));
  fs.mkdirSync(path.join(tmp, 'emulators', '_ignored'));   // underscore-prefixed must be skipped
  fs.mkdirSync(path.join(tmp, 'emulators', 'broken'));
  fs.writeFileSync(path.join(tmp, 'emulators', 'broken', 'emulator.json'), '{ not json');
  fs.mkdirSync(path.join(tmp, 'emulators', 'escape'));
  fs.writeFileSync(path.join(tmp, 'emulators', 'escape', 'emulator.json'),
    JSON.stringify({ name: 'esc', cmd: 'x', roms: '../outside' }));
  const emus = scanEmulators(path.join(tmp, 'emulators'), tmp);
  const px = emus.find(e => e.id === 'pcsx2');
  ok('scanEmulators finds valid manifests only', emus.length === 2 && !!px);
  ok('scanEmulators parses capture/window/needsRom', px.capture === 'x11' && px.window === 'PCSX2' && px.needsRom === true);
  ok('scanEmulators lists roms folder games', px.games.length === 1 && px.games[0].file === 'My Game.iso' && px.system === 'PS2');
  ok('scanEmulators blocks roms outside ARCADE', emus.find(e => e.id === 'escape').romDir === null);

  // JPEG splitter across chunk boundaries
  const frames = []; const sp = new JpegSplitter(f => frames.push(f));
  const f1 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]); const f2 = Buffer.from([0xff, 0xd8, 9, 8, 0xff, 0xd9]);
  const all = Buffer.concat([f1, f2]);
  sp.push(all.slice(0, 4)); sp.push(all.slice(4, 9)); sp.push(all.slice(9));
  ok('JpegSplitter 2 frames intact', frames.length === 2 && frames[0].equals(f1) && frames[1].equals(f2));

  // MJPEG multipart fan-out
  const sess = new StreamSession(config()); const chunks = [];
  sess.addSubscriber({ writeHead() {}, write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); }, end() {}, on() {} });
  sess._broadcast(f1);
  const blob = Buffer.concat(chunks).toString('latin1');
  ok('MJPEG boundary + content-length', blob.includes('--' + BOUNDARY) && blob.includes('Content-Length: 7'));

  let threw = false; try { injectInput({ t: 'down', b: 'a' }); injectInput({ t: 'hk', a: 'save' }); } catch (e) { threw = true; }
  ok('injectInput safe when idle', !threw);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
