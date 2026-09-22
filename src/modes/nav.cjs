'use strict';
// nav mode: exploratory QA over menus/screens.
// Each step reads window[hooks.nav]() -> { scene, candidates: [{ id, label, x, y }], ...anything }
// asks the decider which candidate to tap, and clicks its screen coordinates.
// Dangerous labels (delete data, purchase, ...) never reach the decider: they are removed from the choices.
const fs = require('fs');

function loadDangerPatterns(file) {
  if (!file || !fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (raw.patterns || []).map(s => new RegExp(s, 'i'));
}

async function run({ page, errors, config, scenario, decider, provider, rt, opts }) {
  const steps = Number(opts.steps ?? scenario.steps ?? 500);
  const dangerFile = scenario.dangerList ? require('path').resolve(config.dir, scenario.dangerList) : config.dangerList;
  const dangerPatterns = scenario.allowDangerous ? [] : loadDangerPatterns(dangerFile);
  const decorative = config.nav.decorativePattern ? new RegExp(config.nav.decorativePattern) : null;
  const prompts = config.prompts.nav;
  const hook = config.hooks.nav;
  const model = () => `${provider}:${decider.model}`;

  rt.status({ running: true, mode: 'nav', step: 0, steps, provider, model: model() });

  const history = [];
  const recentKeys = [];
  let step = 0;
  let reason = 'steps_completed';
  let stalls = 0;
  let dangerExcludedTotal = 0;

  while (step < steps) {
    const raw = await page.evaluate(h => (window[h] ? window[h]() : null), hook);
    const all = raw && raw.candidates ? raw.candidates : [];
    const safe = all.filter(c => !dangerPatterns.some(re => re.test(c.label)));
    const excluded = all.filter(c => !safe.includes(c));
    if (excluded.length) {
      dangerExcludedTotal += excluded.length;
      rt.log({ step, ts: Date.now(), dangerExcluded: excluded.map(c => c.label) });
    }
    if (!safe.length) {
      if (++stalls > 10) { reason = all.length ? 'only_dangerous_candidates' : 'no_candidates'; break; }
      await page.waitForTimeout(300);
      continue;
    }
    stalls = 0;

    const { candidates: _omit, ...context } = raw;
    const visited = [...new Set(history.map(h => h.scene).concat(raw.scene))];
    const kind = label => (decorative && decorative.test(label) ? 'decorative' : 'ui');
    let answer;
    try {
      answer = await decider.decide({
        state: { ...context, visited_scenes_so_far: visited, recent_history: history.slice(-5) },
        questions: {
          next_tap: {
            type: 'choice',
            instructions: prompts.instructions,
            criteria: Object.fromEntries(safe.map(c => [c.id, `[${kind(c.label)}] ${c.label}`])),
          },
          looks_broken: { type: 'noul', instructions: prompts.stableQuestion },
        },
      });
    } catch (e) {
      rt.log({ step, ts: Date.now(), error: String(e.message || e) });
      reason = `${provider}_error`;
      break;
    }

    const tap = answer.answers.next_tap;
    const broken = answer.answers.looks_broken;
    const chosen = safe.find(c => c.id === tap.choice);
    rt.log({
      step, ts: Date.now(), scene: raw.scene, candidatesCount: safe.length, choiceId: tap.choice,
      chosenLabel: chosen ? chosen.label : null, confidence: tap.confidence, noul: broken.noul,
      errorsSoFar: errors.length, dangerExcluded: excluded.map(c => c.label),
    });
    rt.feed({
      step, ts: Date.now(), scene: raw.scene, structure: safe.map(c => c.label),
      choiceId: tap.choice, chosenLabel: chosen ? chosen.label : null,
      confidence: tap.confidence, probabilities: tap.probabilities || null, noul: broken.noul,
    });
    rt.status({
      running: true, mode: 'nav', step: step + 1, steps, scene: raw.scene, lastLabel: chosen ? chosen.label : null,
      confidence: tap.confidence, noul: broken.noul, errors: errors.length, dangerExcludedTotal, provider, model: model(),
    });

    if (!chosen) { reason = 'candidate_not_found'; break; }
    history.push({ scene: raw.scene, action: chosen.label });
    await page.mouse.click(chosen.x, chosen.y);
    await page.waitForTimeout(scenario.tapIntervalMs ?? 400);
    step++;

    // Same (scene, choice) five times in a row: treat as stuck
    recentKeys.push(`${raw.scene}::${tap.choice}`);
    if (recentKeys.length > 5) recentKeys.shift();
    if (recentKeys.length === 5 && recentKeys.every(k => k === recentKeys[0])) { reason = 'stuck_loop'; break; }
  }

  const scenes = [...new Set(history.map(h => h.scene))];
  const summary = {
    running: false, mode: 'nav', step, steps, reason, errors: errors.length, errorMessages: errors.map(e => e.message),
    dangerExcludedTotal, distinctScenes: scenes.length, scenesVisited: scenes,
    lastLabel: history.length ? history[history.length - 1].action : null,
    provider, model: model(), seed: opts.seed ?? null, finishedAt: new Date().toISOString(), logPath: rt.logPath,
  };
  rt.status(summary);
  rt.log({ summary });
  console.log(`\n=== NAV QA ${reason} === steps=${step}/${steps} scenes=${scenes.join(',')} errors=${errors.length} dangerExcluded=${dangerExcludedTotal}`);
  return summary;
}

module.exports = { run };
