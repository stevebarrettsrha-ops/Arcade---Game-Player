#!/usr/bin/env node
/*
 * ARCADE — diagnose the Windows virtual Xbox controller (ViGEm).
 *
 * Run it on the Windows host when the virtual gamepad won't start:
 *   node check-vigem.js
 * (or double-click check-vigem-windows.bat)
 *
 * It checks, in plain language, the things that actually break ViGEm:
 *   1. the ViGEmBus DRIVER is installed AND running (needs a reboot after setup)
 *   2. ViGEmClient.dll is present, and is the SAME architecture as your Node
 *   3. a real connection actually succeeds (runs the same helper the server uses)
 * Nothing here changes your system — it only reports.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
const arch = process.arch;                 // 'x64' | 'ia32' | 'arm64'
const archWord = { x64: '64-bit (x64)', ia32: '32-bit (x86)', arm64: '64-bit (ARM64)' }[arch] || arch;
let problems = [];

function line(s) { console.log(s); }
function locateDll() {
  const cands = [ process.env.ARCADE_VIGEM_DLL,
    path.join(ROOT, 'ViGEmClient.dll'), path.join(ROOT, 'assets', 'ViGEmClient.dll') ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return '';
}
// read a PE file's machine type from its COFF header (no deps)
function dllArch(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
  try {
    const head = Buffer.alloc(64); fs.readSync(fd, head, 0, 64, 0);
    if (head[0] !== 0x4D || head[1] !== 0x5A) return 'not-a-dll';   // no "MZ"
    const peOff = head.readUInt32LE(0x3C);
    const coff = Buffer.alloc(6); fs.readSync(fd, coff, 0, 6, peOff);
    if (coff.toString('ascii', 0, 4) !== 'PE\0\0') return 'not-a-dll';
    const machine = coff.readUInt16LE(4);
    return ({ 0x8664: 'x64', 0x14c: 'ia32', 0xAA64: 'arm64' })[machine] || ('0x' + machine.toString(16));
  } catch (e) { return null; } finally { try { fs.closeSync(fd); } catch (e) {} }
}
const archMatches = (dll) => (dll === 'x64' && arch === 'x64') || (dll === 'ia32' && arch === 'ia32') || (dll === 'arm64' && arch === 'arm64');

// run the gamepad helper exactly like the server does, send a tap, watch it
function liveTest(dll, done) {
  let child; try {
    child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'stream-gamepad.ps1')],
      { stdio: ['pipe', 'ignore', 'pipe'], env: Object.assign({}, process.env, dll ? { ARCADE_VIGEM_DLL: dll } : {}) });
  } catch (e) { return done({ ok: false, why: 'could not start PowerShell (' + e.message + ')' }); }
  let err = ''; let exited = false;
  child.stderr.on('data', d => { err += d.toString(); });
  child.on('error', e => { exited = true; done({ ok: false, why: e.message }); });
  child.on('close', () => { exited = true; });          // early exit = failure (handled by the timer)
  try { child.stdin.on('error', () => {}); child.stdin.write('b a 1\nb a 0\n'); } catch (e) {}
  setTimeout(() => {
    if (exited) { const last = err.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop(); return done({ ok: false, why: last || 'the helper exited immediately' }); }
    try { child.kill(); } catch (e) {}                  // still alive after the wait = connected fine
    done({ ok: true });
  }, 2500);
}

(function main() {
  line('\nARCADE — ViGEm (virtual Xbox controller) check\n');
  line('Node.js: ' + process.version + '  (' + archWord + ')');

  if (process.platform !== 'win32') {
    line('\nThis machine is ' + process.platform + ', not Windows. The virtual Xbox');
    line('controller is a Windows-only feature (it uses the ViGEmBus driver).');
    line('On macOS/Linux ARCADE uses the keyboard input path instead.\n');
    return;
  }

  // 1. driver installed + running?
  line('\n[1/3] ViGEmBus driver');
  const sc = spawnSync('sc', ['query', 'ViGEmBus'], { encoding: 'utf8' });
  const out = ((sc.stdout || '') + (sc.stderr || ''));
  if (/1060|does not exist/i.test(out)) {
    line('  ✗ NOT INSTALLED. Install it (one time) from:');
    line('      https://github.com/nefarius/ViGEmBus/releases  (ViGEmBus_Setup_x64.msi)');
    problems.push('Install the ViGEmBus driver, then REBOOT.');
  } else if (/RUNNING/i.test(out)) {
    line('  ✓ installed and RUNNING.');
  } else if (/STOPPED/i.test(out)) {
    line('  ✗ installed but STOPPED (not loaded). A REBOOT usually fixes this.');
    problems.push('ViGEmBus is installed but not running — REBOOT Windows.');
  } else {
    line('  ? could not read the driver state. Raw output:');
    line('    ' + out.trim().replace(/\s+/g, ' ').slice(0, 200));
    problems.push('Confirm ViGEmBus is installed (Device Manager) and reboot.');
  }

  // 2. DLL present + architecture
  line('\n[2/3] ViGEmClient.dll');
  const dll = locateDll();
  if (!dll) {
    line('  ✗ NOT FOUND next to server.js. Get it with download-vigem-windows.bat.');
    problems.push('Put ViGEmClient.dll next to server.js (download-vigem-windows.bat).');
  } else {
    const da = dllArch(dll);
    line('  found: ' + dll);
    if (da === 'not-a-dll') { line('  ✗ that file is NOT a valid DLL (corrupt/partial download).'); problems.push('Re-download ViGEmClient.dll (the file is not a valid DLL).'); }
    else if (!da) { line('  ? could not read its architecture.'); }
    else if (archMatches(da)) { line('  ✓ architecture ' + da + ' matches your ' + archWord + ' Node.'); }
    else { line('  ✗ architecture MISMATCH: DLL is ' + da + ', but Node is ' + arch + '.'); problems.push('Get the ' + arch + ' build of ViGEmClient.dll (must match Node\'s architecture).'); }
  }

  // 3. live connection test (only worth it if the DLL exists)
  line('\n[3/3] Live connection test');
  if (!dll) { line('  skipped (no DLL).'); return finish(); }
  line('  starting the controller helper…');
  liveTest(dll, res => {
    if (res.ok) line('  ✓ SUCCESS — a virtual Xbox pad connected. ARCADE should say "gamepad" mode.');
    else { line('  ✗ FAILED: ' + res.why); if (!problems.length) problems.push('Helper failed: ' + res.why + ' — usually a reboot after installing ViGEmBus.'); }
    finish();
  });
})();

function finish() {
  line('\n----------------------------------------------------------');
  if (!problems.length) line('All good. If the game still ignores it, check the emulator is using\nthe Xbox controller (Controller 1) in its input settings.');
  else { line('To fix:'); problems.forEach((p, i) => line('  ' + (i + 1) + '. ' + p)); }
  line('');
}
