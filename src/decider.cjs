'use strict';
// Decision engines (Jev / Laya). Both take {state, questions} and return {model, answers},
// so modes only call decide(payload).
//   jev : TypeSafe AI cloud API (needs TYPESAFE_API_KEY)
//   laya: Laya-MLX running locally via laya/laya_server.py (started on demand, stopped on exit)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const JEV_API_URL = 'https://api.typesafe.ai/v1/systemone';
const LAYA_PORT = process.env.LAYA_PORT || '8765';
const LAYA_URL = `http://127.0.0.1:${LAYA_PORT}`;
const LAYA_DEFAULT_MODEL = 'aac6fef/laya-multilingual-mlx';
const LAYA_DIR = path.resolve(__dirname, '..', 'laya');
const LAYA_PYTHON = path.join(LAYA_DIR, '.venv', 'bin', 'python');

const PROVIDERS = ['jev', 'laya'];

async function layaHealth() {
  try {
    const r = await fetch(`${LAYA_URL}/health`);
    return r.ok ? r.json() : null;
  } catch (_) {
    return null;
  }
}

async function startLayaServer(model, logPath) {
  if (!fs.existsSync(LAYA_PYTHON)) {
    throw new Error(`Laya is not installed. Run: bash ${path.join(LAYA_DIR, 'setup.sh')}`);
  }
  const out = fs.openSync(logPath, 'a');
  const child = spawn(LAYA_PYTHON, [path.join(LAYA_DIR, 'laya_server.py'), `--port=${LAYA_PORT}`, `--model=${model}`], {
    cwd: LAYA_DIR, stdio: ['ignore', out, out],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  // The first run downloads the checkpoint, so wait generously
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (exited) throw new Error(`laya_server.py failed to start (log: ${logPath})`);
    if (await layaHealth()) return child;
  }
  child.kill();
  throw new Error(`laya_server.py did not start within 300s (log: ${logPath})`);
}

async function createDecider({ provider, model, env, runtimeDir }) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider: ${provider} (jev | laya)`);

  if (provider === 'jev') {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey || apiKey === 'your-api-key') {
      throw new Error('TYPESAFE_API_KEY is not set (put it in .env next to qa.config.json, or export it).');
    }
    const d = {
      provider,
      model: model || 'jev-latest',
      async decide(payload) {
        const res = await fetch(JEV_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: d.model, ...payload }),
        });
        if (!res.ok) throw new Error(`Jev API ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        // Pin jev-latest to the concrete version resolved by the first response
        if (d.model === 'jev-latest' && json.model) d.model = json.model;
        return json;
      },
      close() {},
    };
    return d;
  }

  const layaModel = model || LAYA_DEFAULT_MODEL;
  let child = null;
  const running = await layaHealth();
  if (!running) {
    child = await startLayaServer(layaModel, path.join(runtimeDir, 'laya-server.log'));
    // Do not leave the server orphaned when the monitor app stops us with SIGTERM
    const killChild = () => { if (child) { child.kill(); child = null; } };
    process.on('exit', killChild);
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => { killChild(); process.exit(128 + (sig === 'SIGTERM' ? 15 : 2)); });
    }
  }
  const active = await layaHealth();
  return {
    provider,
    model: active ? active.model : layaModel,
    async decide(payload) {
      const res = await fetch(`${LAYA_URL}/v1/systemone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Laya ${res.status}: ${await res.text().catch(() => '')}`);
      return res.json();
    },
    close() { if (child) { child.kill(); child = null; } },
  };
}

module.exports = { createDecider, PROVIDERS };
