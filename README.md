# web-dvd-player

A web-based player for DVDs saved as a `.ISO` or `.CDR` file — played directly,
**with the disc's interactive menus**, as if the DVD were in a real player.

It runs [VLC](https://www.videolan.org/vlc/) compiled to WebAssembly entirely in
the browser, so it can be hosted as a static site (GitHub Pages). The disc image
is read straight from your computer, on demand; nothing is uploaded and the image
is never loaded into memory as a whole, so dual-layer (> 4 GB) images work.

## What works

- **DVD menus**: the disc starts on its menu; highlight buttons with the arrow
  keys and select with Enter, or hover/click (tap) buttons directly on the picture.
  Still menus, motion menus, menu → title → menu flows, and all the DVD-VM
  navigation commands are handled by libdvdnav, exactly as in desktop VLC.
- **Menu / Title (top) menu / Resume** buttons, like a remote control.
- Titles and chapters (previous/next, pick from a list), seeking, pause, ±10 s.
- **Protection-aware seeking**: some discs hide decoy cells (junk or
  unreadable video) inside a title, which normal playback skips through the
  disc's own navigation commands, but a plain seek can land in. Seeking, the
  seek bar and the displayed duration follow the cells that playback really
  goes through: the title's navigation program is replayed from its start on
  a copy of the player state (like fast-forwarding through the disc's logic,
  without decoding video), and the player jumps to the resulting state.
- Audio track and subtitle selection (DVD sub-pictures, including menu
  highlights), volume/mute, deinterlacing, fullscreen.
- MPEG-2 video; AC-3, MPEG audio, LPCM and DTS audio (FFmpeg).
- CSS-scrambled discs: **libdvdcss** descrambles on the fly (title keys are
  recovered from the image itself, as there is no drive to ask). Because the
  player follows the disc's own navigation program, like a hardware player,
  rather than copying title files, structure-based protections that target
  rippers generally don't get in the way.

### Controls

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> | Move between menu buttons |
| <kbd>Enter</kbd> | Select the highlighted button |
| <kbd>M</kbd> | Menu (root menu of the current title) |
| <kbd>T</kbd> | Title / top menu of the disc |
| <kbd>Backspace</kbd> / <kbd>Esc</kbd> | Leave the menu and resume playback |
| <kbd>Space</kbd> | Play / pause |
| <kbd>PageUp</kbd> / <kbd>PageDown</kbd> | Previous / next chapter |
| <kbd>J</kbd> / <kbd>L</kbd> | Back / forward 10 seconds |
| <kbd>F</kbd> | Fullscreen (or double-click the picture) |
| <kbd>V</kbd> | Mute |

## Using it

Open the site, then drop a `.iso` / `.cdr` file on the page (or use
**Open disc image…**). A `.cdr` file (macOS "DVD/CD master") is a plain ISO
image, so both work the same way.

Requirements: a recent desktop Chrome or Edge (tested with Chromium). Firefox
should work but is untested. The page needs WebAssembly threads
(`SharedArrayBuffer`), `OffscreenCanvas` with WebGL 2, and `AudioWorklet`. The
engine is a ~20 MB download.

GitHub Pages cannot send the `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` headers that threads require, so the page
registers a small service worker ([coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker))
that adds them; on the very first visit the page reloads itself once.

## Deploying to GitHub Pages

1. In the repository settings: **Settings → Pages → Build and deployment →
   Source: GitHub Actions**.
2. Push to `main`. The **Deploy to GitHub Pages** workflow publishes the site.

   Alternatively, choose **Source: Deploy from a branch** with the `/ (root)`
   folder: `index.html` lives at the repository root, so it is served as is
   (`.nojekyll` disables Jekyll processing).

The prebuilt engine is committed in `vlc/`, so no compilation is needed to
deploy. To rebuild it from source, run the **Build VLC WebAssembly** workflow
(Actions tab → *Run workflow*); it builds, runs the end-to-end test and commits
the new `vlc/`.

To try it locally, serve the repository root over HTTP, e.g. `python3 -m http.server`
and open <http://localhost:8000> (the service worker also works on `localhost`).

## How it works

```
 page (main thread)            VLC (WebAssembly, ~40 pthreads = Web Workers)
 ─────────────────            ─────────────────────────────────────────────
 js/app.js       ──commands──▶ control thread (build/src/dvdplayer.c) ── libVLC
        ▲          (queue)                                                 │
        │ state snapshot (shared memory) + async events                    ▼
        │                       input: emjsfile access (File.slice + FileReaderSync)
        │                         └▶ dvdnav demux: libdvdnav + libdvdread + libdvdcss
        │                              └▶ decoders: FFmpeg (MPEG-2, AC-3, DTS…), spudec
        │                                   ├▶ video output: WebGL 2 on OffscreenCanvas
 <canvas> ◀── ImageBitmap frames ───────────┘    (+ sub-pictures / menu highlights)
 AudioWorklet ◀── shared ring buffer ─────── audio output (emworklet_audio)
```

- `build/build.sh` fetches emscripten 3.1.18, VLC (pinned) and the
  [vlc.js](https://code.videolan.org/jbk/vlc.js) port patches, applies this
  project's patches (`build/patches/`), builds the contribs (FFmpeg, libdvdcss,
  libdvdread, libdvdnav, zlib) and VLC, and links them with
  `build/src/dvdplayer.c` into `vlc/dvdplayer.{js,wasm,worker.js}`.
- The page never calls libVLC synchronously: several VLC threads wait on the
  browser's main thread (WebGL/OffscreenCanvas setup, file hand-off, audio),
  so a blocked main thread would deadlock. Commands are queued to a control
  thread instead, and the UI reads a state snapshot from shared memory.

Patches on top of VLC + vlc.js (`build/patches/`):

1. Build the DVD contribs for WebAssembly (libdvdcss without drive ioctls,
   libdvdread byte-swap headers) and only the contribs that are needed.
2. `emjsfile`: 64-bit file offsets, so images larger than 4 GiB play.
3. Emscripten window: forward mouse/touch events, for clicking menu buttons.
4. Video output: release the display on the thread owning its WebGL context
   (title changes used to crash).
5. Threads: keep emscripten pthreads alive across ASYNCIFY suspensions
   (threads were being reported finished and their workers recycled while
   still suspended).
6. libdvdnav: clear a stale "skip still" request when jumping, so calling the
   menu right after a title/chapter jump no longer stops playback.
7. Audio output: a fixed stereo output that every stream is converted to
   (mono, 5.1 and other layouts used to come out garbled whenever they
   differed from the first stream), proper ring-buffer flow control, latency
   reporting for A/V sync (smoothed, as the browser renders audio in bursts
   and a jittery audio clock made the video stutter), and pause without
   dropping audio.
8. dvdnav: execute mouse clicks on menu buttons on the demux thread (they
   could deadlock playback when run on the video output thread).
9. libdvdnav + dvdnav: seek along the real playback path of titles
   (`dvdnav_safe_time_search()`), so seeking never lands in decoy cells.

### Building locally

On Debian/Ubuntu (≈1–2 hours the first time, several GB of disk):

```bash
sudo apt-get install git curl python3 build-essential autoconf automake libtool libtool-bin \
  pkg-config gettext autopoint ragel flex bison help2man meson ninja-build nasm gperf ant cmake
build/build.sh          # full build
build/build.sh link     # only relink after editing build/src/dvdplayer.c
```

### Testing

`tools/make-test-dvd.sh` authors a small DVD-Video image with a real menu (two
buttons, four titles, chapters, stereo, mono and 5.1 AC-3 audio, a subtitle
track, and a title with a decoy cell skipped by a cell command, like
structure-protected discs) using ffmpeg, dvdauthor, ImageMagick and genisoimage. `tools/e2e-test.js`
drives the player in headless Chromium against it (menu clicks, title end →
menu, title and chapter changes, subtitles, pause, Menu/Resume, eject/re-open,
seeking past the decoy cell) and analyses the audio output of each title's
test tone to check it is undistorted:

```bash
tools/make-test-dvd.sh /tmp/test-dvd.iso
npm install --no-save playwright && npx playwright install chromium
node tools/e2e-test.js /tmp/test-dvd.iso
```

## Limitations

- Decoding is done in software (WebAssembly, no SIMD): SD MPEG-2 plays in real
  time on any recent desktop, but low-end phones may struggle.
- Blu-ray images are not supported (no libbluray/AACS in this build).
- Region codes are not enforced. Protection schemes other than CSS that rely on
  deliberately unreadable sectors may still fail, as they would in desktop VLC.
- Safari and Firefox are untested.

## License

VLC, libdvdnav, libdvdread, libdvdcss and FFmpeg (as configured here) are
licensed under the GNU GPL (v2 or later) / LGPL, so the combined WebAssembly
engine in `vlc/` is distributed under the **GPL-2.0-or-later**. Its complete
corresponding source is the pinned upstream sources plus the build script and
patches in `build/`. The coi-serviceworker script is MIT licensed.
