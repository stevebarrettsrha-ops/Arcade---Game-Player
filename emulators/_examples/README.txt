==============================================================
  READY-MADE EMULATOR MANIFESTS (copy one level up to use)
==============================================================

These are example manifests for the most-wanted host emulators:

    pcsx2/          PS2          (PCSX2)
    xemu/           XBOX         (xemu, the original Xbox)
    ppsspp/         PSP          (native PPSSPP — full speed)
    retroarch-n64/  N64          (RetroArch + mupen64plus-next)
    dolphin/        GameCube/Wii (Dolphin)
    rpcs3/          PS3          (RPCS3)

The whole _examples folder is IGNORED by ARCADE (the underscore).
To enable one:

  1. Install that emulator on the host computer yourself.
  2. COPY its folder one level up, e.g.
         emulators/_examples/pcsx2  ->  emulators/pcsx2
  3. Open emulators/pcsx2/emulator.json and fix the "cmd" line so it
     matches how the emulator is launched on YOUR computer:
        - Windows: use the full .exe path in quotes, e.g.
            "cmd": "\"C:\\Program Files\\PCSX2\\pcsx2-qt.exe\" -fullscreen {rom}"
        - Linux Flatpak:  "cmd": "flatpak run net.pcsx2.PCSX2 -fullscreen {rom}"
        - If the command is on your PATH the bare name works as-is.
  4. Drop games into the folder named on the "roms" line
     (e.g. games/ps2) — they appear in ARCADE and on the phone pad.
  5. Start ARCADE with streaming on:  start-*-stream  (see
     SETUP-STREAMING.txt).

Manifest fields are documented in emulators/_ABOUT.txt.
==============================================================
