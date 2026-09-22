'use strict';
// Runs the same scenarios with the same seeds for each provider (alternating), recording video,
// and writes <runtimeDir>/compare-<timestamp>/results.json for the report tools.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadScenario } = require('./config.cjs');
const { runScenario } = require('./run.cjs');

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function metrics(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // Standard metric names a game can report from observe(): hp, maxHp, centerDistance, guard, fps
  const steps = lines.filter(l => l.step != null && l.latencyMs != null).map(l => ({ ...l, ...(l.metrics || {}) }));
  const summary = (lines.find(l => l.summary) || {}).summary || {};
  let hits = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i].hp != null && steps[i].hp < steps[i - 1].hp) hits++;
  const span = steps.length > 1 ? (steps[steps.length - 1].ts - steps[0].ts) / 1000 : 0;
  const maxHp = summary.maxHp ?? (steps[0] ? steps[0].maxHp : 100);
  const second = s => Math.floor((s.ts - steps[0].ts) / 1000);
  return {
    result: summary.reason,
    success: !!summary.success,
    elapsedSec: summary.elapsedSec,
    finalHp: summary.finalHp,
    damage: summary.finalHp != null ? maxHp - summary.finalHp : null,
    hits,
    defeated: summary.defeated,
    decisions: steps.length,
    decisionsPerSec: span ? steps.length / span : null,
    latencyP50: median(steps.map(s => s.latencyMs)),
    latencyP95: pct(steps.map(s => s.latencyMs), 0.95),
    guardShare: steps.length ? steps.filter(s => s.guard).length / steps.length : null,
    centerAvg: mean(steps.map(s => s.centerDistance).filter(v => v != null)),
    centerMax: steps.some(s => s.centerDistance != null) ? Math.max(...steps.map(s => s.centerDistance ?? 0)) : null,
    fpsP50: median(steps.map(s => s.fps).filter(f => f != null)),
    hpTimeline: steps.filter((s, i) => i === 0 || second(s) !== second(steps[i - 1])).map(s => ({ t: second(s), hp: s.hp })),
    videoPath: summary.videoPath || (lines.find(l => l.video) || {}).video || null,
    logPath,
  };
}

async function startSharedLaya(outDir) {
  const py = path.resolve(__dirname, '..', 'laya', '.venv', 'bin', 'python');
  if (!fs.existsSync(py)) return null;
  const log = fs.openSync(path.join(outDir, 'laya-server.log'), 'a');
  const child = spawn(py, [path.resolve(__dirname, '..', 'laya', 'laya_server.py'), `--port=${process.env.LAYA_PORT || 8765}`], { stdio: ['ignore', log, log] });
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`http://127.0.0.1:${process.env.LAYA_PORT || 8765}/health`)).ok) return child; } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('laya_server did not start');
}

async function compare(config, { runs = 5, scenarios, providers = ['jev', 'laya'], headed = true }) {
  const ids = scenarios && scenarios.length ? scenarios : require('./config.cjs').listScenarios(config).filter(s => s.compare !== false).map(s => s.id);
  const outDir = path.join(config.runtimeDir, `compare-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const videoDir = path.join(outDir, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  // Share one Laya server across runs so startup/compile time is not mixed into the comparison
  const laya = providers.includes('laya') ? await startSharedLaya(outDir) : null;

  const meta = {};
  const results = [];
  const save = () => fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), config: config.name, runs, scenarios: ids, scenarioMeta: meta, results }, null, 2));
  try {
    for (let seed = 1; seed <= runs; seed++) {
      for (const id of ids) {
        const scenario = loadScenario(config, id);
        meta[id] = { title: scenario.title || id, description: scenario.description || '', videoSpeed: scenario.reportVideoSpeed || 1, preferCenter: !!(scenario.options && scenario.options.preferCenter) };
        for (const provider of providers) {
          console.log(`\n### seed=${seed} scenario=${id} provider=${provider}`);
          let summary = null;
          for (let attempt = 0; attempt < 2 && !summary; attempt++) { // retry transient browser failures once
            try {
              summary = await runScenario(config, scenario, { provider, seed, video: videoDir, headed, winsize: `${config.viewport.width},${config.viewport.height}` });
            } catch (e) { console.log(`retry: ${e.message}`); }
          }
          results.push(summary ? { seed, scenario: id, provider, model: summary.model, ...metrics(summary.logPath) }
            : { seed, scenario: id, provider, result: 'crashed', success: false });
          save();
        }
      }
    }
  } finally {
    if (laya) laya.kill();
  }
  console.log(`\nresults: ${path.join(outDir, 'results.json')}`);
  return outDir;
}

module.exports = { compare, metrics };
