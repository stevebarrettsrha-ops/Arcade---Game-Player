# ARCADE — Capability Research & UI Redesign Proposal

*Deep-dive into what this webapp can do today, an audit of the current UI, and a
concrete plan to evolve it toward a modern game-streaming look (reference:
Amazon Luna's home screen) without losing what makes ARCADE special: zero
dependencies, fully offline, runs on weak TV browsers.*

---

## 1. What ARCADE is

A self-hosted "Netflix for your game library". One tiny Node.js server
(`server.js`, zero npm dependencies) serves a web page to every phone, tablet
and TV on the home WiFi. Games run three ways:

1. **In the browser** — EmulatorJS (RetroArch cores compiled to WASM) for
   GBA, NES, SNES, Genesis, GB/GBC, N64, PS1 (+ beta PSP), FreeJ2ME-web for
   Java phone games, PPSSPP-web for PSP.
2. **Streamed from the host** (opt-in) — native emulators (PCSX2, xemu,
   Dolphin, RPCS3, Project64, PPSSPP, KEmulator…) run on the host PC with full
   GPU/JIT power; ffmpeg captures and encodes the screen + audio and ARCADE
   streams it to every device. This covers the "impossible in a browser"
   systems: PS2, original Xbox, GameCube/Wii, PS3, full-speed N64/PSP.
3. **Phone as gamepad** — any phone scans a QR code and becomes a full
   controller (analog stick, 14 buttons, turbo, save/load, fast-forward) for
   the game running on the TV, in both browser and streaming modes.

## 2. Capability inventory

### 2.1 Server (`server.js`, ~900 lines, no dependencies)

| Area | What it does |
|---|---|
| Static serving | MIME table, HTTP Range (ROM seeking), ETag/304 revalidation, gzip for text, tiered cache policy (engine/cores 7d, ROMs 1d, HTML no-cache) |
| Library API | `GET /api/library` — all systems' games + BIOS presence + feature flags (offline engine, PPSSPP local copy, J2ME local copy, streaming on, host emulator list) |
| Thumbnails | `GET /thumb/<sys>/<file>` with a 5-level fallback chain (see 2.6), in-memory cache, ETag |
| Profiles | `POST /api/user/create`, `/api/user/login` — name + 4-digit PIN, scrypt-hashed, 12h session tokens; `GET /api/users` |
| Cloud-style saves | `POST /api/save`, `GET /api/load`, `GET /api/has` — per-user save states + SRAM under `users/<name>/saves/<system>/`, gzipped on disk (5–10× smaller), transparent decompression, legacy saves migrated at startup |
| Controller relay | `GET /events` (SSE) + `POST /input`, plus a hand-rolled RFC-6455 **WebSocket** relay at `/ws` for lower latency; rooms keyed by 4-char codes; automatic player-slot assignment (up to 4 pads), TTL-based slot recycling |
| Streaming routes | `/stream/start`, `/stream/stop`, `/stream/status`, `/stream/mux` (H.264+AAC fMP4 for MSE), `/stream/video` (MJPEG), `/stream/audio` (raw PCM) |
| Security | `/users/` and `/certs/` blocked over HTTP, path-traversal guard, PIN hashes never leave the server |
| HTTPS mode | optional self-signed TLS (`make-cert.js`) so CheerpJ/Java works on LAN devices (secure-context requirement) |

### 2.2 In-browser emulation

- Nine tabs of systems via EmulatorJS; save states, fast-forward, per-system
  remapping through EmulatorJS's gear menu.
- **Threaded cores** (`ARCADE_THREADS=1` / PSP mode): server sends
  COOP/COEP-credentialless headers to unlock SharedArrayBuffer for faster
  N64/PS1/PSP on Chromium/Firefox.
- **Performance mode** (⚡ button): disables shader/vsync, shows FPS, lowers
  N64/PS1/PSP internal resolution and adds frameskip — for weak TVs.
- **Auto-resume**: when a logged-in player launches a game, their latest server
  save state is loaded automatically; auto-save every 45s and on exit.
- J2ME: embedded FreeJ2ME-web handset iframe with fully automated jar
  injection (drives the launcher DOM), plus plain-language failure diagnosis
  (secure-context vs. offline). PSP: PPSSPP-web (local offline copy supported).

### 2.3 Host streaming mode (`stream.js`)

- Emulator registry: one folder + `emulator.json` manifest per emulator
  (`cmd` with `{rom}` placeholder, capture mode, window title, roms folder,
  extensions, optional icon). Six come pre-wired on Windows with a one-time
  downloader.
- Capture: ffmpeg per-OS (gdigrab / avfoundation / x11grab), window-only
  capture on Windows, test-pattern mode for pipeline debugging.
- Transport negotiated **per client**: H.264+AAC in fragmented MP4 over MSE
  (synced A/V, low bandwidth) with automatic fallback to MJPEG + raw-PCM Web
  Audio for old TV browsers. Client keeps itself near-live (buffer trimming,
  catch-up playback rate).
- Input injection on the host: **ViGEm virtual Xbox 360 pad** on Windows (true
  analog, zero per-emulator mapping) with automatic fallback to keyboard
  injection (PowerShell / xdotool / osascript), including a dedicated analog
  key set (U/N/H/M).
- Phones can browse and launch host games (PS2/Xbox/…) from the sofa; the pad
  keeps working across browser and streamed games identically.

### 2.4 Phone controller (`pad.html`, `pad2.html`)

- Landscape gamepad: analog stick (digital 8-way + true analog axis), classic
  cross D-pad, ABXY diamond, 4 shoulders, start/select, turbo, save/load, FF.
- **Layout editor**: drag any control anywhere, resize per control, saved per
  device. Multitouch with pointer capture, haptics.
- Multiplayer: stable controller IDs, automatic P1–P4 slot assignment, manual
  slot picker, Player-1-controlled 4-player mode (flips PS1 multitap and
  relaunches). TV shows "P1 + P2 connected".
- Games drawer: full library + host emulator games, launches on the TV.
- `pad2.html`: a Nokia-style keypad (softkeys, D-pad + fire, 0–9, *, #) for
  J2ME games under KEmulator.
- WebSocket first, HTTP-POST fallback; link-status dot; wake-lock-ish
  fullscreen + orientation lock.

### 2.5 Cover art pipeline

Priority chain, all offline-capable: ① same-named image next to the ROM →
② real boxart fetched once by `get-boxart.js` (libretro-thumbnails matching)
→ ③ icon embedded in the game itself (jar icon via a built-in ZIP reader,
ICON0.PNG parsed out of PSP/PS1 `.pbp` EBOOTs and even out of ISO9660 PSP
images) → ④ legacy live GBA boxart → ⑤ **generated SVG cover tile**
(deterministic per game: system accent hue-shifted by name hash, three pattern
styles, monogram initials).

### 2.6 Offline story

Bundled fonts + QR library; one-time downloader for the EmulatorJS engine +
cores; "fully offline network" scripts that turn the host into a WiFi hotspot;
everything except CheerpJ (Java) works with zero internet.

**The takeaway: the backend is genuinely rich.** Profiles, per-user cloud
saves, multi-device streaming, 4-player phone controllers, a five-level art
pipeline. The current UI surfaces almost none of that richness on the home
screen — which is exactly where the Luna reference wins.

---

## 3. Current UI audit (`index.html`)

**Aesthetic:** CRT-cyber glassmorphism — animated gradient blobs, grid
overlay, scanlines, vignette, Silkscreen pixel font + Chakra Petch, per-system
accent colors. Distinctive and coherent.

**Structure:** brand header → utility buttons (👤 user, 📱 Phone, ⚡ Perf,
🖥️ Host) → 9 system tabs with counts → one flat card grid per tab → stages
(player / J2ME frame / stream view) replace the library while playing.

### What works

- Great empty states (tell you exactly which folder and file types).
- Status pill ("42 games · offline-ready") and pairing panel with QR + live
  "P1 + P2 connected" readout.
- Per-system accents carried through tabs, cards, buttons.
- Card hover affordances (lift, sheen sweep, play chip).
- Launch-from-phone, profile PIN pad, toasts — all solid interaction work.

### Gaps (ranked by impact)

1. **IA is folder-shaped, not player-shaped.** Nine tabs mirror the `games/`
   directory. There is no "Continue playing", no "Recently added", no
   cross-system view, no search — even though the server already knows every
   user's saves (`/api/has`) and every file's mtime. A player with games in 4
   folders must click 4 tabs to see their library.
2. **No hero / zero merchandising.** The top of the page is chrome (brand +
   buttons). Nothing invites you to *play the thing you were playing last
   night*. Luna's whole above-the-fold is one game with art, a pitch line and
   one CTA.
3. **Art is fighting the card shape.** Cards are landscape with a 104px art
   strip; real console boxart is portrait 2:3, so downloaded covers get
   cropped to a letterbox slice. The generated SVG tiles are landscape
   (320×140) for the same reason. Luna's shelf is portrait cards — art-first.
4. **No 10-foot (TV) navigation.** Cards are `<button>`s so Tab works, but
   there is no arrow-key spatial navigation, no visible focus ring (hover
   styles only), no "focus enlarges card". TV browsers send arrow keys from
   the remote — this is the single highest-value addition for the TV use case.
5. **Streaming mode is a hidden side-door.** Host emulators (the headline
   PS2/Xbox capability!) live behind a small top-right button that only
   appears when streaming is on, in a separate picker. They should be shelves
   and cards in the same library, badged "PLAYS ON HOST".
6. **Metadata on cards is developer-facing.** `GBA · 4.2 MB` — file size and
   extension are not player-relevant. Players care about: system, do I have a
   save, is it multiplayer.
7. **Login modal blocks the library** on every new session before the player
   sees anything. Luna-style: browse freely, gate only save-touching actions,
   pick profile from the avatar in the nav.
8. **Chrome cost on weak TVs.** `blur(70px)` animated blobs, `backdrop-filter`
   on dozens of elements, scanline overlay, per-card animation. The app ships
   a Performance mode for the *emulator* but the *page itself* is expensive.
   (Also: `color-mix()` and `backdrop-filter` already set a fairly modern CSS
   floor — old-TV fallback styling deserves an explicit strategy.)
9. Vestigial code: `index.html` still carries a full copy of the old in-page
   pad (`#padRoot`, `initController`) that is dead since `?pad=` now redirects
   to `pad.html` — ~150 lines of markup/CSS/JS to delete.

---

## 4. Deconstructing the Luna reference

What the screenshot actually does, element by element, and what each maps to
in ARCADE:

| Luna element | Purpose | ARCADE equivalent (mostly already built!) |
|---|---|---|
| Top nav: Home / GameNight / My Stuff / Remote Play + NEW pill | Player-shaped IA, not catalog-shaped | Home / **My Games** (profile saves) / **Play on Host** (streaming) / system browser |
| Search icon + profile avatar (top right) | Instant access, identity | client-side search over `/api/library`; existing profile system → avatar menu |
| Full-bleed hero carousel with key art, logo, one-line pitch, **More Info** CTA, pagination dots | Merchandise one game at a time | rotate: last-played game ("Continue"), newest additions, random pick; art from the thumb pipeline + accent gradient |
| "GN — Use Phones As Controllers" capability badge on the hero | Advertise the platform feature in context | ARCADE literally has this feature — badge links to the QR pairing panel |
| "Top New Games" ranked shelf — huge rank numerals behind portrait cards | Editorial energy, scannability | "Recently added" ranked by file mtime, same numeral treatment |
| Portrait boxart cards, horizontal scroll, edge chevron | Art-first browsing, rows scale infinitely | portrait cards + per-system shelves; boxart finally displays uncropped |
| Dark, art-forward chrome | The art provides the color; UI recedes | keep the ARCADE palette but calm the effects; let covers carry the screen |

Key insight: **Luna's rows are behavioral/editorial ("Top New Games"), not
taxonomic ("SNES")**. ARCADE has all the data needed for behavioral rows —
save files timestamp what you play, file mtimes timestamp what's new — it just
never queries itself.

---

## 5. Redesign proposal

### 5.1 Information architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ ARCADE·DECK   Home   Systems ▾   Play on Host   My Games    🔍 📱 ⚡ 👤│
├──────────────────────────────────────────────────────────────────────┤
│  HERO: last-played game, full-width art + accent gradient            │
│  "Zelda: Minish Cap" · GBA · 📱 phones are controllers               │
│  [▶ Continue]  [ⓘ Details]                        ● ○ ○ ○ ○          │
├──────────────────────────────────────────────────────────────────────┤
│  Continue playing        [card][card][card]              →           │
│  Top new in your library 1[card] 2[card] 3[card] 4[card] →           │
│  Plays on host · PS2/Xbox [card][card]  (streaming mode) →           │
│  Game Boy Advance        [card][card][card][card]        →           │
│  Nintendo 64             [card][card]                    →           │
│  …one shelf per non-empty system; tab row becomes "Systems" browser  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Home** replaces the tab wall: hero + horizontal shelves. Shelves render
  only when non-empty, so a GBA-only library shows a clean 2-shelf page.
- **Systems** keeps the current per-system grid (it's good for big
  collections) — reached from the nav or a shelf's "See all →".
- **Play on Host** merges streaming into the library: host games get normal
  cards with a `HOST` badge instead of living in a separate stage; the
  separate picker remains as the "See all" page.
- **My Games** = everything the signed-in profile has a save for.

### 5.2 Hero carousel

- Slides: ① last save (→ "Continue"), ② newest addition (→ "Play"),
  ③ a host-streaming headline when stream mode is on ("PS2 on every screen —
  phones are the controllers"), ④ pairing promo with inline QR.
- Background: the game's cover, blown up + blurred + darkened under an accent
  gradient (all local; no network). Generated-tile games get a pure gradient
  hero — still handsome because accents are deterministic per game.
- One primary CTA per slide. Pagination dots; auto-advance ~8s, pauses on
  focus/hover; arrow-key reachable.

### 5.3 Shelves

- Horizontal scroll rows (`scroll-snap-type: x mandatory`), 6–8 cards
  visible on TV, edge chevrons on hover/focus, CSS-only where possible.
- **Continue playing** — needs one new endpoint (see §6): list of the user's
  saves with mtimes, newest first.
- **Top new** — `listGames()` gains an `mtime` field; rank numerals rendered
  as large outlined text behind the first 6 cards (pure CSS, like Luna).
- **Multiplayer night** (later): games flagged 2–4P get a shelf; pairs
  naturally with the 4-player pad feature.

### 5.4 Cards

- **Portrait 2:3** (Luna-style) as the primary card: real boxart finally
  shows uncropped; jar/PSP icons get the pixelated-contain treatment on an
  accent gradient; generated covers switch to a portrait variant of
  `genCover()` (same hash → same identity, new 300×450 canvas).
- Metadata: title + system chip only. Replace `EXT · MB` with badges that
  matter: `💾 SAVE` (profile has a save), `HOST` (streamed), `2–4P`.
- Keep the hover/focus lift + sheen; add a strong `:focus-visible` ring in
  the system accent.

### 5.5 10-foot / TV navigation (highest-impact engineering item)

- Arrow-key **spatial navigation**: rows are focus groups; ←/→ move within a
  shelf (auto-scrolling it), ↑/↓ move between hero → shelves → nav; Enter
  launches; Backspace/Escape backs out. ~80 lines of vanilla JS; no
  framework needed.
- Focus ring: 3px accent outline + slight scale — visible from the couch.
- Initial focus lands on the hero CTA when the page loads on a
  non-touch device.
- Safe-area margins and ≥16px base font at TV distances.

### 5.6 Search & filters

- `/` or the 🔍 button opens an overlay: fuzzy title match across all
  systems + host games (the whole library is already client-side in `LIB`).
  Results reuse the card component. On TV, an on-screen keyboard grid is a
  later nice-to-have; text input works on phones/desktops day one.

### 5.7 Profiles

- Kill the blocking modal: land on Home as Guest, put profiles behind the
  avatar (top right, Luna-style). Prompt for profile only on first
  save-relevant action ("Sign in so this save is yours?").
- Avatar chip = monogram on the profile's own accent color (reuse the
  deterministic hash → color trick from `genCover`).
- "Who's playing?" full-screen picker remains for TV startup — it's a good
  pattern (Netflix does it) — but with Skip visible and library visible
  behind it.

### 5.8 Visual language & chrome performance

- Keep the identity (Silkscreen + Chakra Petch, cyan/amber, dark). Calm the
  effects: cap `backdrop-filter` usage to the nav bar, drop the animated
  blobs + scanlines on TVs (`prefers-reduced-motion`, a UA/size heuristic, or
  simply tie chrome-lite to the existing ⚡ Performance flag).
- The art becomes the color of the page (Luna's trick): hero + portrait
  covers supply saturation, chrome goes near-monochrome.

---

## 6. Small server additions required

Everything above needs remarkably little backend work:

| Feature | Change | Size |
|---|---|---|
| Recently added shelf | add `mtime` to `listGames()` output | ~2 lines |
| Continue playing shelf | new `GET /api/saves?token=` → walk `users/<u>/saves/`, return `{system, game, mtime}` newest-first (join to library entries client-side) | ~25 lines |
| Portrait generated covers | portrait variant in `genCover()` + `?shape=portrait` on `/thumb/` | ~20 lines |
| Save badges on cards | batch `GET /api/has-all?token=` (or fold into `/api/saves`) instead of N× `/api/has` | ~10 lines |
| Host games in the main library | already in `/api/library` (`emulators[].games`) — purely a front-end merge | 0 |
| Search | client-side over existing `LIB` | 0 |

No new dependencies, no schema changes, saves stay plain files on disk.

## 7. Phased roadmap

1. **Phase 1 — cards & focus (pure front-end).** Portrait cards, badge
   metadata, `:focus-visible` rings, arrow-key spatial nav, delete the dead
   in-page pad code. Biggest visible win, zero server risk.
2. **Phase 2 — Home.** Hero carousel + shelves (Continue / Top new /
   per-system), `mtime` + `/api/saves` endpoints, non-blocking profiles.
   Tabs survive as the Systems browser.
3. **Phase 3 — one library.** Merge host-streaming games as badged cards,
   search overlay, chrome-lite mode for TVs.
4. **Phase 4 — delight.** Multiplayer shelf + GameNight-style party flow
   (QR on the hero), per-profile accent avatars, on-screen search keyboard
   for TV.

## 8. Constraints to respect

- **Zero-dependency ethos**: everything stays vanilla HTML/CSS/JS in the
  existing files; no build step, no framework, assets bundled for offline.
- **Offline-first**: hero/shelf art must come from `/thumb/` and gradients —
  never a CDN.
- **Old TV fallback**: the MJPEG path proves ancient browsers are a real
  target; new CSS should degrade (grid → block, snap-scroll → plain
  overflow-x) and the JS nav must no-op safely.
- **Don't regress the pad**: `pad.html` is already excellent (layout editor,
  multi-slot, WS fallback) — Phase work is library-side; the pad only gains
  cosmetic alignment with the new card/badge language.
