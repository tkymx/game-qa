'use strict';
// move mode: real-time movement QA with a virtual joystick.
// Each step reads window[hooks.move]() (see docs/state-contract.md), asks the decider for one of
// 8 directions + STAY, and drags the on-screen joystick with real mouse input.
//
// What the code does instead of the model (learned from the example game):
//   - Directions that would collide within `safeHorizon` seconds are removed from the choices.
//     Small decision models follow "don't do X" instructions poorly; they cannot pick what they never see.
//   - A guard steers away from chasers and back to the center when needed, and only dodges projectiles
//     itself when every direction is unsafe. Each projectile keeps the dodge side chosen first,
//     otherwise frequent decisions make the player jitter left/right in front of it.

const VECTORS = {
  N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0],
  NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1], STAY: [0, 0],
};
const DIRS = Object.keys(VECTORS);

function unitVec(k) {
  const v = VECTORS[k] || [0, 0];
  const len = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / len, v[1] / len];
}

function dirFromVector(dx, dy) {
  if (Math.hypot(dx, dy) < 1e-6) return 'STAY';
  let best = 'STAY', bestDot = -Infinity;
  for (const k of DIRS) {
    if (k === 'STAY') continue;
    const [ux, uy] = unitVec(k);
    const dot = ux * dx + uy * dy;
    if (dot > bestDot) { bestDot = dot; best = k; }
  }
  return best;
}

// When and where a projectile passes closest if the player stood still; null if it misses.
function predictProjectile(b, P) {
  const vv = b.vx * b.vx + b.vy * b.vy;
  if (!vv) return null;
  const t = -(b.dx * b.vx + b.dy * b.vy) / vv;
  if (t < 0 || t > P.safeHorizon) return null;
  const cx = b.dx + b.vx * t, cy = b.dy + b.vy * t;
  return Math.hypot(cx, cy) > P.hitRadius ? null : { t, cx, cy };
}

// Directions that would collide with a projectile or a chaser within safeHorizon seconds.
function unsafeDirs(state, P) {
  const out = [];
  for (const k of DIRS) {
    const [ux, uy] = unitVec(k);
    let hit = false;
    for (let t = 0; t <= P.safeHorizon && !hit; t += 0.05) {
      const px = ux * P.playerSpeed * t, py = uy * P.playerSpeed * t;
      hit = state.threats.some(b => Math.hypot(b.dx + b.vx * t - px, b.dy + b.vy * t - py) < P.hitRadius)
        || state.enemies.some(e => {
          const c = P.chasers[e.type];
          if (!c) return false;
          const d0 = Math.hypot(e.dx, e.dy) || 1; // chasers approximated as heading to the player's current position
          const ex = e.dx - (e.dx / d0) * c.speed * t, ey = e.dy - (e.dy / d0) * c.speed * t;
          return Math.hypot(ex - px, ey - py) < (c.hitRadius ?? P.hitRadius);
        });
    }
    if (hit) out.push(k);
  }
  return out;
}

function guideVector(state, centerRadius, unsafe, P, dodgeSide) {
  let vx = 0, vy = 0, threatened = false;
  for (const e of state.enemies) {
    const d = Math.hypot(e.dx, e.dy);
    if (d >= P.avoidDistance || d === 0) continue;
    const w = ((P.avoidDistance - d) / P.avoidDistance) * 2.5;
    vx -= (e.dx / d) * w; vy -= (e.dy / d) * w;
    threatened = true;
  }
  const aiCanDodge = unsafe.length < DIRS.length;
  const live = new Set();
  for (const b of state.threats) {
    live.add(b.id);
    if (aiCanDodge) continue;
    const hit = predictProjectile(b, P);
    if (!hit) continue;
    const sp = Math.hypot(b.vx, b.vy);
    const nx = -b.vy / sp, ny = b.vx / sp;
    let side = dodgeSide.get(b.id);
    if (side == null) {
      const pass = hit.cx * nx + hit.cy * ny;
      const toCenter = nx * (state.player.centerDx || 0) + ny * (state.player.centerDy || 0);
      side = Math.abs(pass) > 2 ? -Math.sign(pass) : (toCenter >= 0 ? 1 : -1);
      dodgeSide.set(b.id, side);
    }
    const w = 1 + (1 - hit.t / P.safeHorizon) * 2;
    vx += nx * side * w; vy += ny * side * w;
    threatened = true;
  }
  for (const id of dodgeSide.keys()) if (!live.has(id)) dodgeSide.delete(id);

  const off = centerRadius != null && state.player.centerDistance > centerRadius;
  if (off) {
    const cd = state.player.centerDistance || 1;
    const pull = threatened ? 0.3 : Math.min(cd / centerRadius, 2);
    vx += (state.player.centerDx / cd) * pull; vy += (state.player.centerDy / cd) * pull;
  }
  if (!threatened && !off) return null;

  // The guard must not steer into an unsafe direction either
  if (unsafe.includes(dirFromVector(vx, vy))) {
    const safe = DIRS.filter(k => k !== 'STAY' && !unsafe.includes(k));
    if (safe.length) {
      const best = safe.reduce((a, k) => {
        const [ux, uy] = unitVec(k);
        const dot = ux * vx + uy * vy;
        return dot > a.dot ? { k, dot } : a;
      }, { k: null, dot: -Infinity });
      return unitVec(best.k);
    }
    if (!unsafe.includes('STAY')) return [0, 0];
  }
  return [vx, vy];
}

function describe(e, L) {
  const kind = e.vx != null ? L.projectileLabel : (L.entityLabels[e.type] || e.type || '');
  return `${kind}${e.dir}${e.distance}${(e.telegraph && L.telegraphLabels[e.telegraph]) || ''}`;
}

// Short threat list for the model: nearest first, projectiles only if they would hit.
// Laya's latency grows with input tokens, so keep this compact.
function compactThreats(state, L, P) {
  const items = [
    ...state.enemies.map(e => ({ d: e.distance, s: describe(e, L) })),
    ...state.threats.filter(t => predictProjectile(t, P)).map(t => ({ d: t.distance, s: describe(t, L) })),
  ];
  items.sort((a, b) => a.d - b.d);
  return items.slice(0, P.maxThreats).map(i => i.s).join(' ') || L.noneLabel;
}

async function moveJoystick(page, joystick, dir) {
  const v = Array.isArray(dir) ? dir : (VECTORS[dir] || [0, 0]);
  const len = Math.hypot(v[0], v[1]) || 1;
  await page.mouse.move(joystick.baseX + (v[0] / len) * joystick.radius, joystick.baseY + (v[1] / len) * joystick.radius);
}

async function run({ page, errors, config, scenario, decider, provider, rt, opts }) {
  const P = config.move;
  const L = config.prompts.move;
  const hook = config.hooks.move;
  const maxSeconds = Number(opts.maxSeconds ?? scenario.maxSeconds ?? 90);
  const surviveSeconds = scenario.surviveSeconds != null ? Number(scenario.surviveSeconds) : null;
  const preferCenter = !!scenario.preferCenter;
  const centerRadius = scenario.centerRadius != null ? Number(scenario.centerRadius) : null;
  // Laya slows down when idle between calls (GPU clocks down), so ask again immediately; Jev needs no hurry.
  const intervalMs = Number(opts.intervalMs ?? scenario.intervalMs ?? (provider === 'laya' ? 0 : 180));
  let instructions = L.instructions;
  if (surviveSeconds) instructions += L.surviveSuffix.replace('{seconds}', surviveSeconds);
  if (preferCenter) instructions += L.centerSuffix;
  const K = L.stateKeys;
  const model = () => `${provider}:${decider.model}`;
  const latencies = [];
  const median = () => { const s = [...latencies].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const dodgeSide = new Map();

  rt.status({ running: true, mode: 'move', step: 0, provider, model: model() });
  const start = Date.now();
  let step = 0, reason = 'timeout', finalState = null, grabbed = false;

  while (Date.now() - start < maxSeconds * 1000) {
    const state = await page.evaluate(h => (window[h] ? window[h]() : null), hook);
    if (!state) { await page.waitForTimeout(200); continue; }
    if (state.gameOver) { reason = state.win ? 'win' : 'lose'; finalState = state; break; }
    if (surviveSeconds && Date.now() - start >= surviveSeconds * 1000) { reason = 'survived'; finalState = state; break; }
    if (!grabbed) {
      await page.mouse.move(state.joystick.baseX, state.joystick.baseY);
      await page.mouse.down();
      grabbed = true;
    }

    const unsafe = unsafeDirs(state, P);
    const aiState = { [K.threats]: compactThreats(state, L, P) };
    if (preferCenter) aiState[K.center] = `${state.player.centerDir}${state.player.centerDistance}`;
    if (unsafe.length) aiState[K.unsafe] = unsafe.join(' ');
    const safe = DIRS.filter(k => !unsafe.includes(k));
    const criteria = Object.fromEntries((safe.length ? safe : DIRS).map(k => [k, L.directionLabels[k] || k]));

    let answer;
    const t0 = Date.now();
    try {
      answer = await decider.decide({ state: aiState, questions: { move_direction: { type: 'choice', instructions, criteria } } });
    } catch (e) {
      rt.log({ step, ts: Date.now(), error: String(e.message || e) });
      reason = `${provider}_error`;
      break;
    }
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    const move = answer.answers.move_direction;

    const guided = guideVector(state, centerRadius, unsafe, P, dodgeSide);
    const dir = guided ? dirFromVector(guided[0], guided[1]) : move.choice;
    await moveJoystick(page, state.joystick, guided || dir);

    rt.log({
      step, ts: Date.now(), hp: state.player.hp, maxHp: state.player.maxHp, defeated: state.defeated, target: state.target,
      enemies: state.enemies.length, threats: state.threats.length, dir, aiChoice: move.choice, centerOverride: guided != null,
      centerDistance: state.player.centerDistance, confidence: move.confidence, latencyMs,
      threatsSeen: aiState[K.threats], unsafe: unsafe.join(' '), engineMs: answer.latency_ms ?? null,
      inputTokens: answer.usage?.input_tokens ?? null, fps: state.fps ?? null, errorsSoFar: errors.length,
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    const progress = surviveSeconds ? `survive ${elapsed}/${surviveSeconds}s` : `defeated ${state.defeated}/${state.target}`;
    rt.feed({
      step, ts: Date.now(), scene: scenario.id,
      structure: [`HP ${state.player.hp}/${state.player.maxHp}`, progress, `${K.threats}: ${aiState[K.threats]}`,
        ...(unsafe.length ? [`${K.unsafe}: ${unsafe.join(' ')}`] : [])],
      choiceId: dir, chosenLabel: `${L.directionLabels[dir] || dir}${guided ? ' (guard)' : ''}`,
      confidence: guided ? null : move.confidence, probabilities: move.probabilities || null,
    });
    rt.status({
      running: true, mode: 'move', step: step + 1, scene: scenario.id,
      lastLabel: `${dir}${guided ? ' (guard)' : ''} (HP ${state.player.hp}/${state.player.maxHp}, ${progress})`,
      confidence: move.confidence, errors: errors.length, provider, model: model(), latencyMs, medianLatencyMs: median(),
    });
    step++;
    if (intervalMs > 0) await page.waitForTimeout(intervalMs);
  }
  if (grabbed) await page.mouse.up().catch(() => {});

  const summary = {
    running: false, mode: 'move', step, reason, success: reason === 'win' || reason === 'survived',
    errors: errors.length, errorMessages: errors.map(e => e.message),
    defeated: finalState ? finalState.defeated : null, finalHp: finalState ? finalState.player.hp : null,
    maxHp: finalState ? finalState.player.maxHp : null, elapsedSec: Math.round((Date.now() - start) / 1000),
    hits: finalState ? finalState.hits || [] : [], provider, model: model(), medianLatencyMs: median(),
    seed: opts.seed != null ? Number(opts.seed) : null, finishedAt: new Date().toISOString(), logPath: rt.logPath,
  };
  rt.status(summary);
  rt.log({ summary });
  console.log(`\n=== MOVE QA ${reason} === provider=${provider} medianLatency=${summary.medianLatencyMs}ms steps=${step} elapsed=${summary.elapsedSec}s hp=${summary.finalHp} errors=${errors.length}`);
  return summary;
}

module.exports = { run, unsafeDirs, predictProjectile };
