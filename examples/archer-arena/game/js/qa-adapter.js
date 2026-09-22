// game-qa adapter for Archer Arena.
// game-qa only calls window.__qa.observe() / act(answers) / configure(options). Everything that is
// specific to this game lives here: which questions to ask, how to turn an answer into input
// (menu taps and joystick drags are sent as real mouse events on the canvas, so the game's own
// input handling runs), which directions are unsafe, and when a run is finished.
(function () {
  const DIRS = { N: '北', NE: '北東', E: '東', SE: '南東', S: '南', SW: '南西', W: '西', NW: '北西', STAY: '留まる' };
  const VEC = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0], NE: [1, -1], NW: [-1, -1], SE: [1, 1], SW: [-1, 1], STAY: [0, 0] };
  const P = { playerSpeed: 185, avoidDistance: 110, hitRadius: 30, safeHorizon: 0.9, maxThreats: 4, chasers: { walker: { speed: 60 } } };
  const NAV_INSTRUCTIONS = 'ゲームの探索的QA中。画面を巡って未知の画面に到達し、クラッシュや異常がないか確認する。まだ訪れていない画面へ進めそうなボタンを優先し、同じ操作の繰り返しは避ける。';
  const MOVE_INSTRUCTIONS = '被弾を避ける移動方向を選ぶ。選択肢は、動き続けても当たらない方向だけに絞ってある(当たる方向は「危険な方向」)。脅威は近い順で「種類+方向+距離」、弾はこちらへ向かってくるものだけ。弾は自分と同じ速さなので真後ろに逃げても当たる。弾の方向と直角へ横に避ける(例: 弾がNEなら NW か SE)。予兆付き射撃も同じく射線と直角へ。突進は遅いので離れればよい。壁際を避ける。脅威なしならSTAY。';
  const ENTITY = { walker: '突進', shooter: '射撃' };

  let options = {};
  let startedAt = null;
  let pending = null; // what act() should do for the current observation
  let grabbed = false;
  const visited = [];
  const dodgeSide = new Map();

  // --- input: real mouse events on the canvas ---
  function canvasPoint(gx, gy) {
    const g = window.__game;
    const r = g.canvas.getBoundingClientRect();
    return { x: r.left + gx * (r.width / g.config.width), y: r.top + gy * (r.height / g.config.height) };
  }
  function mouse(type, x, y) {
    const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
    window.__game.canvas.dispatchEvent(ev);
    if (type === 'mouseup') window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0 }));
  }
  function tapScreen(x, y) { mouse('mousedown', x, y); mouse('mouseup', x, y); }
  function joystick(vec) {
    const base = canvasPoint(JOY_BASE_X, JOY_BASE_Y);
    const scale = window.__game.canvas.getBoundingClientRect().width / window.__game.config.width;
    if (!grabbed) { mouse('mousedown', base.x, base.y); grabbed = true; }
    const len = Math.hypot(vec[0], vec[1]) || 1;
    const k = Math.hypot(vec[0], vec[1]) < 1e-6 ? 0 : JOY_RADIUS * scale;
    mouse('mousemove', base.x + (vec[0] / len) * k, base.y + (vec[1] / len) * k);
  }
  function release() { if (grabbed) { const b = canvasPoint(JOY_BASE_X, JOY_BASE_Y); mouse('mouseup', b.x, b.y); grabbed = false; } }

  // --- movement helpers ---
  const unit = k => { const v = VEC[k] || [0, 0]; const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  function dirOf(dx, dy) {
    if (Math.hypot(dx, dy) < 1e-6) return 'STAY';
    let best = 'STAY', bd = -Infinity;
    for (const k of Object.keys(VEC)) {
      if (k === 'STAY') continue;
      const [ux, uy] = unit(k); const d = ux * dx + uy * dy;
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  }
  function predict(b) {
    const vv = b.vx * b.vx + b.vy * b.vy;
    if (!vv) return null;
    const t = -(b.dx * b.vx + b.dy * b.vy) / vv;
    if (t < 0 || t > P.safeHorizon) return null;
    const cx = b.dx + b.vx * t, cy = b.dy + b.vy * t;
    return Math.hypot(cx, cy) > P.hitRadius ? null : { t, cx, cy };
  }
  // Directions that would collide with a projectile or a chaser within safeHorizon seconds
  function unsafeDirs(s) {
    const out = [];
    for (const k of Object.keys(VEC)) {
      const [ux, uy] = unit(k);
      let hit = false;
      for (let t = 0; t <= P.safeHorizon && !hit; t += 0.05) {
        const px = ux * P.playerSpeed * t, py = uy * P.playerSpeed * t;
        hit = s.threats.some(b => Math.hypot(b.dx + b.vx * t - px, b.dy + b.vy * t - py) < P.hitRadius)
          || s.enemies.some(e => {
            const c = P.chasers[e.type]; if (!c) return false;
            const d0 = Math.hypot(e.dx, e.dy) || 1;
            return Math.hypot(e.dx - (e.dx / d0) * c.speed * t - px, e.dy - (e.dy / d0) * c.speed * t - py) < P.hitRadius;
          });
      }
      if (hit) out.push(k);
    }
    return out;
  }
  // Code-side steering: away from close chasers, back to the center, and a projectile dodge
  // only when every direction is unsafe. Returns null when the AI's choice should be used.
  function guide(s, unsafe) {
    let vx = 0, vy = 0, threatened = false;
    for (const e of s.enemies) {
      const d = Math.hypot(e.dx, e.dy);
      if (d >= P.avoidDistance || d === 0) continue;
      const w = ((P.avoidDistance - d) / P.avoidDistance) * 2.5;
      vx -= (e.dx / d) * w; vy -= (e.dy / d) * w; threatened = true;
    }
    const all = unsafe.length === Object.keys(VEC).length;
    const live = new Set();
    for (const b of s.threats) {
      live.add(b.id);
      if (!all) continue;
      const h = predict(b); if (!h) continue;
      const sp = Math.hypot(b.vx, b.vy), nx = -b.vy / sp, ny = b.vx / sp;
      let side = dodgeSide.get(b.id);
      if (side == null) {
        const pass = h.cx * nx + h.cy * ny;
        side = Math.abs(pass) > 2 ? -Math.sign(pass) : ((nx * s.player.centerDx + ny * s.player.centerDy) >= 0 ? 1 : -1);
        dodgeSide.set(b.id, side);
      }
      const w = 1 + (1 - h.t / P.safeHorizon) * 2;
      vx += nx * side * w; vy += ny * side * w; threatened = true;
    }
    for (const id of dodgeSide.keys()) if (!live.has(id)) dodgeSide.delete(id);
    const r = options.centerRadius;
    const off = options.preferCenter && r != null && s.player.centerDistance > r;
    if (off) {
      const cd = s.player.centerDistance || 1;
      const pull = threatened ? 0.3 : Math.min(cd / r, 2);
      vx += (s.player.centerDx / cd) * pull; vy += (s.player.centerDy / cd) * pull;
    }
    if (!threatened && !off) return null;
    if (unsafe.includes(dirOf(vx, vy))) {
      const safe = Object.keys(VEC).filter(k => k !== 'STAY' && !unsafe.includes(k));
      if (safe.length) {
        let best = safe[0], bd = -Infinity;
        for (const k of safe) { const [ux, uy] = unit(k); const d = ux * vx + uy * vy; if (d > bd) { bd = d; best = k; } }
        return unit(best);
      }
      if (!unsafe.includes('STAY')) return [0, 0];
    }
    return [vx, vy];
  }
  function describe(e) {
    const kind = e.vx != null ? '弾' : (ENTITY[e.type] || e.type);
    return `${kind}${e.dir}${e.distance}${e.telegraph === 'charging' ? '予兆' : ''}`;
  }
  function threatsText(s) {
    const items = [
      ...s.enemies.map(e => ({ d: e.distance, t: describe(e) })),
      ...s.threats.filter(predict).map(t => ({ d: t.distance, t: describe(t) })),
    ].sort((a, b) => a.d - b.d);
    return items.slice(0, P.maxThreats).map(i => i.t).join(' ') || 'なし';
  }

  // --- observe: one of three situations ---
  function observeBattle(s) {
    if (startedAt == null) startedAt = performance.now();
    const elapsed = (performance.now() - startedAt) / 1000;
    const metrics = { scene: 'Battle', hp: s.player.hp, maxHp: s.player.maxHp, defeated: s.defeated, target: s.target,
      centerDistance: s.player.centerDistance, fps: s.fps, hits: s.hits.length };
    if (s.gameOver) { release(); return { done: { success: !!s.win, reason: s.win ? 'win' : 'lose', hits: s.hits }, metrics }; }
    if (options.surviveSeconds && elapsed >= options.surviveSeconds) {
      release(); return { done: { success: true, reason: 'survived', hits: s.hits }, metrics };
    }

    const unsafe = unsafeDirs(s);
    const guided = guide(s, unsafe);
    pending = { kind: 'move', guided };
    const threats = threatsText(s);
    const state = { 脅威: threats };
    if (options.preferCenter) state.中央 = `${s.player.centerDir}${s.player.centerDistance}`;
    if (unsafe.length) state.危険な方向 = unsafe.join(' ');
    const safe = Object.keys(DIRS).filter(k => !unsafe.includes(k));
    let instructions = MOVE_INSTRUCTIONS;
    if (options.surviveSeconds) instructions += ` ${options.surviveSeconds}秒生き残るのが目的。`;
    if (options.preferCenter) instructions += ' 脅威が無ければ「中央」の方向へ寄る。';
    const progress = options.surviveSeconds ? `生存 ${Math.round(elapsed)}/${options.surviveSeconds}秒` : `撃破 ${s.defeated}/${s.target}`;
    return {
      state,
      questions: { move: { type: 'choice', instructions, criteria: Object.fromEntries((safe.length ? safe : Object.keys(DIRS)).map(k => [k, DIRS[k]])) } },
      metrics: { ...metrics, threats, unsafe: unsafe.join(' '), guard: guided != null },
      display: [`HP ${s.player.hp}/${s.player.maxHp}`, progress, `脅威: ${threats}`, ...(unsafe.length ? [`危険な方向: ${unsafe.join(' ')}`] : [])],
    };
  }

  function observeMenu(m) {
    if (!visited.includes(m.scene)) visited.push(m.scene);
    pending = { kind: 'tap', candidates: m.candidates };
    return {
      state: { 画面: m.scene, 訪れた画面: visited.join(' ') },
      questions: { tap: { type: 'choice', instructions: NAV_INSTRUCTIONS, criteria: Object.fromEntries(m.candidates.map(c => [c.id, c.label])) } },
      metrics: { scene: m.scene },
      display: [`画面: ${m.scene}`, `ボタン: ${m.candidates.map(c => c.label).join(' / ')}`],
    };
  }

  window.__qa = {
    configure(o) {
      options = o || {};
      if (options.disableWin && window.__qaDisableWin) window.__qaDisableWin();
    },
    observe() {
      if (options.stopAtScene && window.__sceneReady && window.__sceneReady(options.stopAtScene)) {
        release();
        return { done: { success: true, reason: `reached_${options.stopAtScene}` }, metrics: { scene: options.stopAtScene } };
      }
      const battle = window.__combatState && window.__combatState();
      if (battle) return observeBattle(battle);
      const menu = window.__qaState && window.__qaState();
      if (menu && menu.candidates.length) return observeMenu(menu);
      return null; // nothing to decide right now (scene transition)
    },
    act(answers) {
      if (!pending) return;
      if (pending.kind === 'tap') {
        const c = pending.candidates.find(x => x.id === answers.tap.choice);
        if (c) tapScreen(c.x, c.y);
      } else if (pending.kind === 'move') {
        joystick(pending.guided || VEC[answers.move.choice] || [0, 0]);
      }
      pending = null;
    },
  };
})();
