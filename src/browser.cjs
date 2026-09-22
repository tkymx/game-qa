'use strict';
// Opens the browser with Playwright and runs a scenario's setup steps.
const { chromium } = require('playwright');
const path = require('path');

// Seeded Math.random (mulberry32), installed before the page loads, so the same seed gives the
// same enemy spawns every run. Used to compare decision engines fairly.
function seedRandom(s) {
  let a = s >>> 0;
  Math.random = function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function openBrowser({ url, viewport, headed, winpos, winsize, videoDir, seed }) {
  const args = [];
  if (winpos) args.push(`--window-position=${winpos}`);
  if (winsize) args.push(`--window-size=${winsize}`);
  // Playwright 1.60+ uses headless-shell unless a channel is given, so headed runs need the full build
  const browser = await chromium.launch({ headless: !headed, channel: headed ? 'chromium' : undefined, args });
  const [vw, vh] = winsize ? winsize.split(',').map(Number) : [viewport.width, viewport.height];
  const context = await browser.newContext({
    viewport: headed && !videoDir ? null : { width: vw, height: vh },
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: vw, height: vh } } } : {}),
  });
  if (seed != null) await context.addInitScript(seedRandom, Number(seed));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push({ message: e.message, at: Date.now() }));
  await page.goto(url, { waitUntil: 'load' });

  return {
    page,
    errors,
    async close(videoName) {
      const video = page.video();
      await context.close();
      let videoPath = null;
      if (video && videoName) {
        videoPath = path.join(videoDir, `${videoName}.webm`);
        await video.saveAs(videoPath);
        await video.delete();
      }
      await browser.close();
      return videoPath;
    },
  };
}

// Scenario setup: [{ "waitFor": "expr", "timeoutMs": 15000 }, { "eval": "expr" }, { "wait": 500 }]
async function runSetup(page, steps = []) {
  for (const s of steps) {
    if (s.waitFor) await page.waitForFunction(s.waitFor, null, { timeout: s.timeoutMs || 15000 }).catch(() => {});
    if (s.eval) await page.evaluate(s.eval);
    if (s.wait) await page.waitForTimeout(s.wait);
  }
}

module.exports = { openBrowser, runSetup };
