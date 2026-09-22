#!/usr/bin/env node
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, loadScenario, listScenarios } = require('../src/config.cjs');

const USAGE = `game-qa — let a decision model (Jev / Laya) play your game and check it.

Usage:
  game-qa run     --config <qa.config.json> --scenario <id|path> [options]
  game-qa list    --config <qa.config.json>
  game-qa compare --config <qa.config.json> [--runs 5] [--scenarios a,b] [--providers jev,laya]
  game-qa report  <compare-dir> [--verdict verdict.html]

Options for run:
  --provider jev|laya   decision engine (default: config.provider, then jev)
  --model <name>        model id for the provider
  --headed              show the browser window
  --seed <n>            fix Math.random so runs are reproducible
  --video <dir>         record a video into <dir>
  --steps <n>           max decisions
  --max-seconds <n>     time limit
  --winpos x,y --winsize w,h   window placement when headed
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) { console.log(USAGE); return 0; }

  if (cmd === 'report') {
    const dir = args._[1];
    const py = p => spawnSync('python3', [path.join(__dirname, '..', 'report', p), dir, ...(args.verdict ? [`--verdict=${args.verdict}`] : [])], { stdio: 'inherit' }).status;
    return py('make_compare_videos.py') || py('make_compare_report.py');
  }

  const config = loadConfig(args.config);
  if (cmd === 'list') {
    for (const s of listScenarios(config)) console.log(`${s.id.padEnd(24)} ${s.title || ''}`);
    return 0;
  }
  if (cmd === 'run') {
    const { runScenario } = require('../src/run.cjs');
    const scenario = loadScenario(config, args.scenario);
    const summary = await runScenario(config, scenario, {
      provider: args.provider, model: args.model, headed: args.headed === true || args.headed === '1',
      seed: args.seed != null ? Number(args.seed) : null, video: args.video ? path.resolve(args.video) : null,
      steps: args.steps, maxSeconds: args.maxSeconds, intervalMs: args.intervalMs, winpos: args.winpos, winsize: args.winsize,
    });
    return summary && summary.errors === 0 ? 0 : 1;
  }
  if (cmd === 'compare') {
    const { compare } = require('../src/compare.cjs');
    await compare(config, {
      runs: Number(args.runs || 5),
      scenarios: args.scenarios ? String(args.scenarios).split(',') : null,
      providers: args.providers ? String(args.providers).split(',') : ['jev', 'laya'],
      headed: args.headed !== 'false',
    });
    return 0;
  }
  console.error(`unknown command: ${cmd}\n\n${USAGE}`);
  return 1;
}

main().then(code => process.exit(code || 0), e => { console.error(e.message || e); process.exit(1); });
