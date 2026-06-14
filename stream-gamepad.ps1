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
#   Protocol: one line per event on stdin
#       b <name> <0|1>   button down/up
#                        name = a b x y l r l2 r2 start select up down left right
#       a <lx> <ly>      left analog stick, floats -1..1 (phone y+ = down)
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
$pad = [ViGEm]::vigem_target_x360_alloc()
if ([ViGEm]::vigem_target_add($client, $pad) -ne 0) { Write-Error 'vigem_target_add failed'; exit 1 }

# ARCADE button name -> Xbox 360 (XUSB) button flag. Face buttons map by physical
# position (top/left/right/bottom), matching the in-browser pad: ARCADE x=top->Y,
# y=left->X, a=right->B, b=bottom->A. L2/R2 drive the triggers (handled below).
$BTN = @{
  'up'=0x0001; 'down'=0x0002; 'left'=0x0004; 'right'=0x0008;
  'start'=0x0010; 'select'=0x0020; 'l'=0x0100; 'r'=0x0200;
  'b'=0x1000; 'a'=0x2000; 'y'=0x4000; 'x'=0x8000;
}
$buttons = 0; $lt = 0; $rt = 0; $lx = 0; $ly = 0

function Send-State {
  $r = New-Object ViGEm+XUSB_REPORT
  $r.wButtons = [uint16]$buttons
  $r.bLeftTrigger = [byte]$lt
  $r.bRightTrigger = [byte]$rt
  $r.sThumbLX = [int16]$lx
  $r.sThumbLY = [int16]$ly
  $r.sThumbRX = 0; $r.sThumbRY = 0
  [ViGEm]::vigem_target_x360_update($client, $pad, $r) | Out-Null
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Trim().Split(' ')
  if ($p.Length -lt 3) { continue }
  switch ($p[0]) {
    'b' {
      $name = $p[1]; $on = $p[2] -eq '1'
      if ($name -eq 'l2') { $lt = $(if ($on) { 255 } else { 0 }) }
      elseif ($name -eq 'r2') { $rt = $(if ($on) { 255 } else { 0 }) }
      elseif ($BTN.ContainsKey($name)) {
        if ($on) { $buttons = $buttons -bor $BTN[$name] }
        else { $buttons = $buttons -band (-bnot $BTN[$name]) }
      } else { continue }
      Send-State
    }
    'a' {
      $fx = 0.0; $fy = 0.0
      [void][double]::TryParse($p[1], [ref]$fx)
      [void][double]::TryParse($p[2], [ref]$fy)
      if ($fx -gt 1) { $fx = 1 } elseif ($fx -lt -1) { $fx = -1 }
      if ($fy -gt 1) { $fy = 1 } elseif ($fy -lt -1) { $fy = -1 }
      $lx = [int][math]::Round($fx * 32767)
      $ly = [int][math]::Round(-$fy * 32767)   # phone y+ = down -> XInput y+ = up
      Send-State
    }
  }
}
