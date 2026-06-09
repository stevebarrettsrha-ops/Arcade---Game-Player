# ============================================================
#   ARCADE streaming mode - Windows key injector
#   Started automatically by stream.js (one persistent process,
#   so each button press doesn't pay PowerShell's startup cost).
#   Protocol: one line per event on stdin ->  "down <vk>" / "up <vk>"
#   where <vk> is a Windows virtual-key code in decimal.
# ============================================================
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ArcadeKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Trim().Split(' ')
  if ($p.Length -lt 2) { continue }
  $vk = 0
  if (-not [int]::TryParse($p[1], [ref]$vk)) { continue }
  if ($vk -lt 1 -or $vk -gt 254) { continue }
  # arrow keys are "extended" keys; without this flag games see numpad arrows
  $flags = [uint32]0
  if ($vk -ge 0x25 -and $vk -le 0x28) { $flags = 1 }
  if ($p[0] -eq 'down') { [ArcadeKeys]::keybd_event([byte]$vk, 0, $flags, [UIntPtr]::Zero) }
  elseif ($p[0] -eq 'up') { [ArcadeKeys]::keybd_event([byte]$vk, 0, ($flags -bor 2), [UIntPtr]::Zero) }
}
