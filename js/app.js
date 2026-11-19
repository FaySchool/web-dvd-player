// Web DVD Player — UI controller around the VLC WebAssembly build.
//
// The heavy lifting (reading the disc image, DVD VM/menus, CSS decryption,
// demuxing, MPEG-2/AC-3 decoding, sub-picture/highlight rendering, audio
// output) all happens inside VLC (libdvdnav + libdvdread + libdvdcss +
// FFmpeg). This file only wires DOM events to the exported C functions in
// build/src/dvdplayer.c and reflects player state back into the UI.
//
// IMPORTANT: the page never calls libvlc synchronously. Commands are queued
// to a VLC-side control thread and state is read from a snapshot in shared
// memory. Blocking the main thread on a VLC lock would deadlock VLC threads
// that wait for the main thread's event loop (see dvdplayer.c).

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'),
  canvas: $('canvas'),
  dropzone: $('dropzone'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  loadingTitle: $('loading-title'),
  loadingBar: $('loading-bar'),
  loadingFill: $('loading-fill'),
  viewport: $('viewport'),
  error: $('error'),
  errorTitle: $('error-title'),
  errorText: $('error-text'),
  osd: $('osd'),
  fileInput: $('file-input'),
  seek: $('seek'),
  timeCur: $('time-cur'),
  timeLen: $('time-len'),
  play: $('btn-play'),
  volume: $('volume'),
  selTitle: $('sel-title'),
  selChapter: $('sel-chapter'),
  selAudio: $('sel-audio'),
  selSpu: $('sel-spu'),
  selDeint: $('sel-deint'),
  status: $('status'),
  help: $('help'),
};

// ---- Constants shared with build/src/dvdplayer.c --------------------------
const EV = {
  OPENING: 1, BUFFERING: 2, PLAYING: 3, PAUSED: 4, STOPPED: 5, ERROR: 6,
  TIME: 7, LENGTH: 8, TITLE: 9, TITLE_LIST: 10, CHAPTER: 11, TRACKS: 12, VOUT: 13,
};
const CMD = {
  OPEN: 1, PLAY: 2, SET_PAUSE: 3, STOP: 4, SET_TIME: 5, SET_POSITION: 6,
  NAVIGATE: 7, SET_TITLE: 8, SET_CHAPTER: 9, NEXT_CHAPTER: 10, PREV_CHAPTER: 11,
  SELECT_TRACK: 12, SET_VOLUME: 13, SET_MUTE: 14, DEINTERLACE: 15, MOUSE: 16,
  SET_RATE: 17, MENU: 18, SEEK: 19,
};
const ST = {
  STATE: 0, TIME: 1, LENGTH: 2, POSITION: 3, TITLE: 4, TITLE_COUNT: 5,
  CHAPTER: 6, CHAPTER_COUNT: 7, VOLUME: 8, MUTE: 9, SEEKABLE: 10, VOUTS: 11,
  JSON_VERSION: 12, RATE: 13, SEEK_TARGET: 14, VIDEO_DAR: 15,
};
const JSON_KIND = { titles: 0, audio: 1, spu: 2 };
// libvlc_state_t
const PSTATE = { idle: 0, opening: 1, buffering: 2, playing: 3, paused: 4, stopped: 5, stopping: 6, error: 7 };
// libvlc_navigate_mode_t
const NAV = { activate: 0, up: 1, down: 2, left: 3, right: 4 };
// libvlc_track_type_t
const TRACK = { audio: 0, video: 1, text: 2 };
// Seekpoints of VLC's dvdnav "title 0" (the menu pseudo-title)
const MENU_SEEKPOINT = { resume: 0, root: 1, title: 2, chapter: 3, subtitle: 4, audio: 5, angle: 6 };
const MENU_NAMES = ['Resume', 'Root menu', 'Title menu', 'Chapter menu', 'Subtitle menu', 'Audio menu', 'Angle menu'];

// The VLC window renders into a fixed 1280x720 surface (see the emscripten
// window module), which is then drawn on our canvas.
const SURFACE_W = 1280;
const SURFACE_H = 720;

const VLC_ARGS = [
  '--no-video-title-show',
  '--aout=emworklet_audio',
  '--codec=avcodec,any',      // FFmpeg for MPEG-2/AC-3/DTS/LPCM; spudec for DVD sub-pictures
  '--avcodec-threads=2',
  '--deinterlace=-1',
  '--deinterlace-mode=blend',
  '--dvdnav-menu',            // start on the disc's menu like a real player
  '--file-caching=500',
  '--disc-caching=500',
  '--ignore-config',
  '--no-stats',
];
const debugLevel = new URLSearchParams(location.search).get('debug');
if (debugLevel !== null) VLC_ARGS.push(debugLevel === '1' ? '-v' : '-vv');
// Diagnostics: extra VLC options, e.g. ?vlcargs=--avcodec-threads=4,--disc-caching=1000
const extraArgs = new URLSearchParams(location.search).get('vlcargs');
if (extraArgs) VLC_ARGS.push(...extraArgs.split(',').map((a) => a.trim()).filter((a) => a.startsWith('--')));

// ---- Engine facade --------------------------------------------------------
let Module = null;
let statePtr = 0;
let enginePromise = null;

const vlc = {
  cmd(op, i0 = 0, i1 = 0, i2 = 0, i3 = 0, d = 0) {
    if (Module) Module._dvd_cmd(op, i0, i1, i2, i3, d);
  },
  cmdStr(op, i0, str) {
    if (Module) Module.ccall('dvd_cmd_str', null, ['number', 'number', 'string'], [op, i0, str]);
  },
  st(i) {
    return Module ? Module.HEAPF64[(statePtr >> 3) + i] : 0;
  },
  json(kind) {
    if (!Module) return [];
    const ptr = Module._dvd_get_json(kind);
    if (!ptr) return [];
    try {
      return JSON.parse(Module.UTF8ToString(ptr));
    } catch (e) {
      console.warn('bad JSON from engine', e);
      return [];
    } finally {
      Module._free(ptr);
    }
  },
};

// ---- UI state -------------------------------------------------------------
let fileId = 0;
let currentName = '';
const ui = {
  loaded: false,
  seeking: false,
  seekShown: false,
  awaitingFrame: false, // loading overlay shown until the disc's first frame
  dar: 16 / 9,          // display aspect ratio of the video
  hasVideo: false,
  jsonVersion: -1,
};

// --------------------------------------------------------------------------
// Engine bootstrap
// --------------------------------------------------------------------------

function showOverlay(which) {
  for (const o of [el.dropzone, el.loading, el.error]) o.classList.toggle('hidden', o !== which);
}

function fatal(title, text) {
  el.errorTitle.textContent = title;
  el.errorText.textContent = text;
  showOverlay(el.error);
  setStatus(title);
}

function setStatus(text) { el.status.textContent = text; }

// Loading panel over the picture. progress: 0..1, or null when unknown.
function setLoading(title, detail, progress = null) {
  if (title != null) el.loadingTitle.textContent = title;
  if (detail != null) el.loadingText.textContent = detail;
  const known = progress != null && Number.isFinite(progress);
  el.loadingBar.classList.toggle('indeterminate', !known);
  el.loadingFill.style.width = known ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` : '';
  if (known) el.loadingBar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  else el.loadingBar.removeAttribute('aria-valuenow');
}

const fmtMB = (bytes) => (bytes / 1048576).toFixed(1);

// Download and compile the engine (~20 MB of WebAssembly) ourselves to report
// progress: streamed through instantiateStreaming, so compilation overlaps the
// download. Plugged into emscripten through Module.instantiateWasm.
function instantiateWithProgress(imports, receiveInstance, onFail) {
  (async () => {
    const response = await fetch('vlc/dvdplayer.wasm', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not download the engine (HTTP ${response.status}).`);
    // The size is only usable when the body is not transfer-compressed
    const length = Number(response.headers.get('Content-Length')) || 0;
    const total = response.headers.get('Content-Encoding') ? 0 : length;
    let received = 0;
    const counted = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          setLoading(null, total
            ? `Downloading the VLC engine: ${fmtMB(received)} of ${fmtMB(total)} MB`
            : `Downloading the VLC engine: ${fmtMB(received)} MB`,
          total && received <= total ? received / total : null);
          controller.enqueue(value);
        }
        controller.close();
        setLoading(null, 'Starting the VLC engine…', null);
      },
    });
    const wasmResponse = new Response(counted, { headers: { 'Content-Type': 'application/wasm' } });
    let result;
    if (WebAssembly.instantiateStreaming) {
      result = await WebAssembly.instantiateStreaming(wasmResponse, imports);
    } else {
      result = await WebAssembly.instantiate(await wasmResponse.arrayBuffer(), imports);
    }
    // The module is also needed to start the engine's worker threads
    receiveInstance(result.instance, result.module);
  })().catch(onFail);
  return {}; // asynchronous instantiation
}

// VLC presents video frames on the page canvas through Module.canvasCtx,
// which it only creates if not set: provide it, to notice the first frame of
// a disc (which ends the loading overlay) without patching VLC.
function installFrameHook(mod) {
  const onFrame = () => {
    if (ui.awaitingFrame) {
      ui.awaitingFrame = false;
      ui.hasVideo = true;
      showOverlay(null);
    }
  };
  const bitmap = el.canvas.getContext('bitmaprenderer');
  if (bitmap) {
    mod.canvasCtx = {
      transferFromImageBitmap(b) { bitmap.transferFromImageBitmap(b); onFrame(); },
    };
  } else {
    const ctx2d = el.canvas.getContext('2d');
    ctx2d.globalCompositeOperation = 'copy';
    mod.canvasCtx = {
      drawImage(...args) { ctx2d.drawImage(...args); onFrame(); },
    };
  }
}

function environmentProblem() {
  if (typeof WebAssembly !== 'object') return 'This browser does not support WebAssembly.';
  if (!window.crossOriginIsolated) {
    return 'The page is not cross-origin isolated, so WebAssembly threads (SharedArrayBuffer) are unavailable.\n\n' +
      'Reload the page once so the helper service worker can enable it. If this keeps happening, make sure ' +
      'the site is served over HTTPS (or localhost) and that service workers / cookies are not blocked ' +
      '(private browsing modes sometimes block them).';
  }
  if (typeof OffscreenCanvas === 'undefined') return 'This browser does not support OffscreenCanvas, which VLC uses for video output.';
  if (typeof AudioWorkletNode === 'undefined') return 'This browser does not support AudioWorklet, which VLC uses for audio output.';
  return null;
}

function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const problem = environmentProblem();
    if (problem) throw new Error(problem);
    if (typeof window.createVlcModule !== 'function') {
      throw new Error('vlc/dvdplayer.js is missing. Build it with build/build.sh (see README).');
    }
    setLoading('Loading the player', 'Downloading the VLC engine…', 0);
    showOverlay(el.loading);
    setStatus('Loading VLC engine…');

    let failInstantiate;
    const instantiateFailed = new Promise((_, reject) => { failInstantiate = reject; });
    const mod = await Promise.race([
      window.createVlcModule({
        canvas: el.canvas,
        vlc_access_file: {},
        print: (t) => console.log(t),
        printErr: (t) => console.warn(t),
        locateFile: (path) => 'vlc/' + path,
        mainScriptUrlOrBlob: new URL('vlc/dvdplayer.js', location.href).href,
        instantiateWasm: (imports, receive) => instantiateWithProgress(imports, receive, failInstantiate),
      }),
      instantiateFailed,
    ]);
    mod.onPlayerEvent = onPlayerEvent;
    installFrameHook(mod);

    // libvlc_new(argc, argv) — the only synchronous libvlc call, made before
    // any media (and thus any VLC thread needing the main thread) exists.
    const ptrs = VLC_ARGS.map((a) => {
      const n = mod.lengthBytesUTF8(a) + 1;
      const p = mod._malloc(n);
      mod.stringToUTF8(a, p, n);
      return p;
    });
    const argv = mod._malloc(4 * ptrs.length);
    ptrs.forEach((p, i) => { mod.HEAPU32[(argv >> 2) + i] = p; });
    const rc = mod._dvd_init(ptrs.length, argv);
    if (rc !== 0) throw new Error('libVLC failed to initialise (see the browser console).');

    statePtr = mod._dvd_state();
    Module = mod;
    window.vlcModule = mod;
    window.dvd = { vlc, CMD, ST }; // handy for debugging from the console
    setStatus('VLC engine ready.');
    return mod;
  })();
  enginePromise.catch((e) => {
    enginePromise = null;
    console.error(e);
    fatal('Could not start the player', e.message || String(e));
  });
  return enginePromise;
}

// --------------------------------------------------------------------------
// Opening a disc image
// --------------------------------------------------------------------------

async function openFile(file) {
  if (!file) return;
  // Create/resume the audio context while we still hold the user gesture.
  unlockAudio();

  let mod;
  try {
    mod = await loadEngine();
  } catch {
    return;
  }

  if (ui.loaded) vlc.cmd(CMD.STOP);
  resetUi();

  setLoading(`Opening “${file.name}”`, 'Reading the disc structure…', null);
  showOverlay(el.loading);
  ui.awaitingFrame = true;
  // Opening can take a while: reading IFOs from a slow disk, and on
  // CSS-encrypted discs, recovering the title keys from the image.
  clearTimeout(ui.slowOpenTimer);
  ui.slowOpenTimer = setTimeout(() => {
    if (ui.awaitingFrame && el.loadingBar.classList.contains('indeterminate')) {
      setLoading(null, 'Still reading the disc structure and decryption keys. ' +
        'Encrypted discs can take up to a minute to open.', null);
    }
  }, 5000);

  // VLC's "emjsfile" access module reads the File object lazily, in slices,
  // from a worker thread — the image is never loaded into memory at once.
  fileId += 1;
  mod.vlc_access_file[fileId] = file;
  currentName = `${file.name} (${(file.size / 1e9).toFixed(2)} GB)`;
  vlc.cmdStr(CMD.OPEN, 1, `emjsfile://${fileId}`);
  ui.loaded = true;
  document.title = `${file.name.replace(/\.[^.]+$/, '')} — Web DVD Player`;
  setStatus(`Opening ${currentName}…`);
  applyDeinterlace();
  applyVolume();
  el.stage.focus({ preventScroll: true });
}

function resetUi() {
  ui.hasVideo = false;
  ui.awaitingFrame = false;
  clearTimeout(ui.slowOpenTimer);
  clearTimeout(ui.bufferStallTimer);
  ui.dar = 16 / 9;
  layoutViewport();
  ui.jsonVersion = -1;
  for (const s of [el.selTitle, el.selChapter, el.selAudio, el.selSpu]) {
    s.innerHTML = '';
    s.dataset.sig = '';
    s.disabled = true;
  }
  el.seek.value = 0;
  el.seek.disabled = true;
  el.timeCur.textContent = el.timeLen.textContent = '0:00';
  el.play.classList.remove('playing');
  try {
    // VLC presents frames through an ImageBitmapRenderingContext (falling
    // back to 2D); clear whichever the canvas uses.
    const ctx = el.canvas.getContext('bitmaprenderer') || el.canvas.getContext('2d');
    if (ctx.transferFromImageBitmap) ctx.transferFromImageBitmap(null);
    else ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  } catch {}
}

function unlockAudio() {
  // VLC's audio output creates its AudioContext lazily; browsers only let it
  // start after a user gesture, so resume it on every interaction.
  const ctx = Module && Module.webaudioContext;
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

// --------------------------------------------------------------------------
// Player events (from C, delivered asynchronously on the main thread)
// --------------------------------------------------------------------------

function onPlayerEvent(kind, value) {
  if (!ui.loaded) return;
  switch (kind) {
    case EV.OPENING:
      setStatus(`Opening ${currentName}…`);
      break;
    case EV.BUFFERING:
      if (ui.awaitingFrame) {
        clearTimeout(ui.slowOpenTimer);
        setLoading(null, value >= 100 ? 'Starting playback…' : `Buffering ${Math.round(value)}%`,
          Math.min(1, value / 100));
        // Don't leave a frozen percentage on screen if buffering stalls
        clearTimeout(ui.bufferStallTimer);
        ui.bufferStallTimer = setTimeout(() => {
          if (ui.awaitingFrame) setLoading(null, 'Waiting for the first picture…', null);
        }, 1500);
      }
      break;
    case EV.PLAYING:
      setStatus(`Playing ${currentName}`);
      break;
    case EV.PAUSED:
      setStatus(`Paused — ${currentName}`);
      break;
    case EV.ERROR:
      ui.loaded = false;
      ui.awaitingFrame = false;
      clearTimeout(ui.slowOpenTimer);
      fatal('Playback error',
        'VLC could not play this image. It may not be a DVD-Video disc, may be damaged, or may use a ' +
        'copy protection that cannot be handled. Open the browser console (and add ?debug to the URL) for details.');
      break;
  }
}

// --------------------------------------------------------------------------
// UI refresh from the state snapshot
// --------------------------------------------------------------------------

function fmtTime(ms) {
  if (!(ms > 0)) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fillSelect(select, options, selectedValue) {
  const sig = JSON.stringify(options) + '|' + selectedValue;
  if (select.dataset.sig === sig) return;
  if (document.activeElement === select) return; // don't fight the user
  select.dataset.sig = sig;
  select.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = String(selectedValue);
  select.disabled = options.length === 0;
}

function trackLabel(t, i) {
  let label = t.name || `Track ${i + 1}`;
  if (t.language && !label.toLowerCase().includes(t.language.toLowerCase())) label += ` [${t.language}]`;
  if (t.description) label += ` ${t.description}`;
  return label;
}

const isInMenu = () => vlc.st(ST.TITLE) === 0;

function refreshUi() {
  if (!Module || !ui.loaded) return;
  const pstate = vlc.st(ST.STATE);
  const time = vlc.st(ST.TIME);
  const length = vlc.st(ST.LENGTH);
  const title = vlc.st(ST.TITLE);
  const chapter = vlc.st(ST.CHAPTER);
  const chapterCount = vlc.st(ST.CHAPTER_COUNT);
  const inMenu = title === 0;

  el.play.classList.toggle('playing', pstate === PSTATE.playing || pstate === PSTATE.buffering || pstate === PSTATE.opening);
  el.stage.classList.toggle('in-menu', inMenu);

  // Time & seek bar
  const seekable = length > 0 && !inMenu;
  el.seek.disabled = !seekable;
  if (!ui.seeking) {
    el.timeCur.textContent = fmtTime(time);
    el.seek.value = seekable ? Math.round((time / length) * 1000) : 0;
  }
  el.timeLen.textContent = fmtTime(length);

  // Seeking fast-forwards through the title (see dvdplayer.c): show it
  const seekTarget = vlc.st(ST.SEEK_TARGET);
  if (seekTarget >= 0) {
    el.osd.textContent = `⏩ ${fmtTime(time)} → ${fmtTime(seekTarget)}`;
    el.osd.classList.add('show');
    ui.seekShown = true;
  } else if (ui.seekShown) {
    ui.seekShown = false;
    el.osd.classList.remove('show');
  }

  // Chapters (in the menu pseudo-title, "chapters" are the menu types)
  const chapters = [];
  for (let i = 0; i < Math.max(0, chapterCount); i++) {
    chapters.push({ value: i, label: inMenu ? (MENU_NAMES[i] || `Menu ${i}`) : `Chapter ${i + 1}` });
  }
  fillSelect(el.selChapter, chapters, chapter);

  // Titles and tracks only change when the engine says so
  const version = vlc.st(ST.JSON_VERSION);
  if (version !== ui.jsonVersion || el.selTitle.value !== String(title)) {
    ui.jsonVersion = version;
    const titles = vlc.json(JSON_KIND.titles);
    fillSelect(el.selTitle, titles.map((t) => ({
      value: t.index,
      label: t.menu || t.index === 0
        ? 'DVD menu'
        : `Title ${t.index}${t.duration > 0 ? ` (${fmtTime(t.duration)})` : ''}${t.chapters > 1 ? ` · ${t.chapters} ch.` : ''}`,
    })), title);

    const audio = vlc.json(JSON_KIND.audio);
    const selA = audio.find((t) => t.selected);
    fillSelect(el.selAudio, audio.map((t, i) => ({ value: t.id, label: trackLabel(t, i) })), selA ? selA.id : '');

    const spu = vlc.json(JSON_KIND.spu);
    const selS = spu.find((t) => t.selected);
    fillSelect(el.selSpu, [{ value: '', label: 'Off' }, ...spu.map((t, i) => ({ value: t.id, label: trackLabel(t, i) }))],
      selS ? selS.id : '');
    el.selSpu.disabled = spu.length === 0;
  }

  const dar = vlc.st(ST.VIDEO_DAR);
  if (dar > 0.5 && dar < 4 && Math.abs(dar - ui.dar) > 0.01) {
    ui.dar = dar;
    layoutViewport();
  }
}

// --------------------------------------------------------------------------
// Viewport: follow the video's aspect ratio
// --------------------------------------------------------------------------

// VLC renders into a fixed 16:9 surface, letterboxing or pillarboxing the
// picture inside it. The stage takes the video's aspect ratio (CSS --dar);
// the viewport is the largest rectangle of that aspect ratio in the stage (all
// of it, except in fullscreen); the canvas is sized and centered so that the
// picture inside the surface exactly covers the viewport.
const SURFACE_AR = SURFACE_W / SURFACE_H;
function layoutViewport() {
  const dar = ui.dar;
  el.stage.style.setProperty('--dar', dar.toFixed(4));
  const W = el.stage.clientWidth;
  const H = el.stage.clientHeight;
  if (!W || !H) return;
  const vw = Math.min(W, H * dar);
  const vh = vw / dar;
  Object.assign(el.viewport.style, {
    left: `${(W - vw) / 2}px`, top: `${(H - vh) / 2}px`,
    width: `${vw}px`, height: `${vh}px`, right: 'auto', bottom: 'auto',
  });
  // Canvas size: the picture covers the full surface height (pillarboxed,
  // dar <= 16:9) or the full surface width (letterboxed)
  const cw = dar <= SURFACE_AR ? vh * SURFACE_AR : vw;
  const ch = cw / SURFACE_AR;
  Object.assign(el.canvas.style, {
    width: `${cw}px`, height: `${ch}px`,
    left: `${(vw - cw) / 2}px`, top: `${(vh - ch) / 2}px`,
  });
}
new ResizeObserver(layoutViewport).observe(el.stage);
document.addEventListener('fullscreenchange', layoutViewport);

setInterval(refreshUi, 250);

el.seek.addEventListener('input', () => {
  ui.seeking = true;
  el.timeCur.textContent = fmtTime((el.seek.value / 1000) * vlc.st(ST.LENGTH));
});
el.seek.addEventListener('change', () => {
  seekTo((el.seek.value / 1000) * vlc.st(ST.LENGTH));
  // keep showing the requested position until the engine catches up
  setTimeout(() => { ui.seeking = false; }, 600);
});

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

let osdTimer = 0;
function osd(text) {
  el.osd.textContent = text;
  el.osd.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.osd.classList.remove('show'), 1200);
}

// Seeking never jumps into the middle of a title: the engine jumps to a
// chapter start if needed, then fast-forwards (8x) to the target, so that the
// disc's own navigation runs as in normal playback (copy protections hide
// decoy cells in titles that direct jumps can land in).
function seekTo(timeMs) {
  const length = vlc.st(ST.LENGTH);
  if (!ui.loaded || isInMenu() || !(length > 0)) return;
  vlc.cmd(CMD.SEEK, 0, 0, 0, 0, Math.max(0, Math.min(length - 1000, timeMs)));
}

function seekBy(deltaMs) {
  // Repeated presses accumulate on top of a seek in progress
  const target = vlc.st(ST.SEEK_TARGET);
  seekTo((target >= 0 ? target : vlc.st(ST.TIME)) + deltaMs);
  if (vlc.st(ST.SEEK_TARGET) < 0) osd(`${deltaMs > 0 ? '+' : '−'}${Math.abs(deltaMs / 1000)} s`);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen?.().catch(() => {});
}

function nav(mode) {
  if (ui.loaded) vlc.cmd(CMD.NAVIGATE, NAV[mode]);
}

const actions = {
  'play-pause': () => {
    if (!ui.loaded) { el.fileInput.click(); return; }
    const playing = vlc.st(ST.STATE) === PSTATE.playing;
    if (vlc.st(ST.STATE) === PSTATE.stopped) vlc.cmd(CMD.PLAY);
    else vlc.cmd(CMD.SET_PAUSE, playing ? 1 : 0);
    osd(playing ? 'Pause' : 'Play');
  },
  stop: () => {
    if (!ui.loaded) return;
    vlc.cmd(CMD.STOP);
    ui.loaded = false;
    resetUi();
    showOverlay(el.dropzone);
    document.title = 'Web DVD Player';
    setStatus('Disc ejected.');
  },
  'prev-chapter': () => { if (ui.loaded) { vlc.cmd(CMD.PREV_CHAPTER); osd('⏮ Chapter'); } },
  'next-chapter': () => { if (ui.loaded) { vlc.cmd(CMD.NEXT_CHAPTER); osd('Chapter ⏭'); } },
  rewind: () => seekBy(-10000),
  forward: () => seekBy(10000),
  up: () => nav('up'),
  down: () => nav('down'),
  left: () => nav('left'),
  right: () => nav('right'),
  activate: () => nav('activate'),
  menu: () => { if (ui.loaded) { vlc.cmd(CMD.MENU, MENU_SEEKPOINT.root); osd('Menu'); } },
  'title-menu': () => { if (ui.loaded) { vlc.cmd(CMD.MENU, MENU_SEEKPOINT.title); osd('Title menu'); } },
  resume: () => { if (ui.loaded && isInMenu()) { vlc.cmd(CMD.MENU, MENU_SEEKPOINT.resume); osd('Resume'); } },
  mute: () => {
    if (!Module) return;
    const m = vlc.st(ST.MUTE) ? 0 : 1;
    vlc.cmd(CMD.SET_MUTE, m);
    osd(m ? 'Muted' : 'Sound on');
  },
  fullscreen: toggleFullscreen,
};

document.addEventListener('click', (e) => {
  unlockAudio();
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const fn = actions[btn.dataset.action];
  if (fn) fn();
});

// Selectors
el.selTitle.addEventListener('change', () => {
  vlc.cmd(CMD.SET_TITLE, Number(el.selTitle.value));
  el.stage.focus({ preventScroll: true });
});
el.selChapter.addEventListener('change', () => {
  vlc.cmd(CMD.SET_CHAPTER, Number(el.selChapter.value));
  el.stage.focus({ preventScroll: true });
});
el.selAudio.addEventListener('change', () => {
  vlc.cmdStr(CMD.SELECT_TRACK, TRACK.audio, el.selAudio.value);
  el.stage.focus({ preventScroll: true });
});
el.selSpu.addEventListener('change', () => {
  vlc.cmdStr(CMD.SELECT_TRACK, TRACK.text, el.selSpu.value);
  el.stage.focus({ preventScroll: true });
});

function applyDeinterlace() {
  vlc.cmdStr(CMD.DEINTERLACE, 0, el.selDeint.value);
  try { localStorage.setItem('deinterlace', el.selDeint.value); } catch {}
}
el.selDeint.addEventListener('change', applyDeinterlace);
try {
  const saved = localStorage.getItem('deinterlace');
  if (saved !== null) el.selDeint.value = saved;
} catch {}

function applyVolume() {
  vlc.cmd(CMD.SET_VOLUME, Number(el.volume.value));
  try { localStorage.setItem('volume', el.volume.value); } catch {}
}
el.volume.addEventListener('input', applyVolume);
try {
  const v = localStorage.getItem('volume');
  if (v !== null) el.volume.value = v;
} catch {}

// --------------------------------------------------------------------------
// Keyboard (remote control)
// --------------------------------------------------------------------------

const keymap = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'activate', ' ': 'play-pause', m: 'menu', t: 'title-menu',
  Backspace: 'resume', Escape: 'resume', PageUp: 'prev-chapter', PageDown: 'next-chapter',
  j: 'rewind', l: 'forward', f: 'fullscreen', v: 'mute',
};

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'select' || (tag === 'input' && e.target.type !== 'range') || el.help.open) return;
  if (tag === 'input' && e.target.type === 'range' && e.key.startsWith('Arrow')) return;
  // Space/Enter on a focused button should press that button, not the remote.
  if (tag === 'button' && (e.key === ' ' || e.key === 'Enter')) return;
  const action = keymap[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!action) return;
  e.preventDefault();
  unlockAudio();
  actions[action]();
});

// --------------------------------------------------------------------------
// Mouse on the picture: hover highlights / click activates DVD menu buttons
// --------------------------------------------------------------------------

function surfacePoint(e) {
  const r = el.canvas.getBoundingClientRect();
  // The canvas keeps 16:9 in the normal layout; in fullscreen it is
  // letterboxed with object-fit: contain.
  const scale = Math.min(r.width / SURFACE_W, r.height / SURFACE_H);
  const w = SURFACE_W * scale;
  const h = SURFACE_H * scale;
  const x = (e.clientX - r.left - (r.width - w) / 2) / scale;
  const y = (e.clientY - r.top - (r.height - h) / 2) / scale;
  return [Math.round(Math.max(0, Math.min(SURFACE_W - 1, x))), Math.round(Math.max(0, Math.min(SURFACE_H - 1, y)))];
}

function mouse(type, e) {
  if (!ui.loaded) return;
  const [x, y] = surfacePoint(e);
  vlc.cmd(CMD.MOUSE, type, x, y, 0);
}
// Pointer events cover mouse, pen and touch (tap a menu button to select it).
el.canvas.addEventListener('pointermove', (e) => mouse(0, e));
el.canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) { mouse(0, e); mouse(1, e); } });
el.canvas.addEventListener('pointerup', (e) => { if (e.button === 0) { mouse(0, e); mouse(2, e); } });
el.canvas.addEventListener('dblclick', toggleFullscreen);

// --------------------------------------------------------------------------
// File picking / drag & drop
// --------------------------------------------------------------------------

for (const id of ['btn-open', 'btn-open-2']) $(id).addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = '';
  openFile(f);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  el.dropzone.classList.add('drag');
  el.dropzone.classList.remove('hidden');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    el.dropzone.classList.remove('drag');
    if (ui.loaded && ui.hasVideo) el.dropzone.classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropzone.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
  else if (ui.loaded && ui.hasVideo) el.dropzone.classList.add('hidden');
});

$('btn-help').addEventListener('click', () => el.help.showModal());

// Warm up: start downloading/compiling the engine right away so opening a
// disc is quick. Errors are shown immediately (e.g. no cross-origin isolation).
if (!window.crossOriginIsolated && window.isSecureContext && navigator.serviceWorker && !navigator.serviceWorker.controller) {
  // coi-serviceworker is installing and will reload the page; don't flash an error.
  setStatus('Enabling cross-origin isolation…');
  setTimeout(() => { if (!window.crossOriginIsolated) loadEngine().catch(() => {}); }, 4000);
} else {
  loadEngine().then(() => { if (!ui.loaded) showOverlay(el.dropzone); }).catch(() => {});
}
