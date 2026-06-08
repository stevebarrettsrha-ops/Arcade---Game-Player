/* ============================================================
   ARCADE — host-side streaming mode (OPT-IN, experimental)
   ------------------------------------------------------------
   Instead of every TV/phone running the emulator in its own browser (WASM),
   the HOST (e.g. a Steam Deck / mini-PC) runs the REAL native emulator with all
   its capabilities, and ARCADE streams the picture to the clients as MJPEG,
   shown inside an iframe. Clients just display the video and send button
   presses — so weak TVs do almost no work, and you get the heavy / "impossible"
   systems (PS2, GameCube/Wii, PS3, proper N64/PSP) a browser can't do.

   HOW EMULATORS ARE REGISTERED
   Drop one folder per emulator into  emulators/<name>/  with a manifest:
       emulators/pcsx2/emulator.json
       {
         "name":    "PCSX2 (PS2)",
         "cmd":     "flatpak run net.pcsx2.PCSX2 {rom}",
         "capture": "x11",          // x11 | kms | test
         "window":  "PCSX2",        // window title (for input focus); optional
         "needsRom": true            // does cmd use {rom}?
       }
   ARCADE lists every emulator it finds; picking one launches it on the host and
   streams it into the iframe. A same-named icon.png in the folder is used as art.

   Loaded ONLY when ARCADE_STREAM=1, so normal browser mode is untouched. It
   shells out to host programs you install yourself (ffmpeg for capture/encode,
   xdotool for input on X11) — see SETUP-STREAMING.md.

   Logic self-test (no ffmpeg/emulator needed):  node stream.js --selftest
   ============================================================ */
'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const EMU_DIR = path.join(__dirname, 'emulators');

/* ---- global capture/encode defaults (overridable via env) ---- */
function config() {
  const e = process.env;
  return {
    capture:   e.ARCADE_STREAM_CAPTURE || 'test',   // default 'test' proves the pipeline w/o a game
    display:   e.ARCADE_STREAM_DISPLAY || ':0',
    size:      e.ARCADE_STREAM_SIZE    || '1280x720',
    fps:       e.ARCADE_STREAM_FPS     || '30',
    quality:   e.ARCADE_STREAM_QUALITY || '6',        // ffmpeg mjpeg -q:v (2 best .. 31 worst)
    ffmpeg:    e.ARCADE_STREAM_FFMPEG  || 'ffmpeg',
    inputTool: e.ARCADE_STREAM_INPUT   || 'none',      // 'none' | 'xdotool'
  };
}

/* ---- scan the emulators/ folder for manifests (pure-ish, testable via dir arg) ---- */
function scanEmulators(dir) {
  dir = dir || EMU_DIR;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const mf = path.join(dir, name, 'emulator.json');
    let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) { continue; }
    if (!m || !m.cmd) continue;
    out.push({
      id: name,
      name: String(m.name || name),
      cmd: String(m.cmd),
      capture: m.capture || null,
      window: m.window || '',
      needsRom: !!m.needsRom,
      icon: fs.existsSync(path.join(dir, name, 'icon.png')) ? '/emulators/' + encodeURIComponent(name) + '/icon.png' : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- ffmpeg capture+encode args -> concatenated-JPEG stream on stdout (pure) ---- */
function captureArgs(cfg, capture) {
  capture = capture || cfg.capture;
  const a = ['-loglevel', 'error'];
  if (capture === 'x11') {
    a.push('-f', 'x11grab', '-video_size', cfg.size, '-framerate', cfg.fps, '-i', cfg.display);
  } else if (capture === 'kms') {
    a.push('-f', 'kmsgrab', '-framerate', cfg.fps, '-i', '-');     // advanced; see docs
  } else {                                                          // 'test'
    a.push('-f', 'lavfi', '-i', `testsrc=size=${cfg.size}:rate=${cfg.fps}`);
  }
  a.push('-vf', 'format=yuvj420p', '-c:v', 'mjpeg', '-q:v', String(cfg.quality), '-f', 'image2pipe', '-');
  return a;
}

/* ---- emulator launch args from a manifest cmd (pure) ---- */
function launchArgs(emu, romPath) {
  if (!emu || !emu.cmd) return null;
  return emu.cmd.split(' ').filter(Boolean).map(p => p === '{rom}' ? (romPath || '') : p).filter(Boolean);
}

/* ---- controller -> RetroArch-style default keyboard mapping (pure) ---- */
const KEYMAP = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  b: 'z', a: 'x', y: 'a', x: 's', l: 'q', r: 'w', l2: 'e', r2: 't',
  start: 'Return', select: 'shift',
};
const HOTKEY = { save: 'F2', load: 'F4', ff_on: 'space', ff_off: 'space' };

function inputArgs(cfg, key, down, window) {
  if (cfg.inputTool !== 'xdotool') return null;
  const act = down ? 'keydown' : 'keyup';
  // focus the emulator window by title first if we know it, else send to the active window
  if (window) return ['xdotool', 'search', '--name', window, 'windowfocus', act, key];
  return ['xdotool', act, key];
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
    const key = (action in HOTKEY) ? HOTKEY[action] : KEYMAP[action];
    if (!key) return;
    const args = inputArgs(this.cfg, key, down, this.emu && this.emu.window);
    if (!args) return;
    try { const p = spawn(args[0], args.slice(1), { stdio: 'ignore' }); p.on('error', () => {}); } catch (e) {}
  }
}

/* ---- module singleton + HTTP routes ---- */
let CFG = null, session = null;
function ensure() { if (!CFG) CFG = config(); if (!session) session = new StreamSession(CFG); return session; }
function listEmulators() { return scanEmulators(); }
function active() { return !!(session && session.running); }

// translate a relayed phone-pad message into a host key press
function injectInput(msg) {
  if (!session || !session.running || !msg) return;
  if (msg.t === 'down' || msg.t === 'up') session.inject(msg.b, msg.t === 'down');
  else if (msg.t === 'hk') session.inject(msg.a === 'ff_off' ? 'ff_off' : msg.a, msg.a !== 'ff_off');
  // analog 'axis' needs a uinput virtual gamepad — out of scope for v1 (see docs)
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
    const r = s.start(emu, q.get('rom') || '');
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return true;
  }
  if (urlPath === '/stream/stop') {
    if (session) session.stop();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return true;
  }
  if (urlPath === '/stream/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: true, running: active(),
      emulator: session && session.emu ? session.emu.name : null,
      viewers: session ? session.subscribers.size : 0,
      input: (CFG || config()).inputTool, error: session ? session._err : null }));
    return true;
  }
  return false;
}

module.exports = {
  handle, injectInput, active, listEmulators,
  shutdown() { if (session) session.stop(); },
  _internals: { config, scanEmulators, captureArgs, launchArgs, inputArgs, KEYMAP, HOTKEY, JpegSplitter, StreamSession, EMU_DIR },
};

/* ===================  self-test (node stream.js --selftest)  =================== */
if (require.main === module && process.argv.includes('--selftest')) {
  const os = require('os');
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

  ok('captureArgs test', captureArgs(config()).join(' ').includes('testsrc'));
  ok('captureArgs x11 override', captureArgs(config(), 'x11').includes('x11grab'));
  ok('launchArgs substitutes {rom}', (launchArgs({ cmd: 'pcsx2 {rom}' }, '/g/x.iso') || []).join(' ') === 'pcsx2 /g/x.iso');
  ok('launchArgs drops empty rom', (launchArgs({ cmd: 'retroarch {rom}' }, '') || []).join(' ') === 'retroarch');
  ok('inputArgs xdotool active window', (inputArgs({ inputTool: 'xdotool' }, 'x', true, '') || []).join(' ') === 'xdotool keydown x');
  ok('inputArgs xdotool by window name', (inputArgs({ inputTool: 'xdotool' }, 'x', true, 'PCSX2') || []).join(' ') === 'xdotool search --name PCSX2 windowfocus keydown x');
  ok('inputArgs none -> null', inputArgs({ inputTool: 'none' }, 'x', true, '') === null);
  ok('keymap A->x B->z', KEYMAP.a === 'x' && KEYMAP.b === 'z');
  ok('hotkey save->F2', HOTKEY.save === 'F2');

  // scanEmulators against a temp folder
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-'));
  fs.mkdirSync(path.join(tmp, 'pcsx2'));
  fs.writeFileSync(path.join(tmp, 'pcsx2', 'emulator.json'), JSON.stringify({ name: 'PCSX2 (PS2)', cmd: 'pcsx2 {rom}', capture: 'x11', window: 'PCSX2', needsRom: true }));
  fs.mkdirSync(path.join(tmp, '_ignored'));   // underscore-prefixed must be skipped
  fs.mkdirSync(path.join(tmp, 'broken'));
  fs.writeFileSync(path.join(tmp, 'broken', 'emulator.json'), '{ not json');
  const emus = scanEmulators(tmp);
  ok('scanEmulators finds valid manifest only', emus.length === 1 && emus[0].id === 'pcsx2' && emus[0].name === 'PCSX2 (PS2)');
  ok('scanEmulators parses capture/window/needsRom', emus[0].capture === 'x11' && emus[0].window === 'PCSX2' && emus[0].needsRom === true);

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

  let threw = false; try { injectInput({ t: 'down', b: 'a' }); } catch (e) { threw = true; }
  ok('injectInput safe when idle', !threw);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
