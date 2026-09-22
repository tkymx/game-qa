'use strict';
// The whole QA loop. game-qa knows nothing about the game's input or rules:
//   observe()  -> { state, questions, metrics?, display?, done? }   (see docs/protocol.md)
//   decide     -> the decision engine answers `questions` given `state`
//   act(answers)  the game turns the answers into its own input
const fs = require('fs');

function loadDangerPatterns(file) {
  if (!file || !fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, 'utf8')).patterns || []).map(s => new RegExp(s, 'i'));
}

// Last line of defence: drop choice options whose label matches the danger list,
// even if the game forgot to leave them out. Returns null if a choice question has nothing left.
function filterDanger(questions, patterns) {
  if (!patterns.length) return { questions, excluded: [] };
  const excluded = [];
  const out = {};
  for (const [qid, q] of Object.entries(questions)) {
    if (q.type !== 'choice') { out[qid] = q; continue; }
    const entries = Array.isArray(q.criteria) ? q.criteria.map(l => [l, l]) : Object.entries(q.criteria || {});
    const keep = entries.filter(([, label]) => {
      const bad = patterns.some(re => re.test(String(label)));
      if (bad) excluded.push(String(label));
      return !bad;
    });
    if (!keep.length) return { questions: null, excluded };
    out[qid] = { ...q, criteria: Object.fromEntries(keep) };
  }
  return { questions: out, excluded };
}

function firstChoice(questions, answers) {
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers[qid];
    if (q.type === 'choice' && a) {
      const label = Array.isArray(q.criteria) ? a.choice : (q.criteria[a.choice] ?? a.choice);
      return { id: a.choice, label, confidence: a.confidence, probabilities: a.probabilities || null };
    }
  }
  return null;
}

async function run({ page, errors, config, scenario, decider, provider, rt, opts }) {
  const hook = config.hook;
  const maxSeconds = Number(opts.maxSeconds ?? scenario.maxSeconds ?? 120);
  const maxSteps = Number(opts.steps ?? scenario.maxSteps ?? Infinity);
  // Laya slows down when idle between calls (GPU clocks down), so ask again right away; Jev needs no hurry.
  const intervalMs = Number(opts.intervalMs ?? scenario.intervalMs ?? (provider === 'laya' ? 0 : 180));
  const patterns = scenario.allowDangerous ? [] : loadDangerPatterns(config.dangerList);
  const model = () => `${provider}:${decider.model}`;
  const latencies = [];
  const median = () => { const s = [...latencies].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  await page.evaluate(([h, o]) => { const qa = window[h]; if (qa && qa.configure) qa.configure(o); }, [hook, scenario.options || {}]);
  rt.status({ running: true, step: 0, provider, model: model() });

  const start = Date.now();
  let step = 0, reason = 'timeout', success = false, last = null, done = null, idle = 0, dangerExcludedTotal = 0;
  while (Date.now() - start < maxSeconds * 1000 && step < maxSteps) {
    const obs = await page.evaluate(h => (window[h] ? window[h].observe() : undefined), hook);
    if (obs === undefined) {
      if (++idle > 50) { reason = 'no_qa_hook'; break; }
      await page.waitForTimeout(200);
      continue;
    }
    if (obs && obs.metrics) last = obs;
    if (obs && obs.done) { done = obs.done; reason = done.reason || 'done'; success = !!done.success; break; }
    if (!obs || !obs.questions || !Object.keys(obs.questions).length) { await page.waitForTimeout(100); continue; }
    idle = 0;

    const { questions, excluded } = filterDanger(obs.questions, patterns);
    if (excluded.length) { dangerExcludedTotal += excluded.length; rt.log({ step, ts: Date.now(), dangerExcluded: excluded }); }
    if (!questions) { await page.waitForTimeout(200); continue; }

    let answer;
    const t0 = Date.now();
    try {
      answer = await decider.decide({ state: obs.state || {}, questions });
    } catch (e) {
      rt.log({ step, ts: Date.now(), error: String(e.message || e) });
      reason = `${provider}_error`;
      break;
    }
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    await page.evaluate(([h, a]) => window[h].act(a), [hook, answer.answers]);

    const pick = firstChoice(questions, answer.answers);
    rt.log({
      step, ts: Date.now(), metrics: obs.metrics || null, choice: pick && pick.id, confidence: pick && pick.confidence,
      latencyMs, engineMs: answer.latency_ms ?? null, inputTokens: answer.usage?.input_tokens ?? null, errorsSoFar: errors.length,
    });
    rt.feed({
      step, ts: Date.now(), scene: (obs.metrics && obs.metrics.scene) || scenario.id,
      structure: obs.display || Object.entries(obs.state || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`),
      choiceId: pick && pick.id, chosenLabel: pick ? `${pick.label}${obs.metrics && obs.metrics.guard ? ' (guard)' : ''}` : null,
      confidence: pick && pick.confidence, probabilities: pick && pick.probabilities,
    });
    rt.status({
      running: true, step: step + 1, scene: (obs.metrics && obs.metrics.scene) || scenario.id,
      lastLabel: pick ? pick.label : null, confidence: pick && pick.confidence, errors: errors.length,
      provider, model: model(), latencyMs, medianLatencyMs: median(),
    });
    step++;
    if (intervalMs > 0) await page.waitForTimeout(intervalMs);
  }

  const m = (last && last.metrics) || {};
  const summary = {
    running: false, step, reason, success, errors: errors.length, errorMessages: errors.map(e => e.message),
    elapsedSec: Math.round((Date.now() - start) / 1000), finalMetrics: m, done,
    finalHp: m.hp ?? null, maxHp: m.maxHp ?? null, defeated: m.defeated ?? null, hits: (done && done.hits) || [],
    dangerExcludedTotal, provider, model: model(), medianLatencyMs: median(),
    seed: opts.seed != null ? Number(opts.seed) : null, finishedAt: new Date().toISOString(), logPath: rt.logPath,
  };
  rt.status(summary);
  rt.log({ summary });
  console.log(`\n=== QA ${reason} === provider=${provider} success=${success} steps=${step} elapsed=${summary.elapsedSec}s medianLatency=${summary.medianLatencyMs}ms errors=${errors.length}`);
  return summary;
}

module.exports = { run, filterDanger };
