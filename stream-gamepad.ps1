# ============================================================
#   ARCADE streaming mode - Windows virtual Xbox 360 controller
#   Started automatically by stream.js when ViGEmClient.dll is present
#   (one persistent process, so each input doesn't pay PowerShell's
#   startup cost). Drives a real virtual gamepad via ViGEmBus, so every
#   host emulator sees an Xbox controller - analog stick + all buttons
#   work with NO per-emulator key mapping.
#
#   Requires:
#     - ViGEmBus driver installed (https://github.com/nefarius/ViGEmBus)
#     - ViGEmClient.dll next to this script, or path in $env:ARCADE_VIGEM_DLL
#
#   Protocol: one line per event on stdin. The trailing player number
#   (0-3) is optional and defaults to 0; each player gets their own pad.
#       b <name> <0|1> [p]   button down/up
#                            name = a b x y l r l2 r2 start select up down left right
#       a <lx> <ly> [p]      left analog stick, floats -1..1 (y+ = down)
#       r <rx> <ry> [p]      right analog stick, floats -1..1 (y+ = down)
#       t <lt> <rt> [p]      analog triggers, floats 0..1
# ============================================================
$ErrorActionPreference = 'Stop'

$dll = $env:ARCADE_VIGEM_DLL
if (-not $dll -or -not (Test-Path $dll)) { $dll = Join-Path $PSScriptRoot 'ViGEmClient.dll' }
if (-not (Test-Path $dll)) { Write-Error 'ViGEmClient.dll not found'; exit 1 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ViGEm {
  [StructLayout(LayoutKind.Sequential)]
  public struct XUSB_REPORT {
    public ushort wButtons;
    public byte bLeftTrigger;
    public byte bRightTrigger;
    public short sThumbLX;
    public short sThumbLY;
    public short sThumbRX;
    public short sThumbRY;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadLibrary(string path);
  [DllImport("ViGEmClient.dll")] public static extern IntPtr vigem_alloc();
  [DllImport("ViGEmClient.dll")] public static extern int vigem_connect(IntPtr client);
  [DllImport("ViGEmClient.dll")] public static extern IntPtr vigem_target_x360_alloc();
  [DllImport("ViGEmClient.dll")] public static extern int vigem_target_add(IntPtr client, IntPtr target);
  [DllImport("ViGEmClient.dll")] public static extern int vigem_target_x360_update(IntPtr client, IntPtr target, XUSB_REPORT report);
}
"@

# load the DLL from its full path first, so the DllImport("ViGEmClient.dll") calls
# above resolve to this already-loaded module wherever the file actually lives
[ViGEm]::LoadLibrary($dll) | Out-Null

$client = [ViGEm]::vigem_alloc()
if ($client -eq [IntPtr]::Zero) { Write-Error 'vigem_alloc failed'; exit 1 }
if ([ViGEm]::vigem_connect($client) -ne 0) { Write-Error 'vigem_connect failed - is ViGEmBus installed?'; exit 1 }

# ARCADE button name -> Xbox 360 (XUSB) button flag. Face buttons map by physical
# position (top/left/right/bottom), matching the in-browser pad: ARCADE x=top->Y,
# y=left->X, a=right->B, b=bottom->A. L2/R2 drive the triggers (handled below).
$BTN = @{
  'up'=0x0001; 'down'=0x0002; 'left'=0x0004; 'right'=0x0008;
  'start'=0x0010; 'select'=0x0020; 'l'=0x0100; 'r'=0x0200;
  'b'=0x1000; 'a'=0x2000; 'y'=0x4000; 'x'=0x8000;
}

# One virtual pad per player, plugged in on first use. Windows numbers pads in
# the order they appear, so every lower-numbered pad is created first: player 2's
# input always lands on controller 2.
$pads = @{}
function New-Pad {
  $t = [ViGEm]::vigem_target_x360_alloc()
  if ([ViGEm]::vigem_target_add($client, $t) -ne 0) { return $null }
  return @{ target = $t; buttons = 0; lt = 0; rt = 0; lx = 0; ly = 0; rx = 0; ry = 0 }
}
function Get-Pad([int]$i) {
  if ($i -lt 0 -or $i -gt 3) { $i = 0 }
  for ($k = 0; $k -le $i; $k++) {
    if (-not $pads.ContainsKey($k)) {
      $n = New-Pad
      if ($null -eq $n) { return $pads[0] }      # no room for another pad: share player 1's
      $pads[$k] = $n
    }
  }
  return $pads[$i]
}
$first = New-Pad
if ($null -eq $first) { Write-Error 'vigem_target_add failed'; exit 1 }
$pads[0] = $first

function Send-State($s) {
  $r = New-Object ViGEm+XUSB_REPORT
  $r.wButtons = [uint16]$s.buttons
  $r.bLeftTrigger = [byte]$s.lt
  $r.bRightTrigger = [byte]$s.rt
  $r.sThumbLX = [int16]$s.lx
  $r.sThumbLY = [int16]$s.ly
  $r.sThumbRX = [int16]$s.rx
  $r.sThumbRY = [int16]$s.ry
  [ViGEm]::vigem_target_x360_update($client, $s.target, $r) | Out-Null
}
# numbers always arrive with a "." decimal point, whatever the Windows region is
$INV = [Globalization.CultureInfo]::InvariantCulture
function Read-Num([string]$t, [double]$lo, [double]$hi) {
  $v = 0.0
  [void][double]::TryParse($t, [Globalization.NumberStyles]::Float, $INV, [ref]$v)
  if ($v -gt $hi) { $v = $hi } elseif ($v -lt $lo) { $v = $lo }
  return $v
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Trim().Split(' ')
  if ($p.Length -lt 3) { continue }
  $who = 0
  if ($p.Length -ge 4) { [void][int]::TryParse($p[3], [ref]$who) }
  $s = Get-Pad $who
  if ($null -eq $s) { continue }
  switch ($p[0]) {
    'b' {
      $name = $p[1]; $on = $p[2] -eq '1'
      if ($name -eq 'l2') { $s.lt = $(if ($on) { 255 } else { 0 }) }
      elseif ($name -eq 'r2') { $s.rt = $(if ($on) { 255 } else { 0 }) }
      elseif ($BTN.ContainsKey($name)) {
        if ($on) { $s.buttons = $s.buttons -bor $BTN[$name] }
        else { $s.buttons = $s.buttons -band (-bnot $BTN[$name]) }
      } else { continue }
      Send-State $s
    }
    'a' {
      $s.lx = [int][math]::Round((Read-Num $p[1] -1 1) * 32767)
      $s.ly = [int][math]::Round(-(Read-Num $p[2] -1 1) * 32767)   # y+ = down -> XInput y+ = up
      Send-State $s
    }
    'r' {
      $s.rx = [int][math]::Round((Read-Num $p[1] -1 1) * 32767)
      $s.ry = [int][math]::Round(-(Read-Num $p[2] -1 1) * 32767)
      Send-State $s
    }
    't' {
      $s.lt = [int][math]::Round((Read-Num $p[1] 0 1) * 255)
      $s.rt = [int][math]::Round((Read-Num $p[2] 0 1) * 255)
      Send-State $s
    }
  }
}
