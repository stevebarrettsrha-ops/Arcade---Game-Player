/* ============================================================
   ARCADE — host-side streaming mode (OPT-IN)
   ------------------------------------------------------------
   Instead of every TV/phone running the emulator in its own browser (WASM),
   the HOST (a gaming PC / Steam Deck / mini-PC) runs the REAL native emulator
   with all its capabilities, and ARCADE streams it to the clients inside an
   iframe. Two transports, picked per client automatically:
     • H.264 + AAC muxed into fragmented MP4, played via Media Source
       Extensions in a <video> — one synced A/V stream (true lip-sync), low
       bandwidth. The default on modern browsers.
     • MJPEG (an <img>) + raw-PCM audio over a second stream, played via Web
       Audio — the universal fallback for old TV browsers without MSE.
   Clients just show the stream and send button presses from pad.html — so
   weak TVs do almost no work, and you get the heavy / "impossible" systems
   (PS2, original XBOX, GameCube/Wii, PS3, flawless N64/PSP) a browser can't do.

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
const { spawn, spawnSync } = require('child_process');
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
  platform = platform || process.platform;
  if (!capture || capture === 'auto') return defaultCapture(platform);
  // "window" = grab just the emulator's window instead of the whole desktop.
  // Only Windows (gdigrab) can do this by title; elsewhere fall back to the
  // desktop grabber (best-effort) so something still streams.
  if (capture === 'window') return platform === 'win32' ? 'window' : defaultCapture(platform);
  return capture;
}
function resolveInputTool(tool, platform) {
  return (!tool || tool === 'auto') ? defaultInputTool(platform) : tool;
}
// Windows virtual Xbox 360 pad (ViGEmBus). Needs ViGEmClient.dll alongside the
// app (or via ARCADE_VIGEM_DLL). When present we drive a real controller instead
// of faking keystrokes — every host emulator detects an Xbox pad natively, so
// analog + all buttons work with no per-emulator key mapping.
let _vigemDll = null;
function findVigemDll() {
  if (_vigemDll !== null) return _vigemDll;
  _vigemDll = '';
  if (process.platform !== 'win32') return _vigemDll;
  const cands = [ process.env.ARCADE_VIGEM_DLL,
    path.join(ROOT, 'ViGEmClient.dll'), path.join(ROOT, 'assets', 'ViGEmClient.dll'),
    path.join(EMU_DIR, 'ViGEmClient.dll') ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) { _vigemDll = c; break; } } catch (e) {} }
  return _vigemDll;
}
// Resolve the requested input mode: an explicit choice always wins; "auto" on
// Windows upgrades to the virtual gamepad when ViGEmClient.dll is available.
function pickInputTool(req) {
  if (req && req !== 'auto') return req;
  if (process.platform === 'win32' && findVigemDll()) return 'gamepad';
  return 'auto';
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
    inputTool: pickInputTool(e.ARCADE_STREAM_INPUT || 'auto'), // auto | gamepad | xdotool | powershell | osascript | none
    // transport: 'auto' lets each client pick — H.264 (synced A/V, MSE) on capable
    //   browsers, MJPEG+PCM on old TVs. 'mjpeg' forces the legacy path; 'h264'
    //   forces the muxed path (no MJPEG fallback served).
    mode:        e.ARCADE_STREAM_MODE         || 'auto',  // auto | mjpeg | h264
    vbitrate:    e.ARCADE_STREAM_VBITRATE     || '6M',    // H.264 target bitrate
    // audio: capture the host's sound. In MJPEG mode it streams as raw PCM over
    //   HTTP; in H.264 mode it's muxed into the video (true lip-sync).
    //   'auto' = the OS's default audio grabber, 'none' = silent, or a format name
    //   (pulse | alsa | dshow | avfoundation) — pair with ARCADE_STREAM_AUDIO_DEVICE.
    audio:       e.ARCADE_STREAM_AUDIO        || 'auto',
    audioDevice: e.ARCADE_STREAM_AUDIO_DEVICE || '',  // override the input device/source
    audioRate:   e.ARCADE_STREAM_AUDIO_RATE   || '48000',
  };
}

/* ---- per-OS audio capture defaults (pure, testable via the platform arg) ----
   System-audio capture is host-specific, so these are best-effort defaults that
   the user overrides with ARCADE_STREAM_AUDIO / ARCADE_STREAM_AUDIO_DEVICE:
     Linux  : PulseAudio/PipeWire. "default" is whatever Pulse's default source is;
              to capture GAME sound, point ARCADE_STREAM_AUDIO_DEVICE at the sink
              monitor (e.g. "alsa_output...analog-stereo.monitor" — find it with
              `pactl list sources short`).
     Windows: DirectShow. "Stereo Mix" captures the speakers if it's enabled in
              Sound > Recording; otherwise install a virtual cable and name it.
     macOS   : avfoundation can't grab system audio natively — install a loopback
              device (e.g. BlackHole) and select it; ":default" uses the default. */
function defaultAudioInput(platform) {
  platform = platform || process.platform;
  if (platform === 'win32')  return { fmt: 'dshow',        dev: 'audio=Stereo Mix' };
  if (platform === 'darwin') return { fmt: 'avfoundation', dev: ':default' };
  return { fmt: 'pulse', dev: 'default' };
}
function resolveAudio(cfg, platform) {
  if (!cfg.audio || cfg.audio === 'none') return null;
  const def = defaultAudioInput(platform);
  const fmt = cfg.audio === 'auto' ? def.fmt : cfg.audio;
  const dev = cfg.audioDevice || def.dev;
  return { fmt, dev, rate: String(cfg.audioRate || '48000'), channels: 2 };
}
/* ffmpeg args: capture the audio device -> raw signed-16 little-endian PCM on stdout.
   Raw PCM needs no decoder in the browser (Web Audio plays it directly) and stays
   sample-accurate across chunk boundaries, which keeps latency low on WiFi. */
function audioCaptureArgs(cfg, platform) {
  const a = resolveAudio(cfg, platform);
  if (!a) return null;
  return ['-loglevel', 'error', '-f', a.fmt, '-i', a.dev,
    '-ac', String(a.channels), '-ar', a.rate, '-f', 's16le', '-'];
}

/* ---- the video grabber input args, shared by MJPEG and the H.264 mux (pure) ---- */
function videoInputArgs(cfg, capture, window) {
  const a = [];
  let scale = false;
  if (capture === 'window') {
    // Windows single-window capture: gdigrab grabs only the emulator window by
    // its title, so the stream shows the game — not the whole desktop (which
    // otherwise mirrors the browser showing the stream). Needs the exact title;
    // if we don't know it, fall back to a desktop grab so the picture survives.
    a.push('-f', 'gdigrab', '-framerate', cfg.fps, '-i', window ? 'title=' + window : 'desktop'); scale = true;
  } else if (capture === 'x11') {
    a.push('-f', 'x11grab', '-video_size', cfg.size, '-framerate', cfg.fps, '-i', cfg.display);
  } else if (capture === 'gdigrab') {
    a.push('-f', 'gdigrab', '-framerate', cfg.fps, '-i', 'desktop'); scale = true;
  } else if (capture === 'avfoundation') {
    const dev = /^[:]/.test(cfg.display) ? 'Capture screen 0' : cfg.display;
    a.push('-f', 'avfoundation', '-capture_cursor', '1', '-framerate', cfg.fps, '-i', dev + ':none'); scale = true;
  } else if (capture === 'kms') {
    a.push('-f', 'kmsgrab', '-framerate', cfg.fps, '-i', '-');
  } else {
    a.push('-f', 'lavfi', '-i', `testsrc=size=${cfg.size}:rate=${cfg.fps}`);
  }
  return { args: a, scale };
}

/* ---- H.264 + AAC muxed to fragmented MP4 on stdout (pure) ----
   ONE ffmpeg grabs screen + sound and muxes them into a single low-latency fMP4
   stream, so video and audio share a timeline (true lip-sync). Played in the
   browser via Media Source Extensions. `noAudio` lets the session retry
   video-only if the audio device wedges the encoder. The fragment settings
   (empty_moov + frag_keyframe + default_base_moof, short frag_duration) are what
   MSE needs to start instantly and stay near the live edge. */
function muxArgs(cfg, capture, platform, noAudio, window) {
  capture = resolveCapture(capture || cfg.capture, platform);
  const vin = videoInputArgs(cfg, capture, window);
  const a = ['-loglevel', 'error', '-fflags', 'nobuffer', ...vin.args];
  const au = noAudio ? null : resolveAudio(cfg, platform);
  if (au) a.push('-f', au.fmt, '-i', au.dev);
  const fps = Math.max(1, parseInt(cfg.fps, 10) || 30);
  const width = parseInt(cfg.size, 10) || 1280;
  a.push('-map', '0:v:0');
  if (au) a.push('-map', '1:a:0');
  a.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', String(fps),
    '-b:v', cfg.vbitrate, '-maxrate', cfg.vbitrate, '-bufsize', cfg.vbitrate);
  if (vin.scale) a.push('-vf', `scale=${width}:-2`);
  if (au) a.push('-c:a', 'aac', '-b:a', '128k', '-ar', au.rate, '-ac', String(au.channels));
  a.push('-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '200000', 'pipe:1');
  return a;
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
function captureArgs(cfg, capture, platform, window) {
  capture = resolveCapture(capture || cfg.capture, platform);
  const vin = videoInputArgs(cfg, capture, window);
  const width = parseInt(cfg.size, 10) || 1280;
  const a = ['-loglevel', 'error', ...vin.args];
  // full-desktop/window grabs are scaled down to the target width (keeps aspect, saves WiFi bandwidth)
  const vf = vin.scale ? `scale=${width}:-2,format=yuvj420p` : 'format=yuvj420p';
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
// human, actionable reason when an emulator won't launch (pure, for tests too)
function launchErrorMessage(exe, err, id) {
  if (err && err.code === 'ENOENT') {
    return 'Couldn\'t run "' + exe + '". The program isn\'t there — install it at that ' +
      'path, or fix "cmd" in emulators/' + (id || '?') + '/emulator.json (or run fix-emulator-paths).';
  }
  return 'Couldn\'t launch the emulator: ' + ((err && err.message) || 'unknown error') + '.';
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

// Left analog stick on the KEYBOARD paths -> its OWN keys (U/N/H/M), held while
// the stick is pushed past ATHRESH. Separate from the D-pad arrows (which the
// stick also drives), so you can bind the emulator's analog stick to these and
// the cross D-pad to the arrows. Chosen to not collide with any mapping above
// on Windows, Linux or macOS. (The gamepad path uses true analog instead.)
const AKEYMAP = { up: 'u', down: 'n', left: 'h', right: 'm' };   // xdotool / generic
const AVKMAP  = { up: 0x55, down: 0x4E, left: 0x48, right: 0x4D }; // Windows VK: U N H M
const AOSAMAP = { up: 'u', down: 'n', left: 'h', right: 'm' };   // macOS (holdable letters)
const ATHRESH = 0.5;   // stick magnitude past which a direction counts as pressed

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
      psProc.stdin.on('error', () => { psProc = null; });   // swallow async EPIPE
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
      osaProc.stdin.on('error', () => { osaProc = null; });   // swallow async EPIPE
    } catch (e) { osaProc = null; return; }
  }
  try { osaProc.stdin.write(osaLine(key, down) + '\n'); } catch (e) { osaProc = null; }
}
// Virtual Xbox pad helper (Windows / ViGEmBus). One persistent PowerShell that
// holds the controller open; we stream it tiny lines: "b <name> <0|1>" for a
// button, "a <lx> <ly>" for the left analog stick (floats -1..1). If the helper
// can't run (driver missing, DLL/arch mismatch, ...) it exits; we capture why,
// mark the pad dead, and callers transparently fall back to the keyboard path.
let gpProc = null, gpDead = false, gpSpawnAt = 0, gpKilling = false, gpErrBuf = '';
function gamepadDead() { return gpDead; }
// returns true if the line was handed to a live helper, false if the pad is
// unavailable (so the caller can fall back without ever seeing an EPIPE).
function gpSend(line) {
  if (gpDead) return false;
  if (!gpProc) {
    const dll = findVigemDll();
    try {
      gpSpawnAt = Date.now(); gpKilling = false; gpErrBuf = '';
      gpProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(ROOT, 'stream-gamepad.ps1')],
        { stdio: ['pipe', 'ignore', 'pipe'], env: Object.assign({}, process.env, dll ? { ARCADE_VIGEM_DLL: dll } : {}) });
      gpProc.on('error', () => { gpProc = null; });
      gpProc.stdin.on('error', () => { gpProc = null; });   // swallow async EPIPE
      if (gpProc.stderr) gpProc.stderr.on('data', d => { if (gpErrBuf.length < 2000) gpErrBuf += d.toString(); });
      gpProc.on('close', () => {
        const quick = Date.now() - gpSpawnAt < 6000;        // fell over on its own?
        gpProc = null;
        if (gpKilling || !quick) return;                     // we asked it to stop, or it ran fine
        gpDead = true;                                        // stop using the pad this run
        if (process.platform === 'win32') {
          const why = gpErrBuf.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || 'helper exited';
          console.warn('\n  [gamepad] Virtual Xbox controller unavailable: ' + why +
            '\n  Check the ViGEmBus driver is installed (SETUP-STREAMING.txt section 4a),' +
            '\n  then restart. Falling back to keyboard input for now.\n');
        }
      });
    } catch (e) { gpProc = null; gpDead = true; return false; }
  }
  try { gpProc.stdin.write(line + '\n'); return true; } catch (e) { gpProc = null; return false; }
}
function stopInjectors() {
  gpKilling = true;   // stays set until the next gpSend spawn, so the close below is ignored
  for (const p of [psProc, osaProc, gpProc]) { if (p) { try { p.kill('SIGTERM'); } catch (e) {} } }
  psProc = osaProc = gpProc = null;
}

/* ---- resolve the EXACT window title gdigrab needs (Windows) ----
   The manifest's "window" is a hint (e.g. "Project64"); the live window usually
   appends the game ("Conker's Bad Fur Day - Project64"). gdigrab title= needs
   the full string, so ask Windows for the first visible window whose title
   contains the hint. Returns the exact title, or '' if none is found yet. */
function resolveWindowTitle(hint, platform) {
  platform = platform || process.platform;
  if (!hint || platform !== 'win32') return '';
  const like = '*' + String(hint).replace(/'/g, "''") + '*';
  const script = "Get-Process | Where-Object { $_.MainWindowTitle -like '" + like +
    "' } | Sort-Object StartTime -Descending | Select-Object -First 1 -ExpandProperty MainWindowTitle";
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const title = (r.stdout || '').replace(/\r?\n/g, '').trim();
    return title;
  } catch (e) { return ''; }
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

/* ---- fragmented-MP4 box splitter: turns ffmpeg's fMP4 stdout into the init
   segment (ftyp+moov) plus discrete media fragments (moof+mdat) ----
   The init segment is cached so late joiners can be sent it first, then whole
   fragments — which is exactly what an MSE SourceBuffer needs. (testable) */
class Fmp4Splitter {
  constructor(onInit, onFragment) {
    this.buf = Buffer.alloc(0); this.onInit = onInit; this.onFragment = onFragment;
    this.gotInit = false; this.initParts = []; this.frag = null;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 8) return;
      let size = this.buf.readUInt32BE(0), headerLen = 8;
      const type = this.buf.toString('latin1', 4, 8);
      if (size === 1) { if (this.buf.length < 16) return; size = Number(this.buf.readBigUInt64BE(8)); headerLen = 16; }
      if (size < headerLen || size > (64 << 20)) { this.buf = Buffer.alloc(0); return; }   // corrupt: resync
      if (this.buf.length < size) return;                       // wait for the whole box
      const box = this.buf.slice(0, size);
      this.buf = this.buf.slice(size);
      this._box(type, box);
    }
  }
  _box(type, box) {
    if (!this.gotInit) {
      if (type === 'moof') { this.gotInit = true; this.onInit(Buffer.concat(this.initParts)); this.initParts = null; this.frag = [box]; }
      else this.initParts.push(box);                            // ftyp, moov, ...
      return;
    }
    if (type === 'moof') { this.frag = [box]; }
    else if (type === 'mdat') { if (this.frag) { this.frag.push(box); this.onFragment(Buffer.concat(this.frag)); this.frag = null; } }
    else if (this.frag) { this.frag.push(box); }
  }
}
/* the codecs string MSE needs, derived from what's actually in the init segment.
   Video is forced to constrained-baseline H.264 (avc1.42E01E — the most widely
   MSE-supported profile); audio is AAC-LC (mp4a.40.2) only if a track is present. */
const VIDEO_CODEC = 'avc1.42E01E';
function codecsFromInit(initBuf, videoCodec) {
  videoCodec = videoCodec || VIDEO_CODEC;
  const hasAudio = initBuf && initBuf.indexOf('mp4a', 0, 'latin1') >= 0;
  return hasAudio ? videoCodec + ',mp4a.40.2' : videoCodec;
}

/* ---- one capture session, fanned out to many browser iframes via MJPEG ---- */
const BOUNDARY = 'arcadeframe';
class StreamSession {
  constructor(cfg) {
    this.cfg = cfg; this.emu = null; this.romPath = ''; this.active = false;
    this._err = null; this._audioErr = null; this._muxErr = null;
    // MJPEG video pipeline (started lazily by the first /stream/video viewer)
    this.subscribers = new Set(); this.ffmpeg = null; this.lastFrame = null;
    // raw-PCM audio pipeline (MJPEG fallback path)
    this.audioSubs = new Set(); this.audio = null;
    // muxed H.264+AAC fMP4 pipeline (MSE clients)
    this.muxSubs = new Set(); this.mux = null; this.muxInit = null; this.muxCodecs = null;
    this._muxWaiters = []; this._muxNoAudio = false;
  }
  // start only LAUNCHES the emulator and arms the session; the capture pipelines
  // spin up on demand when a client subscribes, and shut down when the last one
  // leaves — so we never encode a format nobody is watching.
  start(emu, romPath) {
    this.stop();
    this.emu = emu; this.romPath = romPath || '';
    this._err = this._audioErr = this._muxErr = null;
    if (emu && emu.cmd) {
      const la = launchArgs(emu, romPath);
      if (la && la.length) {
        const exe = la[0];
        // Always TRY to launch — the real spawn is the source of truth. (We used
        // to pre-check the file with existsSync, but that could false-negative a
        // program that is actually installed and wrongly block it.) If the spawn
        // fails, the 'error' event records a clear reason that the page surfaces.
        try {
          this.emulator = spawn(la[0], la.slice(1), { stdio: 'ignore' });
          this.emulator.on('error', e => { this._err = launchErrorMessage(exe, e, emu.id); });
        } catch (e) {
          this._err = launchErrorMessage(exe, e, emu.id);
        }
      }
    }
    this.active = true;
    return { ok: true, error: this._err || undefined };
  }
  stop() {
    this.active = false;
    for (const p of [this.ffmpeg, this.emulator, this.audio, this.mux]) { if (p) { try { p.kill('SIGTERM'); } catch (e) {} } }
    this.ffmpeg = this.emulator = this.audio = this.mux = null;
    for (const set of [this.subscribers, this.audioSubs, this.muxSubs]) { for (const res of set) { try { res.end(); } catch (e) {} } set.clear(); }
    for (const res of this._muxWaiters) { try { res.end(); } catch (e) {} }
    this._muxWaiters = []; this.muxInit = this.muxCodecs = null; this.lastFrame = null; this._muxNoAudio = false;
    this._winTitle = null;   // re-resolve the capture window for the next game
    this._analog = null;     // drop any held analog-stick direction state
  }
  audioEnabled() { return !!audioCaptureArgs(this.cfg); }
  muxEnabled() { return this.cfg.mode !== 'mjpeg'; }
  mjpegEnabled() { return this.cfg.mode !== 'h264'; }
  // the window title for single-window ("window") capture, resolved + cached
  // for this run. Empty unless the emulator asked for window capture on Windows.
  _capWindow() {
    if (resolveCapture(this.emu && this.emu.capture || this.cfg.capture) !== 'window') return '';
    if (this._winTitle == null) this._winTitle = resolveWindowTitle(this.emu && this.emu.window) || (this.emu && this.emu.window) || '';
    return this._winTitle;
  }

  /* ---------- MJPEG video ---------- */
  _ensureVideo() {
    if (this.ffmpeg || !this.active) return;
    const splitter = new JpegSplitter(f => { this.lastFrame = f; this._broadcast(f); });
    try { this.ffmpeg = spawn(this.cfg.ffmpeg, captureArgs(this.cfg, this.emu && this.emu.capture, undefined, this._capWindow()), { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this._err = 'ffmpeg: ' + e.message; this.ffmpeg = null; return; }
    this.ffmpeg.stdout.on('data', d => splitter.push(d));
    this.ffmpeg.stderr.on('data', d => { this._err = d.toString().trim().slice(0, 160); });
    this.ffmpeg.on('error', e => { this._err = 'ffmpeg: ' + e.message; this.ffmpeg = null; });
    this.ffmpeg.on('close', () => { this.ffmpeg = null; });
  }
  addSubscriber(res) {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY,
      'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'Connection': 'close' });
    this.subscribers.add(res);
    if (this.lastFrame) this._write(res, this.lastFrame);
    res.on('close', () => { this.subscribers.delete(res); if (!this.subscribers.size && this.ffmpeg) { try { this.ffmpeg.kill('SIGTERM'); } catch (e) {} this.ffmpeg = null; } });
    this._ensureVideo();
  }
  _write(res, jpeg) {
    try {
      res.write('--' + BOUNDARY + '\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n');
      res.write(jpeg); res.write('\r\n');
    } catch (e) { this.subscribers.delete(res); }
  }
  _broadcast(jpeg) { for (const res of this.subscribers) this._write(res, jpeg); }

  /* ---------- raw-PCM audio (for the MJPEG path) ---------- */
  _ensureAudio() {
    if (this.audio || !this.active) return;
    const args = audioCaptureArgs(this.cfg);
    if (!args) return;
    try { this.audio = spawn(this.cfg.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this._audioErr = 'audio: ' + e.message; this.audio = null; return; }
    this.audio.stdout.on('data', d => this._broadcastAudio(d));
    this.audio.stderr.on('data', d => { this._audioErr = d.toString().trim().slice(0, 160); });
    this.audio.on('error', e => { this._audioErr = 'audio: ' + e.message; this.audio = null; });
    this.audio.on('close', () => { this.audio = null; });
  }
  addAudioSubscriber(res) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'Connection': 'close',
      'X-Audio-Rate': String(this.cfg.audioRate || '48000'), 'X-Audio-Channels': '2' });
    this.audioSubs.add(res);
    res.on('close', () => { this.audioSubs.delete(res); if (!this.audioSubs.size && this.audio) { try { this.audio.kill('SIGTERM'); } catch (e) {} this.audio = null; } });
    this._ensureAudio();
  }
  _broadcastAudio(buf) { for (const res of this.audioSubs) { try { res.write(buf); } catch (e) { this.audioSubs.delete(res); } } }

  /* ---------- muxed H.264 + AAC (fragmented MP4 over MSE) ---------- */
  _ensureMux() {
    if (this.mux || !this.active || !this.muxEnabled()) return;
    const noAudio = this._muxNoAudio;
    let proc;
    try { proc = spawn(this.cfg.ffmpeg, muxArgs(this.cfg, this.emu && this.emu.capture, undefined, noAudio, this._capWindow()), { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { this._muxErr = 'mux: ' + e.message; return; }
    this.mux = proc; this.muxInit = null; this.muxCodecs = null;
    const startedAt = Date.now();
    const splitter = new Fmp4Splitter(
      init => { this.muxInit = init; this.muxCodecs = codecsFromInit(init); this._flushMuxWaiters(); },
      frag => { for (const res of this.muxSubs) { try { res.write(frag); } catch (e) { this.muxSubs.delete(res); } } });
    proc.stdout.on('data', d => splitter.push(d));
    proc.stderr.on('data', d => { this._muxErr = d.toString().trim().slice(0, 160); });
    proc.on('error', e => { this._muxErr = 'mux: ' + e.message; this.mux = null; });
    proc.on('close', () => {
      this.mux = null;
      // if the encoder died almost immediately and audio was in the mix, the audio
      // device is the likely culprit — retry once, video-only, so the picture survives.
      if (Date.now() - startedAt < 2500 && !noAudio && resolveAudio(this.cfg) && (this.muxSubs.size || this._muxWaiters.length)) {
        this._muxNoAudio = true; this._ensureMux();
      } else { this._failMuxWaiters(); }
    });
  }
  addMuxSubscriber(res) {
    if (!this.active || !this.muxEnabled()) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('no mux'); return; }
    this._ensureMux();
    if (this.muxInit) return this._sendMuxInit(res);
    this._muxWaiters.push(res);
    res._muxTimer = setTimeout(() => { this._dropWaiter(res); try { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('mux timeout'); } catch (e) {} }, 8000);
    res.on('close', () => this._dropWaiter(res));
  }
  _sendMuxInit(res) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Codecs': this.muxCodecs || VIDEO_CODEC,
      'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'Connection': 'close' });
    try { res.write(this.muxInit); } catch (e) { return; }
    this.muxSubs.add(res);
    res.on('close', () => { this.muxSubs.delete(res); if (!this.muxSubs.size && !this._muxWaiters.length && this.mux) { try { this.mux.kill('SIGTERM'); } catch (e) {} this.mux = null; this.muxInit = this.muxCodecs = null; this._muxNoAudio = false; } });
  }
  _flushMuxWaiters() { const w = this._muxWaiters; this._muxWaiters = []; for (const res of w) { clearTimeout(res._muxTimer); this._sendMuxInit(res); } }
  _failMuxWaiters() { const w = this._muxWaiters; this._muxWaiters = []; for (const res of w) { clearTimeout(res._muxTimer); try { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('mux failed'); } catch (e) {} } }
  _dropWaiter(res) { const i = this._muxWaiters.indexOf(res); if (i >= 0) this._muxWaiters.splice(i, 1); clearTimeout(res._muxTimer); }

  // effective input tool: a requested-but-dead virtual pad degrades to keyboard
  _tool() {
    const t = resolveInputTool(this.cfg.inputTool);
    return (t === 'gamepad' && gamepadDead()) ? 'powershell' : t;
  }
  inject(action, down) {
    let tool = this._tool();
    if (tool === 'none') return;
    if (tool === 'gamepad') {
      // save/load/fast-forward have no pad button -> send them as keyboard keys
      if (action in VKHOT) { psSend(VKHOT[action], down); return; }
      if (gpSend('b ' + action + ' ' + (down ? 1 : 0))) return;
      tool = 'powershell';   // pad helper just died -> fall back this event
    }
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
  // one analog-stick direction key (separate from the D-pad) for the keyboard paths
  _analogKey(dir, down) {
    const tool = this._tool();
    if (tool === 'powershell') { const vk = AVKMAP[dir]; if (vk != null) psSend(vk, down); return; }
    if (tool === 'osascript')  { const k = AOSAMAP[dir]; if (k) osaSend(k, down); return; }
    if (tool === 'xdotool') {
      const args = inputArgs({ inputTool: 'xdotool' }, AKEYMAP[dir], down, this.emu && this.emu.window);
      if (args) { try { const p = spawn(args[0], args.slice(1), { stdio: 'ignore' }); p.on('error', () => {}); } catch (e) {} }
    }
  }
  // left analog stick. Gamepad path = true analog; keyboard paths = held U/N/H/M
  // keys (its own set, so the stick is independent of the D-pad arrows).
  injectAxis(x, y) {
    let tool = this._tool();
    if (tool === 'none') return;
    if (tool === 'gamepad') {
      const cl = v => Math.max(-1, Math.min(1, +v || 0));
      if (gpSend('a ' + cl(x).toFixed(3) + ' ' + cl(y).toFixed(3))) return;
      tool = 'powershell';   // pad helper just died -> fall back to U/N/H/M keys
    }
    x = +x || 0; y = +y || 0;
    const want = { up: y < -ATHRESH, down: y > ATHRESH, left: x < -ATHRESH, right: x > ATHRESH };
    const st = this._analog || (this._analog = { up: false, down: false, left: false, right: false });
    for (const d of ['up', 'down', 'left', 'right']) {
      if (want[d] !== st[d]) { st[d] = want[d]; this._analogKey(d, want[d]); }
    }
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
function active() { return !!(session && session.active); }

// translate a relayed phone-pad message into a host key press
function injectInput(msg) {
  if (!session || !session.active || !msg) return;
  if (msg.t === 'down' || msg.t === 'up') { session.inject(msg.b, msg.t === 'down'); return; }
  if (msg.t === 'axis') { session.injectAxis(msg.x, msg.y); return; }
  if (msg.t === 'hk') {
    if (msg.a === 'ff_on')  return session.inject('ff_on', true);
    if (msg.a === 'ff_off') return session.inject('ff_off', false);
    if (msg.a === 'save' || msg.a === 'load') {       // tap: press AND release, or the key stays held
      session.inject(msg.a, true);
      setTimeout(() => { try { session.inject(msg.a, false); } catch (e) {} }, 40);
    }
  }
  // On the keyboard paths the analog stick also arrives as digital up/down/left/
  // right presses, so games stay playable; the gamepad path adds true analog above.
}

function handle(req, res, urlPath, q) {
  if (urlPath === '/stream/video') {
    const s = ensure();
    if (!s.active || !s.mjpegEnabled()) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('stream not started'); return true; }
    s.addSubscriber(res); return true;
  }
  if (urlPath === '/stream/audio') {
    const s = ensure();
    if (!s.active || !s.audioEnabled() || !s.mjpegEnabled()) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('no audio'); return true; }
    s.addAudioSubscriber(res); return true;
  }
  if (urlPath === '/stream/mux') {        // H.264 + AAC muxed fMP4 for MSE clients
    const s = ensure();
    s.addMuxSubscriber(res); return true;
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
    res.end(JSON.stringify({ enabled: true, running: active(), mode: cfg.mode,
      emulator: session && session.emu ? session.emu.name : null,
      mjpeg: cfg.mode !== 'h264', mux: cfg.mode !== 'mjpeg',
      viewers: session ? (session.subscribers.size + session.muxSubs.size) : 0,
      capture: resolveCapture(cfg.capture), input: resolveInputTool(cfg.inputTool),
      audio: !!audioCaptureArgs(cfg), audioListeners: session ? session.audioSubs.size : 0,
      error: session ? session._err : null, audioError: session ? session._audioErr : null,
      muxError: session ? session._muxErr : null }));
    return true;
  }
  return false;
}

module.exports = {
  handle, injectInput, active, listEmulators,
  shutdown() { if (session) session.stop(); stopInjectors(); },
  _internals: { config, scanEmulators, listRoms, captureArgs, tokenize, launchArgs, inputArgs, osaLine,
    defaultCapture, defaultInputTool, resolveCapture, resolveInputTool, resolveWindowTitle,
    defaultAudioInput, resolveAudio, audioCaptureArgs, videoInputArgs, muxArgs,
    Fmp4Splitter, codecsFromInit, VIDEO_CODEC,
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
  // single-window capture (Windows): grab only the emulator window by title
  ok('captureArgs window grabs by title', captureArgs(config(), 'window', 'win32', 'Project64').join(' ')
       .includes('-f gdigrab -framerate 30 -i title=Project64'));
  ok('captureArgs window still scales', captureArgs(config(), 'window', 'win32', 'Project64').join(' ').includes('scale=1280:-2'));
  ok('captureArgs window without a title falls back to desktop', captureArgs(config(), 'window', 'win32', '').join(' ').includes('-i desktop'));
  ok('resolveCapture window is Windows-only', resolveCapture('window', 'win32') === 'window'
       && resolveCapture('window', 'linux') === 'x11' && resolveCapture('window', 'darwin') === 'avfoundation');
  ok('muxArgs window grabs by title', muxArgs(config(), 'window', 'win32', true, 'PCSX2').join(' ').includes('-i title=PCSX2'));
  ok('resolveWindowTitle is a no-op off Windows', resolveWindowTitle('Project64', 'linux') === '');
  ok('resolveInputTool auto per-OS', resolveInputTool('auto', 'win32') === 'powershell'
       && resolveInputTool('auto', 'darwin') === 'osascript' && resolveInputTool('auto', 'linux') === 'xdotool');
  ok('resolveInputTool explicit kept', resolveInputTool('none', 'win32') === 'none');
  ok('resolveInputTool passes gamepad through', resolveInputTool('gamepad', 'win32') === 'gamepad');
  ok('pickInputTool keeps explicit choice', pickInputTool('powershell') === 'powershell' && pickInputTool('none') === 'none');

  const acfg = config();
  ok('audioCaptureArgs auto Linux -> pulse s16le', audioCaptureArgs(acfg, 'linux').join(' ')
       === '-loglevel error -f pulse -i default -ac 2 -ar 48000 -f s16le -');
  ok('audioCaptureArgs auto Windows -> dshow Stereo Mix', audioCaptureArgs(acfg, 'win32').join(' ')
       === '-loglevel error -f dshow -i audio=Stereo Mix -ac 2 -ar 48000 -f s16le -');
  ok('audioCaptureArgs auto macOS -> avfoundation', audioCaptureArgs(acfg, 'darwin').join(' ')
       === '-loglevel error -f avfoundation -i :default -ac 2 -ar 48000 -f s16le -');
  ok('audioCaptureArgs none -> null', audioCaptureArgs(Object.assign({}, acfg, { audio: 'none' }), 'linux') === null);
  ok('audioCaptureArgs device override', audioCaptureArgs(Object.assign({}, acfg, { audioDevice: 'sink.monitor' }), 'linux').join(' ')
       === '-loglevel error -f pulse -i sink.monitor -ac 2 -ar 48000 -f s16le -');
  ok('audioCaptureArgs explicit format + device', audioCaptureArgs(Object.assign({}, acfg, { audio: 'alsa', audioDevice: 'hw:0' }), 'linux').join(' ')
       === '-loglevel error -f alsa -i hw:0 -ac 2 -ar 48000 -f s16le -');
  ok('audioCaptureArgs custom rate', audioCaptureArgs(Object.assign({}, acfg, { audioRate: '44100' }), 'linux').includes('44100'));

  // ---- H.264 muxed transport ----
  const mx = muxArgs(acfg, 'x11', 'linux').join(' ');
  ok('muxArgs encodes H.264 + AAC fMP4', mx.includes('-c:v libx264') && mx.includes('-c:a aac')
       && mx.includes('x11grab') && mx.includes('-f pulse -i default')
       && mx.includes('+frag_keyframe+empty_moov+default_base_moof') && mx.endsWith('pipe:1'));
  ok('muxArgs maps both streams', mx.includes('-map 0:v:0') && mx.includes('-map 1:a:0'));
  const mxNA = muxArgs(acfg, 'x11', 'linux', true).join(' ');
  ok('muxArgs noAudio drops the audio input/codec', !mxNA.includes('-c:a aac') && !mxNA.includes('-i default') && !mxNA.includes('-map 1:a:0'));
  ok('muxArgs none-audio cfg is video-only', !muxArgs(Object.assign({}, acfg, { audio: 'none' }), 'x11', 'linux').join(' ').includes('aac'));
  ok('muxArgs scales desktop grabs (gdigrab)', muxArgs(acfg, 'gdigrab', 'win32').join(' ').includes('scale=1280:-2'));

  const mkbox = (type, payload) => { payload = payload || Buffer.alloc(0); const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8); return b; };
  const ftyp = mkbox('ftyp', Buffer.from('isom')), moov = mkbox('moov', Buffer.from('mp4a')); // moov names the audio codec
  const moof1 = mkbox('moof', Buffer.from([1])), mdat1 = mkbox('mdat', Buffer.from([2, 2]));
  const moof2 = mkbox('moof', Buffer.from([3])), mdat2 = mkbox('mdat', Buffer.from([4, 4]));
  const inits = [], frags = [];
  const fsp = new Fmp4Splitter(i => inits.push(i), f => frags.push(f));
  const whole = Buffer.concat([ftyp, moov, moof1, mdat1, moof2, mdat2]);
  for (let i = 0; i < whole.length; i += 5) fsp.push(whole.slice(i, i + 5));   // feed in tiny chunks
  ok('Fmp4Splitter extracts init = ftyp+moov', inits.length === 1 && inits[0].equals(Buffer.concat([ftyp, moov])));
  ok('Fmp4Splitter emits moof+mdat fragments', frags.length === 2
       && frags[0].equals(Buffer.concat([moof1, mdat1])) && frags[1].equals(Buffer.concat([moof2, mdat2])));
  ok('codecsFromInit detects audio track', codecsFromInit(Buffer.concat([ftyp, moov])) === 'avc1.42E01E,mp4a.40.2');
  ok('codecsFromInit video-only', codecsFromInit(mkbox('moov', Buffer.from('avc1'))) === 'avc1.42E01E');

  // mux subscriber: gets the cached init + the X-Codecs header
  const ms2 = new StreamSession(config()); ms2.active = true; ms2.mux = {};   // pretend the encoder is already up
  ms2.muxInit = Buffer.from([9, 9, 9]); ms2.muxCodecs = 'avc1.42E01E,mp4a.40.2';
  let mhdr = {}, mbody = [];
  ms2.addMuxSubscriber({ writeHead(c, h) { mhdr = h || {}; }, write(c) { mbody.push(Buffer.from(c)); return true; }, end() {}, on() {} });
  ok('mux subscriber receives init + codecs', Buffer.concat(mbody).equals(ms2.muxInit) && mhdr['X-Codecs'] === 'avc1.42E01E,mp4a.40.2' && mhdr['Content-Type'] === 'video/mp4');
  let mcode = 0; const mj = new StreamSession(Object.assign({}, config(), { mode: 'mjpeg' })); mj.active = true;
  mj.addMuxSubscriber({ writeHead(c) { mcode = c; }, end() {}, on() {} });
  ok('mux refused in mjpeg mode', mcode === 503);
  ok('mode flags reflect config', new StreamSession(Object.assign({}, config(), { mode: 'mjpeg' })).muxEnabled() === false
       && new StreamSession(Object.assign({}, config(), { mode: 'h264' })).mjpegEnabled() === false
       && new StreamSession(config()).muxEnabled() === true && new StreamSession(config()).mjpegEnabled() === true);

  ok('launchArgs substitutes {rom}', (launchArgs({ cmd: 'pcsx2 {rom}' }, '/g/x.iso') || []).join(' ') === 'pcsx2 /g/x.iso');
  ok('launchArgs drops empty rom', (launchArgs({ cmd: 'retroarch {rom}' }, '') || []).join(' ') === 'retroarch');
  const winArgs = launchArgs({ cmd: '"C:\\Program Files\\PCSX2\\pcsx2-qt.exe" -fullscreen {rom}' }, 'C:\\games\\a b.iso') || [];
  ok('launchArgs quoted path with spaces', winArgs.length === 3 && winArgs[0] === 'C:\\Program Files\\PCSX2\\pcsx2-qt.exe' && winArgs[2] === 'C:\\games\\a b.iso');
  ok('launchArgs {rom} inside a token', (launchArgs({ cmd: 'xemu --dvd_path={rom}' }, '/g/x.iso') || []).join(' ') === 'xemu --dvd_path=/g/x.iso');
  {
    // start() must never PRE-block a launch (existsSync can false-negative an
    // installed program); it always tries to spawn and reports real failures.
    const s = new StreamSession({});
    const r = s.start({ id: 'ppsspp', cmd: '/no/such/dir/PPSSPP.exe {rom}' }, '');
    ok('start always attempts the launch (no pre-block)', r.ok === true && s.active === true);
    s.stop();
    const s2 = new StreamSession({});
    const r2 = s2.start({ id: 'menu' }, '');   // no cmd -> just arms the session
    ok('start arms a no-cmd emulator', r2.ok === true && s2.active === true);
    s2.stop();
    // the failure reason is human + actionable, and names the right manifest
    const msg = launchErrorMessage('C:\\Program Files\\PPSSPP\\PPSSPPWindows64.exe', { code: 'ENOENT' }, 'ppsspp');
    ok('launchErrorMessage explains ENOENT + how to fix', /PPSSPPWindows64\.exe/.test(msg) && /emulators\/ppsspp\/emulator\.json/.test(msg));
    ok('launchErrorMessage handles other errors', /EACCES/.test(launchErrorMessage('x', { code: 'EACCES', message: 'EACCES perm' }, 'x')));
  }

  ok('inputArgs xdotool active window', (inputArgs({ inputTool: 'xdotool' }, 'x', true, '') || []).join(' ') === 'xdotool keydown x');
  ok('inputArgs xdotool by window name', (inputArgs({ inputTool: 'xdotool' }, 'x', true, 'PCSX2') || []).join(' ') === 'xdotool search --name PCSX2 windowfocus keydown x');
  ok('inputArgs none -> null', inputArgs({ inputTool: 'none' }, 'x', true, '') === null);
  ok('keymap A->x B->z', KEYMAP.a === 'x' && KEYMAP.b === 'z');
  ok('hotkey save->F2', HOTKEY.save === 'F2');
  ok('VK map matches layout', VKMAP.a === 0x58 && VKMAP.b === 0x5A && VKMAP.up === 0x26 && VKHOT.save === 0x71);
  ok('analog keys are separate from the D-pad', ['up','down','left','right'].every(d =>
       AKEYMAP[d] && AKEYMAP[d] !== KEYMAP[d] && !Object.values(KEYMAP).includes(AKEYMAP[d])
       && AVKMAP[d] != null && AVKMAP[d] !== VKMAP[d]));
  {
    // keyboard injectAxis: only crossing the threshold flips a direction (and is
    // a no-op in 'none' mode); tracked so we emit one down/up per transition.
    const sess = new StreamSession({ inputTool: 'none' });
    let threw = false; try { sess.injectAxis(0.9, -0.9); sess.injectAxis(0, 0); } catch (e) { threw = true; }
    ok('injectAxis safe in none mode', !threw && sess._analog == null);
    const fired = [];
    const fake = new StreamSession({ inputTool: 'xdotool' });
    fake._analogKey = (d, on) => fired.push(d + (on ? '+' : '-'));
    fake.injectAxis(0.2, 0.2);                 // inside deadzone -> nothing
    fake.injectAxis(0.9, 0.0);                 // push right
    fake.injectAxis(0.9, 0.0);                 // still right -> no repeat
    fake.injectAxis(0.0, 0.0);                 // center -> release
    ok('injectAxis fires one press+release per direction', fired.join(',') === 'right+,right-');
    // a requested virtual pad degrades to the keyboard path once it's marked dead
    const pad = new StreamSession({ inputTool: 'gamepad' });
    ok('gamepad effective tool tracks pad health', pad._tool() === (gamepadDead() ? 'powershell' : 'gamepad'));
    let padThrew = false;
    try { const k = new StreamSession({ inputTool: 'none' }); k.inject('a', true); k.inject('a', false); } catch (e) { padThrew = true; }
    ok('inject is a no-op (no throw) in none mode', !padThrew);
  }
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

  // raw-PCM audio fan-out (bytes relayed untouched, headers advertise rate/channels)
  const ahdr = {}; const apcm = [];
  sess.addAudioSubscriber({ writeHead(c, h) { Object.assign(ahdr, h); }, write(c) { apcm.push(Buffer.from(c)); }, end() {}, on() {} });
  const pcm = Buffer.from([1, 2, 3, 4]); sess._broadcastAudio(pcm);
  ok('audio fan-out relays PCM + advertises format', Buffer.concat(apcm).equals(pcm)
       && ahdr['X-Audio-Rate'] === '48000' && ahdr['X-Audio-Channels'] === '2');
  ok('session audioEnabled reflects config', new StreamSession(config()).audioEnabled() === true
       && new StreamSession(Object.assign({}, config(), { audio: 'none' })).audioEnabled() === false);

  let threw = false; try { injectInput({ t: 'down', b: 'a' }); injectInput({ t: 'hk', a: 'save' }); injectInput({ t: 'axis', x: 0.5, y: -0.5 }); } catch (e) { threw = true; }
  ok('injectInput safe when idle', !threw);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
