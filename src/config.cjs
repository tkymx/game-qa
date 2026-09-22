'use strict';
// Loads qa.config.json plus its scenarios and prompts into one settings object.
// Every relative path is resolved against the directory of the config file.
const fs = require('fs');
const path = require('path');

const DEFAULT_PROMPTS = {
  nav: {
    instructions: 'You are doing exploratory QA on a game. Pick the next thing to tap so that you reach screens you have not visited yet and can check for crashes or broken screens. Prefer [ui] candidates. [decorative] candidates keep you on the same screen, so pick them only when no [ui] candidate exists. Avoid repeating the actions in recent_history.',
    stableQuestion: 'Does this screen look broken (error message, blank screen, broken layout)?',
  },
  move: {
    instructions: 'Pick a movement direction that avoids getting hit. The choices only include directions that will not collide if you keep moving. Threats are listed nearest first as type+direction+distance. Projectiles move as fast as you, so step sideways (perpendicular to them) rather than running straight away. If there is no threat, STAY.',
    surviveSuffix: ' The goal is to survive for {seconds} seconds.',
    centerSuffix: ' When there is no threat, move toward "center".',
    directionLabels: { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west', STAY: 'stay' },
    entityLabels: {},
    telegraphLabels: { charging: '!' },
    projectileLabel: 'shot',
    noneLabel: 'none',
    stateKeys: { threats: 'threats', center: 'center', unsafe: 'unsafe_directions' },
  },
};

const DEFAULT_MOVE = {
  playerSpeed: 185,
  avoidDistance: 110,
  hitRadius: 30,
  safeHorizon: 0.9,
  maxThreats: 4,
  chasers: {},
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

function loadEnvFile(p) {
  const env = {};
  if (!p || !fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

function loadConfig(configPath) {
  if (!configPath) throw new Error('--config is required (path to qa.config.json)');
  const file = path.resolve(configPath);
  const dir = path.dirname(file);
  const raw = readJson(file);
  const rel = p => (p == null ? null : (path.isAbsolute(p) ? p : path.join(dir, p)));

  const app = { ...(raw.app || {}) };
  if (app.serve) app.serve = rel(app.serve);
  if (app.cwd) app.cwd = rel(app.cwd);
  if (!app.url) app.url = `http://localhost:${app.port || 8124}/`;

  const promptsFile = rel(raw.prompts);
  const prompts = merge(DEFAULT_PROMPTS, promptsFile ? readJson(promptsFile) : {});

  const envPath = rel(raw.env || '.env');
  return {
    file,
    dir,
    name: raw.name || path.basename(dir),
    app,
    viewport: { width: 420, height: 740, ...(raw.viewport || {}) },
    hooks: { nav: '__qaState', move: '__combatState', ...(raw.hooks || {}) },
    scenariosDir: rel(raw.scenarios || 'scenarios'),
    dangerList: rel(raw.dangerList),
    nav: { decorativePattern: null, ...(raw.nav || {}) },
    move: merge(DEFAULT_MOVE, raw.move || {}),
    prompts,
    provider: raw.provider || 'jev',
    runtimeDir: rel(raw.runtimeDir || '.game-qa'),
    env: { ...loadEnvFile(envPath), ...process.env },
  };
}

function listScenarios(config) {
  if (!fs.existsSync(config.scenariosDir)) return [];
  return fs.readdirSync(config.scenariosDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ id: path.basename(f, '.json'), ...readJson(path.join(config.scenariosDir, f)) }));
}

function loadScenario(config, idOrPath) {
  if (!idOrPath) throw new Error('--scenario is required');
  const byId = path.join(config.scenariosDir, `${idOrPath}.json`);
  const p = fs.existsSync(byId) ? byId : path.resolve(idOrPath);
  const s = readJson(p);
  return { id: s.id || path.basename(p, '.json'), ...s, mode: s.mode === 'combat' ? 'move' : (s.mode || 'nav') };
}

module.exports = { loadConfig, loadScenario, listScenarios };
