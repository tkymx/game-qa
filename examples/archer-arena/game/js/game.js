// Archer Arena — a small sample game for game-qa.
// プレイヤーは自動で最寄りの敵を弓で攻撃する(射程無制限)。操作は移動のみで、実機と同じ
// 仮想ジョイスティック(タップ&ドラッグ)で行う。
// 敵はマップ内の固定スポーン地点からまとまって湧く(予兆→出現→移動の3段階)。
// 突進してくる(walker)か、離れた場所から弾を撃ってくる(shooter)かの2種。
// マップ内には壁があり、移動・弾を遮る。HPが0になったら負け、規定数を倒したら勝ち。

const W = 420, H = 740;
const WIN_TARGET = 12;
const SPAWN_INTERVAL = 3200;
const WAVE_MIN = 2, WAVE_MAX = 3;
const TELEGRAPH_TIME = 700;
const MAX_ALIVE = 7;
const PLAYER_SPEED = 185;
const PLAYER_MAX_HP = 100;
const ATTACK_INTERVAL = 400;
const ARROW_SPEED = 420;
const ARROW_DAMAGE = 12;
const WALKER_SPEED = 60;
const WALKER_HP = 20;
const WALKER_CONTACT_DAMAGE = 8;
const WALKER_CONTACT_COOLDOWN = 800;
const SHOOTER_HP = 15;
const SHOOTER_PREFERRED_DIST = 210;
const SHOOTER_FIRE_INTERVAL = 1900;
const SHOOTER_CHARGE_TIME = 550;
const SHOOTER_PROJECTILE_SPEED = 185;
const SHOOTER_PROJECTILE_DAMAGE = 10;
const INVULN_TIME = 650;
const JOY_RADIUS = 60;
const JOY_BASE_X = W / 2;
const JOY_BASE_Y = H * 0.86;

// 固定スポーン地点(ジョイスティック操作エリアより上、マップ端寄り)。
// 「何個か固定」の要望どおり毎回この中からランダムに選ぶ。
const SPAWN_POINTS = [
  { x: 40, y: 40 }, { x: W / 2, y: 30 }, { x: W - 40, y: 40 },
  { x: 20, y: H * 0.4 }, { x: W - 20, y: H * 0.4 },
  { x: 40, y: H * 0.62 }, { x: W - 40, y: H * 0.62 },
];

// マップ中央付近の障害物。移動をブロックし、矢・敵弾もここで消える。
const WALLS = [
  { x: 110, y: 300, w: 90, h: 22 },
  { x: 310, y: 460, w: 90, h: 22 },
];

let eidCounter = 1;

class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }
  create() {
    this.cameras.main.setBackgroundColor('#1a1a2e');
    this.add.text(W / 2, H * 0.32, 'ARCHER ARENA', {
      fontFamily: 'sans-serif', fontSize: '34px', color: '#ffd966', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.add.text(W / 2, H * 0.32 + 46, 'QAサンプルゲーム', {
      fontFamily: 'sans-serif', fontSize: '14px', color: '#aaaaaa',
    }).setOrigin(0.5);

    const btn = this.add.rectangle(W / 2, H * 0.55, 200, 64, 0x4caf50).setInteractive({ useHandCursor: true });
    const label = this.add.text(W / 2, H * 0.55, 'はじめる', {
      fontFamily: 'sans-serif', fontSize: '24px', color: '#ffffff',
    }).setOrigin(0.5);
    btn._label = label;
    btn.on('pointerdown', () => this.scene.start('Battle'));
  }
}

class BattleScene extends Phaser.Scene {
  constructor() { super('Battle'); }

  create() {
    this.cameras.main.setBackgroundColor('#20263e');
    this.physics.world.setBounds(0, 0, W, H);

    this.hp = PLAYER_MAX_HP;
    this.maxHp = PLAYER_MAX_HP;
    this.killCount = 0;
    this.winTarget = WIN_TARGET;
    this.isOver = false;
    this.didWin = false;
    this.invulnUntil = 0;

    this.pendingSpawns = 0;

    this.player = this.add.circle(W / 2, H * 0.6, 14, 0x66ccff);
    this.physics.add.existing(this.player);
    this.player.body.setCircle(14);
    this.player.body.setCollideWorldBounds(true);

    this.walls = this.physics.add.staticGroup();
    WALLS.forEach(w => {
      const rect = this.add.rectangle(w.x, w.y, w.w, w.h, 0x50607a);
      this.physics.add.existing(rect, true);
      this.walls.add(rect);
    });

    this.enemies = this.physics.add.group();
    this.projectiles = this.physics.add.group();
    this.arrows = this.physics.add.group();

    this.physics.add.collider(this.player, this.walls);
    this.physics.add.collider(this.enemies, this.walls);
    this.physics.add.collider(this.arrows, this.walls, (a) => a.destroy());
    this.physics.add.collider(this.projectiles, this.walls, (p) => p.destroy());

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');

    // 仮想ジョイスティック(固定位置)。実機と同じ「タップ&ドラッグ」で操作させるための入力口。
    // QAランナーもキー入力やAPI直叩きではなく、この円をPlaywrightでタップ&ドラッグして操作する。
    this.joyActive = false;
    this.joyKnobX = JOY_BASE_X;
    this.joyKnobY = JOY_BASE_Y;
    this.joyBaseGfx = this.add.circle(JOY_BASE_X, JOY_BASE_Y, JOY_RADIUS, 0xffffff, 0.12).setDepth(10);
    this.joyKnobGfx = this.add.circle(JOY_BASE_X, JOY_BASE_Y, 22, 0xffffff, 0.28).setDepth(11);

    const withinBase = (x, y) => Phaser.Math.Distance.Between(x, y, JOY_BASE_X, JOY_BASE_Y) <= JOY_RADIUS * 1.8;
    this.input.on('pointerdown', (p) => { if (withinBase(p.x, p.y)) this.joyActive = true; });
    this.input.on('pointermove', (p) => {
      if (!this.joyActive) return;
      const dx = p.x - JOY_BASE_X, dy = p.y - JOY_BASE_Y;
      const dist = Math.min(Math.hypot(dx, dy), JOY_RADIUS);
      const ang = Math.atan2(dy, dx);
      this.joyKnobX = JOY_BASE_X + Math.cos(ang) * dist;
      this.joyKnobY = JOY_BASE_Y + Math.sin(ang) * dist;
      this.joyKnobGfx.setPosition(this.joyKnobX, this.joyKnobY);
    });
    this.input.on('pointerup', () => {
      this.joyActive = false;
      this.joyKnobX = JOY_BASE_X;
      this.joyKnobY = JOY_BASE_Y;
      this.joyKnobGfx.setPosition(JOY_BASE_X, JOY_BASE_Y);
    });

    this.hpText = this.add.text(10, 10, '', { fontFamily: 'sans-serif', fontSize: '16px', color: '#ffffff' });
    this.killText = this.add.text(10, 32, '', { fontFamily: 'sans-serif', fontSize: '14px', color: '#cccccc' });
    this.updateHud();

    this.spawnTimer = this.time.addEvent({ delay: SPAWN_INTERVAL, loop: true, callback: () => this.trySpawnWave() });
    this.attackTimer = this.time.addEvent({ delay: ATTACK_INTERVAL, loop: true, callback: () => this.autoAttack() });

    this.physics.add.overlap(this.arrows, this.enemies, (arrow, enemy) => this.onArrowHitEnemy(arrow, enemy));
    this.physics.add.overlap(this.player, this.enemies, (player, enemy) => this.onEnemyContact(enemy));
    this.physics.add.overlap(this.player, this.projectiles, (player, proj) => this.onProjectileHit(proj));

    // 最初の波をすぐ出す(いきなり無風だと退屈なため)
    this.trySpawnWave();
  }

  updateHud() {
    this.hpText.setText(`HP ${Math.max(0, this.hp)}/${this.maxHp}`);
    // 生存QAでは勝利条件を無制限にするので、そのときは目標数を出さない
    this.killText.setText(Number.isFinite(this.winTarget) && this.winTarget < 1e6 ? `撃破 ${this.killCount}/${this.winTarget}` : `撃破 ${this.killCount}`);
  }

  // 数体まとめて「予兆(赤マーカー) → 出現 → 移動」の順で湧かせる
  trySpawnWave() {
    if (this.isOver) return;
    if (this.killCount >= this.winTarget) return;
    const capacity = MAX_ALIVE - this.enemies.countActive(true) - this.pendingSpawns;
    const count = Math.min(Phaser.Math.Between(WAVE_MIN, WAVE_MAX), Math.max(capacity, 0));
    const points = Phaser.Utils.Array.Shuffle(SPAWN_POINTS.slice()).slice(0, count);
    points.forEach(p => this.telegraphSpawn(p));
  }

  telegraphSpawn(p) {
    this.pendingSpawns++;
    const marker = this.add.circle(p.x, p.y, 16, 0xff3333, 0.4);
    this.tweens.add({ targets: marker, alpha: 0.15, duration: 180, yoyo: true, repeat: 2 });
    this.time.delayedCall(TELEGRAPH_TIME, () => {
      this.pendingSpawns--;
      marker.destroy();
      if (!this.isOver) this.spawnEnemyAt(p);
    });
  }

  spawnEnemyAt(p) {
    const isWalker = Math.random() < 0.6;
    const gfxColor = isWalker ? 0xe74c3c : 0xf39c12;
    const gfx = this.add.circle(p.x, p.y, 12, gfxColor);
    this.physics.add.existing(gfx);
    const enemy = gfx;
    enemy.eid = 'e' + (eidCounter++);
    enemy.etype = isWalker ? 'walker' : 'shooter';
    enemy.hp = isWalker ? WALKER_HP : SHOOTER_HP;
    enemy.lastContactAt = 0;
    enemy.nextFireAt = this.time.now + Phaser.Math.Between(400, SHOOTER_FIRE_INTERVAL);
    enemy.charging = false;
    this.enemies.add(enemy);
  }

  autoAttack() {
    if (this.isOver) return;
    const alive = this.enemies.getChildren().filter(e => e.active);
    if (!alive.length) return;
    let nearest = null, nearestD = Infinity;
    for (const e of alive) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, e.x, e.y);
      if (d < nearestD) { nearestD = d; nearest = e; }
    }
    if (!nearest) return; // 射程無制限。マップ内にいる限りどこでも狙える
    const arrow = this.add.rectangle(this.player.x, this.player.y, 8, 8, 0xffffff);
    this.physics.add.existing(arrow);
    this.arrows.add(arrow);
    const ang = Phaser.Math.Angle.Between(this.player.x, this.player.y, nearest.x, nearest.y);
    arrow.body.setVelocity(Math.cos(ang) * ARROW_SPEED, Math.sin(ang) * ARROW_SPEED);
    this.time.delayedCall(1800, () => { if (arrow.active) arrow.destroy(); }); // 射程無制限ぶん長め
  }

  onArrowHitEnemy(arrow, enemy) {
    if (!arrow.active || !enemy.active) return;
    arrow.destroy();
    enemy.hp -= ARROW_DAMAGE;
    if (enemy.hp <= 0) {
      enemy.destroy();
      this.killCount++;
      this.updateHud();
      if (this.killCount >= this.winTarget) this.endGame(true);
    }
  }

  onEnemyContact(enemy) {
    if (this.isOver || !enemy.active) return;
    if (this.time.now < enemy.lastContactAt + WALKER_CONTACT_COOLDOWN) return;
    enemy.lastContactAt = this.time.now;
    this.damagePlayer(WALKER_CONTACT_DAMAGE, enemy, 'walker');
  }

  onProjectileHit(proj) {
    if (this.isOver || !proj.active) return;
    const hitInfo = { x: proj.x, y: proj.y, body: { velocity: { x: proj.body.velocity.x, y: proj.body.velocity.y } } };
    proj.destroy();
    this.damagePlayer(SHOOTER_PROJECTILE_DAMAGE, hitInfo, 'bullet');
  }

  damagePlayer(amount, src, source) {
    if (this.time.now < this.invulnUntil) return;
    // QA分析用: どこから何に当たったか、そのときプレイヤーがどちらへ動いていたか
    if (src) {
      const pv = this.player.body.velocity;
      (this.hitLog ||= []).push({
        ts: Date.now(), source, amount,
        from: dirLabel(src.x - this.player.x, src.y - this.player.y),
        srcVel: dirLabel(src.body.velocity.x, src.body.velocity.y),
        playerVel: Math.hypot(pv.x, pv.y) < 1 ? 'STAY' : dirLabel(pv.x, pv.y),
        px: Math.round(this.player.x), py: Math.round(this.player.y),
      });
    }
    this.hp -= amount;
    this.invulnUntil = this.time.now + INVULN_TIME;
    this.player.setFillStyle(0xff4444);
    this.time.delayedCall(150, () => { if (this.player.active) this.player.setFillStyle(0x66ccff); });
    this.updateHud();
    if (this.hp <= 0) this.endGame(false);
  }

  endGame(win) {
    if (this.isOver) return;
    this.isOver = true;
    this.didWin = win;
    this.spawnTimer.remove();
    this.attackTimer.remove();
    this.time.delayedCall(600, () => this.scene.start('GameOver', { win }));
  }

  update() {
    if (this.isOver) return;

    // 移動方向: 仮想ジョイスティック(タップ&ドラッグ) > キーボード(人間の手元確認用)
    let dx = this.joyKnobX - JOY_BASE_X;
    let dy = this.joyKnobY - JOY_BASE_Y;
    const joyLen = Math.hypot(dx, dy);
    if (joyLen > 6) {
      const speedRatio = Math.min(joyLen / JOY_RADIUS, 1);
      this.player.body.setVelocity((dx / joyLen) * PLAYER_SPEED * speedRatio, (dy / joyLen) * PLAYER_SPEED * speedRatio);
    } else {
      dx = 0; dy = 0;
      if (this.cursors.left.isDown || this.wasd.A.isDown) dx -= 1;
      if (this.cursors.right.isDown || this.wasd.D.isDown) dx += 1;
      if (this.cursors.up.isDown || this.wasd.W.isDown) dy -= 1;
      if (this.cursors.down.isDown || this.wasd.S.isDown) dy += 1;
      const len = Math.hypot(dx, dy) || 1;
      this.player.body.setVelocity((dx / len) * PLAYER_SPEED, (dy / len) * PLAYER_SPEED);
    }

    // 敵の行動
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      const d = Phaser.Math.Distance.Between(e.x, e.y, this.player.x, this.player.y);
      if (e.etype === 'walker') {
        const ang = Phaser.Math.Angle.Between(e.x, e.y, this.player.x, this.player.y);
        e.body.setVelocity(Math.cos(ang) * WALKER_SPEED, Math.sin(ang) * WALKER_SPEED);
      } else {
        // shooter: 距離を保ちつつ、周期的にプレイヤーへ発射
        const ang = Phaser.Math.Angle.Between(e.x, e.y, this.player.x, this.player.y);
        if (d > SHOOTER_PREFERRED_DIST + 20) e.body.setVelocity(Math.cos(ang) * 50, Math.sin(ang) * 50);
        else if (d < SHOOTER_PREFERRED_DIST - 20) e.body.setVelocity(-Math.cos(ang) * 50, -Math.sin(ang) * 50);
        else e.body.setVelocity(0, 0);

        if (!e.charging && this.time.now >= e.nextFireAt) {
          e.charging = true;
          e.setFillStyle(0xffe066);
          e.chargeDoneAt = this.time.now + SHOOTER_CHARGE_TIME;
        } else if (e.charging && this.time.now >= e.chargeDoneAt) {
          e.charging = false;
          e.setFillStyle(0xf39c12);
          e.nextFireAt = this.time.now + SHOOTER_FIRE_INTERVAL;
          const fa = Phaser.Math.Angle.Between(e.x, e.y, this.player.x, this.player.y);
          const proj = this.add.circle(e.x, e.y, 6, 0xffe066);
          this.physics.add.existing(proj);
          this.projectiles.add(proj);
          proj.pid = 'p' + (eidCounter++);
          proj.body.setVelocity(Math.cos(fa) * SHOOTER_PROJECTILE_SPEED, Math.sin(fa) * SHOOTER_PROJECTILE_SPEED);
          this.time.delayedCall(3000, () => { if (proj.active) proj.destroy(); });
        }
      }
    }
  }
}

class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOver'); }
  init(data) { this.win = !!(data && data.win); }
  create() {
    this.cameras.main.setBackgroundColor('#1a1a2e');
    this.add.text(W / 2, H * 0.4, this.win ? 'WIN!' : 'GAME OVER', {
      fontFamily: 'sans-serif', fontSize: '40px', color: this.win ? '#66ff99' : '#ff6666', fontStyle: 'bold',
    }).setOrigin(0.5);

    const btn = this.add.rectangle(W / 2, H * 0.58, 200, 64, 0x4caf50).setInteractive({ useHandCursor: true });
    const label = this.add.text(W / 2, H * 0.58, 'もういちど', {
      fontFamily: 'sans-serif', fontSize: '22px', color: '#ffffff',
    }).setOrigin(0.5);
    btn._label = label;
    btn.on('pointerdown', () => this.scene.start('Battle'));
  }
}

window.__game = new Phaser.Game({
  type: Phaser.AUTO,
  width: W,
  height: H,
  backgroundColor: '#1a1a2e',
  physics: { default: 'arcade', arcade: { debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [TitleScene, BattleScene, GameOverScene],
});

// --- QAフック ---

window.__sceneReady = function (key) {
  const sm = window.__game && window.__game.scene;
  if (!sm) return false;
  const sc = sm.getScene(key);
  return !!(sc && sc.sys && sc.sys.isActive());
};

window.__startScene = function (key, data) {
  window.__game.scene.start(key, data || {});
};

// メニュー画面(Title/GameOver)向けの汎用QA状態。Battle中はnullを返し、
// __combatState() 側の専用フックを使うことを促す。
window.__qaState = function () {
  const g = window.__game;
  if (!g || !g.canvas) return null;
  const active = g.scene.scenes.find(s => s.scene.key !== 'Battle' && s.sys && s.sys.isActive());
  if (!active) return null;
  const rect = g.canvas.getBoundingClientRect();
  const toScreen = (x, y) => ({
    x: Math.round(rect.left + x * (rect.width / g.config.width)),
    y: Math.round(rect.top + y * (rect.height / g.config.height)),
  });
  const candidates = [];
  active.children.list.forEach((c, i) => {
    if (c.input && c.input.enabled) {
      const label = (c._label && c._label.text) || c.type || 'obj';
      const pos = toScreen(c.x, c.y);
      candidates.push({ id: String(i), label: String(label).slice(0, 30), x: pos.x, y: pos.y });
    }
  });
  return { scene: active.scene.key, candidates };
};

function dirLabel(dx, dy) {
  const ang = Phaser.Math.RadToDeg(Math.atan2(dy, dx)); // -180..180, 0=East, 90=South(画面座標)
  const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const idx = Math.round(((ang + 180) / 45)) % 8;
  return dirs[(idx + 4) % 8] || 'E';
}

// 戦闘中のQA状態。相対方向(dir)と距離(distance)だけを渡し、座標計算はゲーム側に閉じる。
// 移動操作はAPI直叩きではなく、実機と同じ「ジョイスティックをタップ&ドラッグする」操作で
// 行わせるため、ここでは操作に必要な画面座標(joystick.baseX/baseY/radius)だけを渡す。
// QAランナー側はこの座標を基点に page.mouse.down/move/up を呼び出す。
window.__combatState = function () {
  const bs = window.__game.scene.getScene('Battle');
  if (!bs || !bs.sys || !bs.sys.isActive()) return null;
  const g = window.__game;
  const rect = g.canvas.getBoundingClientRect();
  const scaleX = rect.width / g.config.width;
  const scaleY = rect.height / g.config.height;
  const px = bs.player.x, py = bs.player.y;
  const rel = (x, y) => {
    const dx = x - px, dy = y - py;
    return { dir: dirLabel(dx, dy), distance: Math.round(Math.hypot(dx, dy)) };
  };
  const cx = W / 2, cy = H / 2;
  const centerDx = cx - px, centerDy = cy - py;
  return {
    scene: 'Battle',
    player: {
      hp: Math.max(0, bs.hp), maxHp: bs.maxHp,
      // マップ中央からの距離と、中央へ戻るための方向(「中央でバトルする」系シナリオ用)
      centerDistance: Math.round(Math.hypot(centerDx, centerDy)),
      centerDir: dirLabel(centerDx, centerDy),
      centerDx: Math.round(centerDx), centerDy: Math.round(centerDy),
    },
    enemies: bs.enemies.getChildren().filter(e => e.active).map(e => ({
      id: e.eid, type: e.etype, telegraph: e.charging ? 'charging' : 'normal', ...rel(e.x, e.y),
      dx: Math.round(e.x - px), dy: Math.round(e.y - py),
    })),
    // dx/dy: プレイヤーから見た正確な位置、vx/vy: 弾の速度(px/s)。QAランナーの衝突予測用
    threats: bs.projectiles.getChildren().filter(p => p.active).map(p => ({
      id: p.pid, ...rel(p.x, p.y),
      dx: Math.round(p.x - px), dy: Math.round(p.y - py),
      vx: Math.round(p.body.velocity.x), vy: Math.round(p.body.velocity.y),
    })),
    hits: bs.hitLog || [],
    defeated: bs.killCount,
    target: bs.winTarget,
    gameOver: bs.isOver,
    win: bs.didWin,
    joystick: {
      baseX: Math.round(rect.left + JOY_BASE_X * scaleX),
      baseY: Math.round(rect.top + JOY_BASE_Y * scaleY),
      radius: Math.round(JOY_RADIUS * Math.min(scaleX, scaleY)),
    },
    fps: Math.round(window.__game.loop.actualFps),
  };
};

// Test condition for survival scenarios: never end the battle by reaching the kill target.
window.__qaDisableWin = function () {
  const bs = window.__game.scene.getScene('Battle');
  if (bs) bs.winTarget = Number.MAX_SAFE_INTEGER;
};
