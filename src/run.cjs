'use strict';
// Runs one scenario: start the app, open the browser, run the scenario's setup steps,
// run the observe/decide/act loop, then clean everything up.
const { createDecider } = require('./decider.cjs');
const { startApp } = require('./app-server.cjs');
const { openBrowser, runSetup } = require('./browser.cjs');
const { createRuntime } = require('./runtime.cjs');

const loop = require('./loop.cjs');

async function runScenario(config, scenario, opts = {}) {
  const provider = opts.provider || scenario.provider || config.provider;
  const model = provider === 'laya'
    ? (opts.model || scenario.layaModel || null)
    : (opts.model || config.env.JEV_MODEL || scenario.model || 'jev-latest');
  const rt = createRuntime(config.runtimeDir, scenario.id);

  let decider;
  try {
    decider = await createDecider({ provider, model, env: config.env, runtimeDir: config.runtimeDir });
  } catch (e) {
    rt.status({ running: false, reason: 'decider_unavailable', error: String(e.message || e), provider });
    throw e;
  }

  const app = await startApp(config.app);
  const browser = await openBrowser({
    url: app.url, viewport: config.viewport,
    headed: opts.headed, winpos: opts.winpos, winsize: opts.winsize,
    videoDir: opts.video, seed: opts.seed,
  });
  let summary = null;
  try {
    await runSetup(browser.page, scenario.setup);
    summary = await loop.run({ page: browser.page, errors: browser.errors, config, scenario, decider, provider, rt, opts });
  } finally {
    const videoPath = await browser.close(opts.video ? `${provider}-${scenario.id}-seed${opts.seed ?? 'x'}` : null);
    if (summary && videoPath) {
      summary.videoPath = videoPath;
      rt.status(summary);
      rt.log({ video: videoPath });
    }
    app.stop();
    decider.close();
  }
  return summary;
}

module.exports = { runScenario };
