#!/usr/bin/env node
// End-to-end test of the player in headless Chromium against a DVD image made
// by tools/make-test-dvd.sh. Serves the repository root with COOP/COEP headers itself.
//
//   npm install --no-save playwright && npx playwright install chromium
//   tools/make-test-dvd.sh /tmp/test-dvd.iso
//   node tools/e2e-test.js /tmp/test-dvd.iso [screenshot-dir]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const iso = process.argv[2];
const shots = process.argv[3];
if (!iso) {
  console.error('usage: node tools/e2e-test.js <test-dvd.iso> [screenshot-dir]');
  process.exit(2);
}

const SITE = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.txt': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(SITE, decodeURIComponent(url.pathname));
    if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

(async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  // Tap VLC's audio output to check that samples are actually produced.
  await context.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (this instanceof AudioWorkletNode && dest instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 32768;
        connect.call(this, analyser);
        window.__analyser = analyser;
      }
      return connect.call(this, dest, ...rest);
    };
    window.__audioLevel = () => {
      const a = window.__analyser;
      if (!a) return -1;
      const d = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      return d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    };
    // Frequency of the test tone (zero crossings) and the largest
    // sample-to-sample jump relative to the peak: a clean sine of frequency
    // f gives 2*pi*f/rate; garbled audio has jumps close to 1 or more.
    window.__tone = () => {
      const a = window.__analyser;
      if (!a) return null;
      const d = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(d);
      let z = 0, peak = 0, jump = 0;
      for (let i = 1; i < d.length; i++) {
        if ((d[i - 1] < 0) !== (d[i] < 0)) z++;
        peak = Math.max(peak, Math.abs(d[i]));
        jump = Math.max(jump, Math.abs(d[i] - d[i - 1]));
      }
      return { hz: z / 2 / (d.length / a.context.sampleRate), jump: jump / peak, rate: a.context.sampleRate };
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const st = () => page.evaluate(() => {
    const v = dvd.vlc, S = dvd.ST;
    return { state: v.st(S.STATE), title: v.st(S.TITLE), chapter: v.st(S.CHAPTER), time: v.st(S.TIME), length: v.st(S.LENGTH), audio: window.__audioLevel() };
  });
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => window.dvd, null, { timeout: 120000 });
    check('engine loads (cross-origin isolated)', await page.evaluate(() => crossOriginIsolated));

    await page.setInputFiles('#file-input', iso);
    await page.waitForFunction(() => dvd.vlc.st(dvd.ST.STATE) === 3, null, { timeout: 30000 });
    await sleep(3000);
    let s = await st();
    check('starts on the DVD menu', s.title === 0, JSON.stringify(s));
    await shot('1-menu');

    // Click the second menu button ("Play extra") on the picture.
    // The 4:3 720x480 menu is shown pillarboxed in the 1280x720 surface.
    const box = await page.locator('#canvas').boundingBox();
    const sx = box.width / 1280, sy = box.height / 720;
    await page.mouse.move(box.x + (160 + 360 * 960 / 720) * sx, box.y + 340 * 1.5 * sy);
    await sleep(800);
    await page.mouse.click(box.x + (160 + 360 * 960 / 720) * sx, box.y + 340 * 1.5 * sy);
    await sleep(5000);
    s = await st();
    check('clicking a menu button plays title 2', s.title === 2 && s.time > 1000, JSON.stringify(s));
    check('audio is produced', s.audio > 0.01, `peak ${s.audio}`);
    await shot('2-title2');

    await sleep(9000);
    s = await st();
    check('end of title returns to the menu', s.title === 0, JSON.stringify(s));

    await page.keyboard.press('ArrowUp');
    await sleep(500);
    await page.keyboard.press('ArrowDown');
    await sleep(500);
    await page.keyboard.press('ArrowUp');
    await sleep(500);
    await page.selectOption('#sel-title', '1');
    await sleep(4000);
    s = await st();
    check('title selector plays title 1', s.title === 1 && s.length === 30000, JSON.stringify(s));

    const spu = await page.evaluate(() => [...document.querySelectorAll('#sel-spu option')].map((o) => o.value));
    check('subtitle track listed', spu.length === 2, spu.join(','));
    if (spu[1]) await page.selectOption('#sel-spu', spu[1]);

    await page.keyboard.press('PageDown');
    await sleep(2500);
    s = await st();
    check('next chapter', s.chapter >= 1, JSON.stringify(s));

    await page.keyboard.press(' ');
    await sleep(1500);
    const t1 = (await st()).time;
    await sleep(1500);
    const t2 = (await st()).time;
    check('pause freezes time', t1 === t2 && t1 > 0, `${t1} -> ${t2}`);
    await page.keyboard.press(' ');
    await sleep(1500);
    await shot('3-title1');

    await page.keyboard.press('m');
    await sleep(3000);
    s = await st();
    check('menu key returns to the menu', s.title === 0 && s.state === 3, JSON.stringify(s));
    await shot('4-menu-again');

    await page.keyboard.press('Backspace');
    await sleep(3000);
    s = await st();
    check('resume goes back into the title', s.title === 1 && s.time > 10000, JSON.stringify(s));

    await page.keyboard.press('t');
    await sleep(3000);
    s = await st();
    check('title menu key opens the menu', s.title === 0 && s.state === 3, JSON.stringify(s));

    await page.click('[data-action=stop]');
    await sleep(2000);
    s = await st();
    check('eject stops playback', s.state === 5 || s.state === 0, JSON.stringify(s));

    await page.setInputFiles('#file-input', iso);
    await sleep(6000);
    s = await st();
    check('re-opening the disc works', s.state === 3 && s.title === 0, JSON.stringify(s));

    // Audio quality for each channel layout, in an order where the layout
    // changes between titles (stereo menu -> mono -> 5.1 -> stereo).
    const tones = [
      { title: '2', hz: 880, layout: 'mono AC-3' },
      { title: '3', hz: 660, layout: '5.1 AC-3' },
      { title: '1', hz: 440, layout: 'stereo AC-3' },
    ];
    for (const t of tones) {
      await page.selectOption('#sel-title', t.title);
      await sleep(4500);
      let worst = null;
      for (let i = 0; i < 3; i++) {
        const r = await page.evaluate(() => window.__tone());
        if (!r) break;
        const clean = 2 * Math.PI * t.hz / r.rate;
        const bad = Math.abs(r.hz - t.hz) / t.hz > 0.02 || r.jump > clean * 1.5;
        if (!worst || bad) worst = { ...r, bad };
        await sleep(600);
      }
      check(`${t.layout} audio is clean (title ${t.title})`, worst && !worst.bad,
        worst && `${worst.hz.toFixed(0)} Hz, jump ${worst.jump.toFixed(3)}`);
    }

    // Subtitles must freeze with the picture: pause while a line (shown
    // 2.5 s every 3 s in title 1) is on screen, it must still be there 3.5 s
    // later, i.e. after the line's own display time.
    const subtitleInk = () => page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const g = c.getContext('2d');
      g.drawImage(document.getElementById('canvas'), 0, 0);
      const d = g.getImageData(300, 560, 680, 90).data;
      let black = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 20 && d[i + 1] < 20 && d[i + 2] < 20) black++;
      return black; // the subtitle text outline is black; the test pattern has none there
    });
    await page.selectOption('#sel-title', '1');
    await sleep(1500);
    const spuIds = await page.evaluate(() => [...document.querySelectorAll('#sel-spu option')].map((o) => o.value));
    if (spuIds[1]) await page.selectOption('#sel-spu', spuIds[1]);
    for (let i = 0; i < 200; i++) {
      const t = await page.evaluate(() => dvd.vlc.st(dvd.ST.TIME));
      if (t > 3500 && t % 3000 > 1400 && t % 3000 < 1900) break;
      await sleep(40);
    }
    await page.keyboard.press(' ');
    await sleep(400);
    const inkAtPause = await subtitleInk();
    await sleep(3500);
    const inkLater = await subtitleInk();
    check('subtitles freeze while paused', inkAtPause > 1000 && inkLater > 1000, `ink ${inkAtPause} -> ${inkLater}`);
    await page.keyboard.press(' ');
    await sleep(500);

    // Title 4 hides a red decoy cell between two real cells (blue, green);
    // playback skips it through a cell command. Seeking must never land in it.
    const picture = () => page.evaluate(() => {
      // The player canvas uses a bitmaprenderer context: copy it to sample it
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const g = c.getContext('2d');
      g.drawImage(document.getElementById('canvas'), 0, 0);
      const d = g.getImageData(640, 150, 1, 1).data;
      return d[0] > 150 && d[1] < 80 ? 'decoy' : d[2] > 150 && d[0] < 80 ? 'A' : d[1] > 100 && d[0] < 80 ? 'B' : 'other';
    });
    await page.selectOption('#sel-title', '4');
    await sleep(3000);
    s = await st();
    check('protected title length excludes the decoy', s.title === 4 && Math.abs(s.length - 20000) < 1000, JSON.stringify(s));
    const seekBar = await page.locator('#seek').boundingBox();
    const seekTo = (f) => page.mouse.click(seekBar.x + seekBar.width * f, seekBar.y + seekBar.height / 2);
    await seekTo(0.75);
    await page.waitForFunction(() => dvd.vlc.st(dvd.ST.SEEK_TARGET) < 0, null, { timeout: 20000 }).catch(() => {});
    await sleep(500);
    s = await st();
    let pic = await picture();
    check('seek bar skips the decoy cell', pic === 'B' && s.time > 10000, `${pic}, ${JSON.stringify(s)}`);
    await seekTo(0.02);
    await sleep(1500);
    await page.keyboard.press('l');
    await page.waitForFunction(() => dvd.vlc.st(dvd.ST.SEEK_TARGET) < 0, null, { timeout: 20000 }).catch(() => {});
    await sleep(500);
    s = await st();
    pic = await picture();
    check('+10 s skips the decoy cell', pic === 'B' && s.time > 10000, `${pic}, ${JSON.stringify(s)}`);
    // Seeking backward goes through a chapter start, then fast-forwards
    await seekTo(0.25);
    await page.waitForFunction(() => dvd.vlc.st(dvd.ST.SEEK_TARGET) < 0, null, { timeout: 20000 }).catch(() => {});
    await sleep(500);
    s = await st();
    pic = await picture();
    check('backward seek lands before the decoy', pic === 'A' && s.time > 3000 && s.time < 7000, `${pic}, ${JSON.stringify(s)}`);
    await shot('5-protected-title');
  } catch (e) {
    check('scenario completed', false, e.message);
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
