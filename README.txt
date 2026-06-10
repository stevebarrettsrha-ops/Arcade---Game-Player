==============================================================
  ARCADE home server - README
==============================================================

1. WHAT'S IN THIS FOLDER
   index.html ........... the web page you play on (the front-end)
   pad.html ............. the phone controller page (opened via the QR code)
   server.js ............ the local server (needs Node.js to run)
   start-windows.bat .... start the server on Windows
   start-mac.command .... start the server on macOS
   start-linux.sh ....... start the server on Linux
   start-*-psp .......... start in PSP mode (experimental - see section 9)
   start-*-stream ....... start with host-emulator STREAMING on: play
                          PS2 / XBOX / GameCube / PS3 / native N64+PSP
                          on every device (see SETUP-STREAMING.txt)
   emulators/ ........... host emulators for streaming mode; ready-made
                          manifests to copy are in emulators/_examples/
   fully offline network/ no router? turn THIS computer into the WiFi
                          network (see its READ ME FIRST.txt)
   download-offline-* ... ONE-TIME: download the emulator for offline use
   get-offline.js ....... the script those launchers run (Node)
   download-j2me-* ...... ONE-TIME: set up the Java handset (runs in-app)
   get-j2me.js .......... the script those launchers run (Node)
   make-cert.js ......... ONE-TIME: make an HTTPS certificate so Java works
                          on TVs/phones over the LAN (see section 2)
   emulatorjs/ .......... where the offline engine + cores are stored
   j2me-web/ ............ where the Java handset is stored (see its _ABOUT)
   assets/ .............. bundled fonts + QR code library (already offline)
   games/<system> ....... drop ROMs into the matching folder:
        games/gba    .gba .zip          games/nes    .nes .zip
        games/snes   .sfc .smc .zip      games/genesis .md .gen .zip
        games/gb     .gb .gbc .zip       games/n64    .n64 .z64 .zip
        games/psx    .chd .pbp .iso      games/j2me   .jar .jad
        games/ps2 and games/xbox: used by STREAMING mode (section 9)
   bios/psx ............. optional PlayStation 1 BIOS file
   users/ ............... player profiles + their saved games (auto-made)
   manual-saves/ ........ where to keep Java & PPSSPP save backups
   START-HERE.txt ....... the short version of these instructions

2. HOW IT WORKS
   The server reads the "games" folders and lists everything it
   finds on the web page. Pick a game and it plays in the browser.

   GBA, NES, SNES, Genesis/Mega Drive, Game Boy/Color, Nintendo 64
   and PlayStation 1 all run on the page via EmulatorJS (RetroArch
   cores compiled to WebAssembly). Save states, fast-forward, gamepad
   and on-screen touch controls are built in. Cores are fetched from
   the internet the first time, then cached.
     - 8/16-bit systems run great on almost anything.
     - N64 and PS1 are heavier; how well they run depends on the
       device. N64 uses an analog stick (the phone thumbstick maps
       to it). PS1 wants disc images as .chd or .pbp (single file);
       for .cue+.bin, convert to .chd or zip them together.
     - FASTER N64 / PS1 (multi-core devices, Chrome/Edge/Firefox - not
       Safari): start with threaded cores enabled to use more CPU cores:
            Windows :  set ARCADE_THREADS=1 && node server.js
            Mac/Linux: ARCADE_THREADS=1 node server.js
       (PSP mode already turns this on.) If a game won't load on an older
       TV browser, start normally without it.
     - SLOW TV? Use the "⚡ Performance" button (top right): it disables the
       shader and turns on per-system speedups (lower N64/PS1/PSP resolution
       and frame-skip) - restart the game after toggling it.
     - Games load fast on repeat plays now: cores and game files are cached
       by the browser after the first load instead of re-downloading each
       time, so launching a game you've played is near-instant.
     - PS1 usually runs without a BIOS; for best compatibility drop
       a BIOS file in bios/psx/ (use one you're entitled to).
     - Control mapping per system can be fine-tuned in EmulatorJS's
       own settings (the gear menu) if a button isn't where you want.

   Java phone (J2ME) games run through FreeJ2ME-web, an in-browser
   Java ME emulator. For the best experience, set it up ONCE so it runs
   embedded INSIDE ARCADE and loads your game automatically:

       Windows : double-click  download-j2me-windows.bat
       Mac     : double-click  download-j2me-mac.command
       Linux   : ./download-j2me-linux.sh   (or:  node get-j2me.js)

   That downloads the handset (~9 MB) into the j2me-web/ folder. After it
   finishes, restart ARCADE: pick a Java game and it loads straight into
   the handset on the page. (Set screen size, phone type and sound from
   the handset's Esc menu - for example 640x360.)

   If you skip that setup, Java games still work - ARCADE opens the
   handset in a separate browser tab and you load the .jar by hand.

   IMPORTANT: Java is the one exception to "fully offline" - it needs an
   internet connection while playing, because its Java engine (CheerpJ)
   loads from the provider's servers at run time. Starting a Java game
   re-initialises that engine, so it takes a few seconds each time.

   ALSO IMPORTANT - where Java works: the Java engine only starts on a
   "secure" page. http://localhost (on the computer running the server)
   counts as secure, but a plain http://192.168.x.x LAN address does NOT.
   So open ARCADE as http://localhost:8080 on the host computer to play
   Java. Over the LAN address - including phones and TVs - the Java engine
   can't start without HTTPS; every OTHER system still works there as normal.
   If a Java game won't start, ARCADE tells you which of these is the cause.

   WANT JAVA ON TVs / PHONES TOO? Turn on HTTPS once (makes every page a
   "secure" page, so Java starts over the LAN):
       1) node make-cert.js          (one time - needs openssl; makes a
                                       self-signed certificate in certs/)
       2) start ARCADE with HTTPS on:
            Windows :  set ARCADE_HTTPS=1 && node server.js
            Mac/Linux: ARCADE_HTTPS=1 node server.js
       3) on the TV/phone open  https://<your-LAN-IP>:8443  and accept the
          one-time "not private" warning (it's your own computer).
   Plain http://...:8080 keeps working for every other system as before.
   J2ME saves: FreeJ2ME-web stores your saves in the browser, and they
   persist between sessions. They are NOT in the per-player folders (it's
   a separate app). To back them up, use its "Export Data" button and
   keep the file in manual-saves/j2me/ - see the note in that folder.

3. COVERS / THUMBNAILS
   EVERY game gets a cover automatically - no setup needed. For each
   game ARCADE picks the best available, in this order:
     a) An image with the SAME NAME next to the game, e.g.
          games/gba/Minish Cap.gba  +  games/gba/Minish Cap.png
        (.png .jpg .jpeg .webp .gif, any system) - this always wins.
     b) Real box-art you downloaded with download-boxart-* (see below).
     c) The icon built into the game, with no extra file:
          - .jar (Java) games use their own icon
          - PSP games (.pbp and .iso) use their ICON0.PNG
          - PSN PS1 .pbp games use their ICON0.PNG too
     d) Otherwise, a generated cover tile - a colour-coded card with
        the game's initials, unique per game, drawn offline.

   Want REAL box-art for the cartridge systems? While online, double-
   click ONE of these once (run again after adding games):
       Windows : download-boxart-windows.bat
       macOS   : download-boxart-mac.command
       Linux   : ./download-boxart-linux.sh
   It matches your games by file name against a community art set and
   saves covers into the boxart/ folder, so they work offline after.
   Matching is best with standard "No-Intro / Redump" names like
   "Super Mario World (USA).sfc"; anything unmatched keeps its
   generated tile. (Legacy: ARCADE_BOXART=1 still fetches GBA covers
   live at runtime, but the downloader above is the better way.)

4. CHANGING THE PORT
   The default address ends in :8080. To use another port:
      Windows :  set PORT=8090 && node server.js
      Mac/Linux: PORT=8090 node server.js

4b. PLAYER PROFILES & SAVED GAMES (keeps each person's saves separate)
   When ARCADE opens, it asks "Who's playing?". Each player makes a
   profile once - a name plus a 4-digit PIN - or taps "Play as guest".
   The little 👤 button at the top right shows who's playing; tap it any
   time to switch players.

   Why: every profile gets ITS OWN folder on the host computer, so
   players never overwrite each other's progress and saves aren't lost
   if a browser clears its data:
      users/<name>/saves/<system>/<game>.state   (save states)
      users/<name>/saves/<system>/<game>.srm      (in-game battery saves)

   How saving works once you're logged in:
     - SAVE / LOAD (on the phone pad or keyboard) now save to and load
       from YOUR folder on the host - not just the local browser.
     - ARCADE also auto-saves your spot every ~45 seconds and when you
       press "Back to library", so progress is hard to lose.
     - When you start a game, your latest save for THAT game loads
       automatically, so you pick up where you left off.

   Notes:
     - "Guest" uses the browser's built-in saving (the old behaviour) and
       does NOT get a server folder.
     - The 4-digit PIN keeps players separate on your home network; the
       PIN is stored hashed, but this is light protection, not strong
       security. Back up the users/ folder to keep saves safe.
     - This covers the cartridge/disc systems (the EmulatorJS tabs).
       Java (J2ME) and the separate PPSSPP app keep their own saves in
       the browser (they persist between sessions, but aren't in the
       per-player folders). Back them up via manual-saves/j2me/ and
       manual-saves/ppsspp/ - each has a short how-to note inside.
     - To remove a player, delete their folder under users/.

5. PHONE AS A CONTROLLER (great on a TV)
   Open ARCADE in the TV's web browser using the WiFi address. Click
   "Phone" (top right): a panel shows a QR code and a short link like
   http://192.168.0.3:8080/pad.html?room=7F2K  On a phone on the same
   WiFi, scan the QR or open that link.

   The phone opens a DEDICATED CONTROLLER page (pad.html) - just the
   gamepad, no game on the phone. Turn the phone sideways (it shows a
   "rotate" prompt in portrait) and optionally tap "Full" for
   fullscreen. The controller has:
     - Analog thumbstick (left): works as both an 8-way D-pad AND a
       real analog stick, so Nintendo 64 / PS1 movement works.
     - Face buttons (right): A / B / X / Y in a diamond.
     - Shoulders (top corners): L2 L  and  R R2.
     - Start / Select in the middle, plus:
       TURBO (hold A or B to auto-fire), SAVE / LOAD (quick state on
       the TV), and FF (hold for fast-forward).
     - "Games" button (top): browse your library and launch any game
       ON THE TV without touching the TV.
     - "Edit" button (top): rearrange the controller to fit your hands
       and phone. Tap Edit, then DRAG any control (stick, A/B/X/Y,
       shoulders, Start/Select group) anywhere on screen; tap a control
       and use Size - / Size + to make it bigger or smaller. Tap Done to
       save. The layout is remembered on THAT phone (so each person can
       have their own), and Reset puts everything back to default.
   The link dot turns green when the TV is receiving. Tip: if "Phone"
   shows a localhost link, open ARCADE on the TV via its WiFi address
   first.

   TWO PLAYERS (and up to four): have a second person scan the SAME QR
   code on their own phone. Each phone is given its own player slot
   automatically - the first is Player 1, the second is Player 2 - and
   the game reads them as two separate controllers. The top of the
   controller shows PLAYER 1/2/3/4; tap a number to change which player
   that phone is. The TV's Phone panel shows "P1 + P2 connected" so you
   can confirm both are linked. This works for any 2-player game on
   systems that support it (PS1, N64, SNES, Genesis, NES, ...). A few
   notes: player 2 only does something if the game itself is 2-player;
   more than two players on PS1 needs that game's multitap turned on in
   EmulatorJS's settings; and you can still use the TV keyboard as
   Player 1 alongside a phone.

   FOUR PLAYERS: Player 1 has a "4-player mode" button - the "4P"
   button on the Player-1 phone, or the "2-PLAYER MODE / 4-PLAYER MODE"
   toggle in the TV's Phone panel. Turning it on lets players 3 and 4
   join (just scan the same QR on two more phones). For PS1 this flips
   on the multitap and restarts the game, so use it only with games
   that actually support 3-4 players (e.g. multitap party/racing
   games) - single-player games ignore or reject a multitap. N64 reads
   four controllers on its own. For SNES/Genesis 4-player adapters,
   also pick the multitap/4-way device in EmulatorJS's gear menu.

   Button mapping is the standard RetroPad layout, sent straight to
   the emulator - so it's the same buttons for every system. If a
   specific button isn't where you want it (e.g. N64 C-buttons), open
   the gear menu in EmulatorJS on the TV and remap it per system.

   Note: Java phone (J2ME) games launched from the phone CAN now be
   controlled by it when the handset runs embedded in ARCADE (the
   one-time download-j2me-* setup): D-pad = arrows, A = OK/Enter,
   B = 5 (fire), L/R or SELECT/START = soft keys, X/Y = * and #.
   If the handset opens in a separate tab instead (no local copy),
   use the TV's keyboard for those.

   Playing solo directly on a phone (no TV)? EmulatorJS shows its own
   on-screen buttons in the lower corners with the video pinned to the
   top. For the best feel, use a second device as the controller above.

6. CONTROLS
   On the TV/computer keyboard (EmulatorJS default RetroPad):
     Arrows = D-pad,  Z = B,  X = A,  S = X,  A = Y,
     Q/E = L/R,  Enter = Start,  Shift = Select.
     The EmulatorJS bar has save states, fast-forward & settings,
     and you can rebind any key/button there per system.
   J2ME:  Arrows = D-pad, Enter = OK, Q/W = soft keys, 0-9 keypad,
          E/R = * / #, Esc = options (screen size / phone type).

7. TROUBLESHOOTING
   - Page shows "no server": you opened index.html directly with
     file://. Start it with a start-* script instead so the folder
     can be listed and games can stream.
   - Phone/TV can't reach it: make sure it's on the SAME WiFi, and
     allow Node through the computer's firewall if asked.
   - Emulator won't load and you're OFFLINE: download it first (see
     section 10). Online, the engine is fetched the first time you play.
   - A J2ME game looks squashed or won't start: press Esc in the
     handset, set the screen size / phone type, turn sound off,
     then relaunch. Not every J2ME game is supported.
   - Java stuck on "Loading CheerpJ..." / "Java didn't start": almost always
     one of two things, and ARCADE now tells you which. (1) You're on a plain
     http://192.168.x.x LAN address - the Java engine only runs on a secure
     page, so open ARCADE as http://localhost:8080 on the host computer.
     (2) No internet / the CheerpJ engine (cjrtnc.leaningtech.com) is blocked -
     Java needs a connection to start. Other systems are unaffected either way.
   - Java handset frame is blank: your browser may block embedding;
     use "Open handset in new tab".

8. ABOUT GAMES
   This package ships with NO games. Use cartridge dumps and .jar
   files you legally own. Files stay on your computer; nothing is
   uploaded anywhere.

9. PSP (TWO ENGINES) and what's NOT possible (PS2/PS3)
   The PSP tab gives you two engines via an "Open PPSSPP" button plus
   the built-in core below it:

   a) PPSSPP (recommended): the real PPSSPP emulator (the same one used
      on PC/phone) compiled to run in the browser - far better game
      compatibility. It's a SEPARATE app with its own menus and
      controls (the ARCADE phone-pad does not drive it). The "Open
      PPSSPP" button opens it. No BIOS needed.
      To run it OFFLINE you have two choices:
        - Easiest: open it once with internet, then use your browser's
          "Install app" / "Add to Home Screen" option. It downloads and
          caches itself, then runs with no internet afterwards.
        - Fully inside ARCADE: while online, double-click
          download-ppsspp-windows.bat (or -mac.command / -linux.sh).
          It downloads the built PPSSPP app into the psp-ppsspp/ folder
          (tens of MB, one time). The button then says "Open PPSSPP
          (offline copy)" and ARCADE serves it locally. Start in PSP
          mode (below) for full speed.
      PPSSPP saves: it keeps your PSP memory stick (saves AND save
      states) in the browser; they persist between sessions. Installing
      it (above) keeps them safely and don't clear that site's data. As
      a separate app its saves aren't in the per-player folders; see
      manual-saves/ppsspp/ for how to keep a backup.

   b) Built-in core (beta): the PSP tab also lists games from games/psp
      to play with the built-in core, which DOES work with the phone
      pad - but it's beta and crashes often. It only runs when you
      start ARCADE in PSP mode:
        Windows : start-windows-psp.bat
        macOS   : start-mac-psp.command
        Linux   : ./start-linux-psp.sh
      PSP mode needs a powerful device and a DESKTOP browser
      (Chrome/Edge/Firefox, NOT Safari). The Java-phone feature keeps
      working in PSP mode.

   PS2 / XBOX / PS3 / GameCube / Wii: NOT possible in a web browser -
   there is no working browser emulator for these; the real ones
   (PCSX2, xemu, RPCS3, Dolphin) are native programs that need a
   desktop GPU and JIT, which browsers don't allow.

   BUT ARCADE can still get them onto your TVs and phones: STREAMING
   MODE runs those native emulators on the host computer and streams
   the picture AND the sound to every device (synced H.264 on modern
   browsers, with an MJPEG fallback for old TVs), with the phone pad as
   the controller (tap "🔊 Tap for sound" on the stream to hear audio).
   Drop PS2 games in games/ps2 and XBOX games in games/xbox, set up
   the matching emulator once, and start with start-*-stream.
   Full instructions: SETUP-STREAMING.txt (ready-made emulator
   manifests are in emulators/_examples/; sound setup is section 3b).

10. TRULY OFFLINE (no internet)
   ARCADE's own UI is already 100% offline - the fonts and QR code
   library are bundled in assets/.

   NO ROUTER EITHER? You don't need one. The "fully offline network"
   folder turns the host computer itself into the WiFi network:
   run "1 - START offline WiFi" for your OS, connect the phones/TVs
   to that network (name REEL by default), start ARCADE as usual and
   open the WiFi address the server prints. Everything - games,
   saves, the phone pad, streaming mode - works on that hotspot with
   zero internet. See "READ ME FIRST.txt" in that folder.

   Two things normally come from the internet, and here's how to
   handle each:

   a) The emulator engine + cores (the actual NES/SNES/N64/PS1/...
      emulators). To make these offline:
         Windows : double-click  download-offline-windows.bat
         macOS   : double-click  download-offline-mac.command
         Linux   : ./download-offline-linux.sh
      Run it ONCE while you have internet. It saves everything into
      the emulatorjs/ folder. After that, the page shows
      "offline-ready" and never touches the internet again - cores
      and all. It only downloads cores for systems you have games for;
      add "--all" to grab every system's core.
      (Cores are big - very roughly 10-50 MB each - so this can take a
      while and use a few hundred MB if you grab everything.)

      Alternative without the script: while online, just open each
      system once and play a game. EmulatorJS caches that core in the
      browser, so it works offline afterwards on that device.

   b) Java phone (J2ME) games CANNOT be made offline. They run through
      an external engine (FreeJ2ME-web) that streams a Java runtime
      from the internet, so J2ME needs a connection. Everything else
      works with the internet unplugged once step (a) is done.
