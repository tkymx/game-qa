// game-qa adapter for Side Runner (keyboard platformer).
// Input is sent as real KeyboardEvents on window, so the game's own key handling runs.
// Each action is simulated a short way ahead with the game's physics numbers; actions that would
// end in a pit or run into an enemy from the side are left out of the choices.
(function () {
  const ACTIONS = { RIGHT: '右へ走る', JUMP_RIGHT: '右へジャンプ', JUMP: 'その場でジャンプ', LEFT: '左へ戻る', WAIT: '止まる' };
  const KEYS = { ArrowLeft: 37, ArrowRight: 39, Space: 32, Enter: 13 };
  const INSTRUCTIONS = '横スクロールアクションを右端のゴールまで進める。選択肢は、少し先まで動かしても穴に落ちたり敵に横からぶつかったりしない行動だけに絞ってある。穴や段差、正面の敵はジャンプで越える。敵は上から踏めば倒せる。';
  const PW = 26, PH = 36, EW = 28, EH = 28;

  let options = {};
  let pending = null;
  const held = new Set();

  // --- input: real keyboard events ---
  function key(type, code) {
    const ev = new KeyboardEvent(type, { key: code === 'Space' ? ' ' : code, code, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'keyCode', { get: () => KEYS[code] });
    Object.defineProperty(ev, 'which', { get: () => KEYS[code] });
    window.dispatchEvent(ev);
  }
  function hold(codes) {
    for (const c of [...held]) if (!codes.includes(c)) { key('keyup', c); held.delete(c); }
    for (const c of codes) if (!held.has(c)) { key('keydown', c); held.add(c); }
  }
  function press(code) { key('keydown', code); setTimeout(() => key('keyup', code), 90); }
  function releaseAll() { hold([]); }

  // --- look-ahead simulation using the game's own constants ---
  function groundAt(x) { return GROUND.some(([l, r]) => x >= l && x <= r); }
  // Returns null when the action looks safe, otherwise 'pit' / 'enemy' / 'blocked'.
  // Running is checked for RUN_CHECK seconds; once the player is in the air (a jump, or running off
  // an edge) the simulation continues until it lands or falls.
  // RUN_CHECK follows how often we are actually asked: a slow decision loop (e.g. a cloud model at
  // ~2 decisions/s) keeps running for longer before it can change its mind, so look further ahead.
  const MAX_T = 1.4;
  let RUN_CHECK = 0.3, lastObserveAt = null, cadence = 0.05, lag = 0.02, askedAt = null;
  // `lag` is how long the answer takes to come back; until then the current input keeps going.
  function simulate(s, action, lag) {
    let { x, y, vx, vy } = s.player;
    let onGround = s.player.onGround;
    const x0 = x;
    const jump = action === 'JUMP' || action === 'JUMP_RIGHT';
    let started = false, airborne = !onGround;
    const dt = 1 / 60;
    for (let t = 0; t < lag + MAX_T; t += dt) {
      if (!started && t >= lag) {
        started = true;
        if (action === 'RIGHT' || action === 'JUMP_RIGHT') vx = RUN_SPEED;
        else if (action === 'LEFT') vx = -RUN_SPEED;
        else if (onGround) vx = 0;
        if (jump && onGround) { vy = JUMP_VELOCITY; airborne = true; onGround = false; }
      }
      const ta = t - lag;
      if (started && !airborne && ta >= RUN_CHECK) return action === 'RIGHT' && x - x0 < 15 ? 'blocked' : null;
      vy += GRAVITY * dt;
      let nx = x + vx * dt;
      const ny = y + vy * dt;
      let landed = false;
      for (const [bx, by, bw, bh] of BLOCKS) {
        const inX = nx + PW / 2 > bx && nx - PW / 2 < bx + bw;
        if (inX && vy >= 0 && y + PH / 2 <= by + 1 && ny + PH / 2 >= by) { y = by - PH / 2; vy = 0; landed = true; }
        else if (inX && ny + PH / 2 > by + 2 && ny - PH / 2 < by + bh) { nx = x; }
      }
      x = nx;
      if (!landed) y = ny;
      if (!landed && vy >= 0 && y + PH / 2 >= GROUND_Y && y + PH / 2 <= GROUND_Y + 12 && groundAt(x)) { y = GROUND_Y - PH / 2; vy = 0; landed = true; }
      if (y > GROUND_Y + 30) return 'pit';
      for (const e of s.walkers) {
        const ex = e.x + e.vx * t;
        if (Math.abs(ex - x) < (PW + EW) / 2 && Math.abs(e.y - y) < (PH + EH) / 2 && !(vy > 50 && y < e.y - 10)) return 'enemy';
      }
      if (landed) {
        if (started && airborne && ta > 0.1) return null; // came down on solid ground
        airborne = false; onGround = true;
      } else if (!groundAt(x) || y + PH / 2 < GROUND_Y - 1) {
        airborne = true; onGround = false;
      }
    }
    return airborne ? 'pit' : null;
  }

  function describe(s) {
    const px = s.player.x;
    const out = [];
    const pit = GROUND.map(([, r], i) => (GROUND[i + 1] ? { at: r, w: GROUND[i + 1][0] - r } : null))
      .filter(g => g && g.at > px - 10 && g.at - px < 300)[0];
    if (pit) out.push(`穴 ${Math.round(pit.at - px)}px先(幅${pit.w})`);
    const wall = BLOCKS.filter(([bx, by]) => by >= GROUND_Y - 80 && bx > px && bx - px < 250)[0];
    if (wall) out.push(`段差 ${Math.round(wall[0] - px)}px先`);
    const enemies = s.walkers.filter(e => Math.abs(e.x - px) < 260).sort((a, b) => Math.abs(a.x - px) - Math.abs(b.x - px)).slice(0, 2);
    for (const e of enemies) out.push(`敵 ${e.x > px ? '右' : '左'}${Math.round(Math.abs(e.x - px))}px${e.vx < 0 ? '(こちらへ)' : ''}`);
    return out.join(' / ') || 'なし';
  }

  function stageState() {
    const st = window.__game.scene.getScene('Stage');
    if (!st || !st.sys || !st.sys.isActive() || !st.player) return null;
    const b = st.player.body;
    return {
      scene: st,
      player: { x: st.player.x, y: st.player.y, vx: b.velocity.x, vy: b.velocity.y, onGround: b.blocked.down || b.touching.down },
      walkers: st.walkers.getChildren().filter(e => e.active).map(e => ({ x: e.x, y: e.y, vx: e.body.velocity.x })),
    };
  }

  window.__qa = {
    configure(o) { options = o || {}; },

    observe() {
      if (window.__sceneReady('Title')) {
        pending = { kind: 'title' };
        return {
          state: { 画面: 'タイトル' },
          questions: { menu: { type: 'choice', instructions: 'ゲームを始める操作を選ぶ。', criteria: { START: 'Enterでスタート' } } },
          metrics: { scene: 'Title' },
          display: ['画面: タイトル'],
        };
      }
      const s = stageState();
      if (!s) return null;
      const now = performance.now();
      if (lastObserveAt != null) cadence = cadence * 0.8 + Math.min((now - lastObserveAt) / 1000, 1) * 0.2;
      lastObserveAt = now;
      RUN_CHECK = Math.min(Math.max(cadence * 1.5, 0.3), 1.0);
      const st = s.scene;
      const progress = Math.round((s.player.x / GOAL_X) * 100);
      const metrics = { scene: 'Stage', hp: st.hp, maxHp: MAX_HP, progress, x: Math.round(s.player.x), stomped: st.stomped, fps: Math.round(window.__game.loop.actualFps) };
      if (st.isOver) { releaseAll(); return { done: { success: st.didWin, reason: st.endReason }, metrics }; }

      const unsafe = Object.keys(ACTIONS).filter(a => simulate(s, a, lag));
      const safe = Object.keys(ACTIONS).filter(a => !unsafe.includes(a));
      // Going back or standing still never makes progress, so offer them only when no forward move is safe.
      // (Small models follow "mostly run right" poorly; not offering the option works.)
      const forward = safe.filter(a => a === 'RIGHT' || a === 'JUMP_RIGHT');
      const choices = forward.length ? forward : (safe.length ? safe : Object.keys(ACTIONS));
      pending = { kind: 'stage' };
      askedAt = now;
      const around = describe(s);
      return {
        state: { 周り: around, 足元: s.player.onGround ? '地上' : '空中', ゴール: `${Math.max(0, Math.round(GOAL_X - s.player.x))}px先` },
        questions: { action: { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(choices.map(a => [a, ACTIONS[a]])) } },
        metrics: { ...metrics, unsafe: unsafe.join(' ') },
        display: [`HP ${st.hp}/${MAX_HP}  進み具合 ${progress}%`, `周り: ${around}`, ...(unsafe.length ? [`除外: ${unsafe.map(a => ACTIONS[a]).join(' / ')}`] : [])],
      };
    },

    act(answers) {
      if (!pending) return;
      if (pending.kind === 'title') { press('Enter'); pending = null; return; }
      if (askedAt != null) lag = lag * 0.8 + Math.min((performance.now() - askedAt) / 1000, 1) * 0.2;
      const a = answers.action && answers.action.choice;
      if (a === 'RIGHT') hold(['ArrowRight']);
      else if (a === 'LEFT') hold(['ArrowLeft']);
      else if (a === 'JUMP_RIGHT') { hold(['ArrowRight']); press('Space'); }
      else if (a === 'JUMP') { hold([]); press('Space'); }
      else hold([]);
      pending = null;
    },
  };
})();
