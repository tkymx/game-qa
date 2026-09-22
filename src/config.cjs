'use strict';
// Loads qa.config.json plus its scenarios and prompts into one settings object.
// Every relative path is resolved against the directory of the config file.
const fs = require('fs');
const path = require('path');

const os = require('os');

// TYPESAFE_API_KEY belongs to the person running game-qa, not to each game project.
// Lookup order (first wins): process env > GAME_QA_ENV or ~/.config/game-qa/.env > .env at the game-qa root.
// The file in the home directory is shared by every clone and worktree, and it is also what the
// monitor app sees (apps started from Finder do not get variables exported in the shell profile).
const USER_ENV = process.env.GAME_QA_ENV || path.join(os.homedir(), '.config', 'game-qa', '.env');
const ROOT_ENV = path.resolve(__dirname, '..', '.env');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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

  return {
    file,
    dir,
    name: raw.name || path.basename(dir),
    app,
    viewport: { width: 420, height: 740, ...(raw.viewport || {}) },
    hook: raw.hook || '__qa',
    scenariosDir: rel(raw.scenarios || 'scenarios'),
    dangerList: rel(raw.dangerList),
    provider: raw.provider || 'jev',
    runtimeDir: rel(raw.runtimeDir || '.game-qa'),
    env: { ...loadEnvFile(ROOT_ENV), ...loadEnvFile(USER_ENV), ...process.env },
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
  return { id: s.id || path.basename(p, '.json'), ...s };
}

module.exports = {
  USER_ENV, loadConfig, loadScenario, listScenarios };
