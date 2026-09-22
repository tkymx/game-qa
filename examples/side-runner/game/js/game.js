// Side Runner — a small keyboard side-scrolling platformer used as a game-qa example.
// Controls: ArrowLeft / ArrowRight to run, Space or ArrowUp to jump. Stomp enemies from above,
// avoid touching them from the side, don't fall into pits, reach the flag.

const W = 800, H = 450;
const GROUND_Y = 410;
const WORLD_W = 3300;
const RUN_SPEED = 200;
const JUMP_VELOCITY = -520;
const GRAVITY = 1200;
const MAX_HP = 3;
const INVULN_MS = 1000;

// [left, right] of each ground segment; the gaps between them are pits
const GROUND = [[0, 600], [720, 1300], [1420, 2000], [2110, 2600], [2720, WORLD_W]];
// floating platforms and a wall to jump over: [x, y, width, height]
const BLOCKS = [[900, 300, 160, 20], [1600, 290, 120, 20], [2250, 300, 140, 20], [1150, GROUND_Y - 60, 40, 60]];
// walkers patrol between two x positions on the ground
const WALKERS = [[330, 560], [780, 1100], [1480, 1950], [2150, 2560], [2760, 3000]];
const GOAL_X = 3150;

class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }
  create() {
    this.add.text(W / 2, 150, 'SIDE RUNNER', { fontSize: '48px', color: '#ffd166', fontStyle: 'bold' }).setOrigin(0.5);
    this.add.text(W / 2, 240, 'Enter / Space でスタート', { fontSize: '20px', color: '#e0e6f0' }).setOrigin(0.5);
    this.input.keyboard.once('keydown-ENTER', () => this.scene.start('Stage'));
    this.input.keyboard.once('keydown-SPACE', () => this.scene.start('Stage'));
  }
}

class StageScene extends Phaser.Scene {
  constructor() { super('Stage'); }

  create() {
    this.physics.world.setBounds(0, 0, WORLD_W, H + 200);
    this.cameras.main.setBounds(0, 0, WORLD_W, H);
    this.add.rectangle(WORLD_W / 2, H / 2, WORLD_W, H, 0x152238).setDepth(-2);

    this.solids = this.physics.add.staticGroup();
    for (const [l, r] of GROUND) {
      const g = this.add.rectangle((l + r) / 2, GROUND_Y + 20, r - l, 40, 0x3a6b35);
      this.solids.add(g);
    }
    for (const [x, y, w, h] of BLOCKS) {
      const b = this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x8d6e4f);
      this.solids.add(b);
    }

    this.goal = this.add.rectangle(GOAL_X, GROUND_Y - 60, 12, 120, 0xffd166);
    this.physics.add.existing(this.goal, true);

    this.player = this.add.rectangle(80, GROUND_Y - 40, 26, 36, 0x4fc3f7);
    this.physics.add.existing(this.player);
    this.player.body.setGravityY(GRAVITY).setCollideWorldBounds(false);
    this.physics.add.collider(this.player, this.solids);
    this.cameras.main.startFollow(this.player, true, 0.15, 0.15, -120, 0);

    this.walkers = this.physics.add.group();
    WALKERS.forEach(([from, to], i) => {
      const e = this.add.rectangle(from + 20, GROUND_Y - 14, 28, 28, 0xef5350);
      this.physics.add.existing(e);
      e.body.setGravityY(GRAVITY);
      e.body.setVelocityX(70);
      e.patrol = [from, to];
      e.wid = 'w' + i;
      this.walkers.add(e);
    });
    this.physics.add.collider(this.walkers, this.solids);
    this.physics.add.overlap(this.player, this.walkers, (p, e) => this.onEnemy(e));
    this.physics.add.overlap(this.player, this.goal, () => this.finish(true, 'goal'));

    this.hp = MAX_HP;
    this.stomped = 0;
    this.invulnUntil = 0;
    this.isOver = false;
    this.didWin = false;
    this.endReason = null;
    this.startedAt = this.time.now;
    this.hud = this.add.text(12, 10, '', { fontSize: '16px', color: '#ffffff' }).setScrollFactor(0);

    this.keys = this.input.keyboard.addKeys({ left: 'LEFT', right: 'RIGHT', up: 'UP', space: 'SPACE' });
  }

  onEnemy(e) {
    if (this.isOver || !e.active) return;
    const falling = this.player.body.velocity.y > 50 && this.player.y < e.y - 10;
    if (falling) {
      e.destroy();
      this.stomped++;
      this.player.body.setVelocityY(JUMP_VELOCITY * 0.6);
      return;
    }
    if (this.time.now < this.invulnUntil) return;
    this.hp--;
    this.invulnUntil = this.time.now + INVULN_MS;
    this.player.body.setVelocity(this.player.x < e.x ? -220 : 220, -250);
    this.player.setFillStyle(0xff8a80);
    this.time.delayedCall(200, () => this.player.active && this.player.setFillStyle(0x4fc3f7));
    if (this.hp <= 0) this.finish(false, 'hp');
  }

  finish(win, reason) {
    if (this.isOver) return;
    this.isOver = true;
    this.didWin = win;
    this.endReason = reason;
    this.player.body.setVelocity(0, 0);
    this.physics.pause();
    this.add.text(this.cameras.main.scrollX + W / 2, H / 2, win ? 'CLEAR!' : 'GAME OVER', { fontSize: '44px', color: win ? '#ffd166' : '#ff8a80', fontStyle: 'bold' }).setOrigin(0.5);
  }

  update() {
    if (this.isOver) return;
    const body = this.player.body;
    const onGround = body.blocked.down || body.touching.down;
    if (this.keys.left.isDown) body.setVelocityX(-RUN_SPEED);
    else if (this.keys.right.isDown) body.setVelocityX(RUN_SPEED);
    else if (onGround) body.setVelocityX(0);
    if (onGround && (Phaser.Input.Keyboard.JustDown(this.keys.space) || Phaser.Input.Keyboard.JustDown(this.keys.up))) {
      body.setVelocityY(JUMP_VELOCITY);
    }
    if (this.player.x < 13) this.player.x = 13;
    if (this.player.y > H + 60) { this.hp = 0; this.finish(false, 'fell'); }

    this.walkers.getChildren().forEach(e => {
      if (e.x <= e.patrol[0]) e.body.setVelocityX(70);
      else if (e.x >= e.patrol[1]) e.body.setVelocityX(-70);
    });
    const secs = Math.floor((this.time.now - this.startedAt) / 1000);
    this.hud.setText(`HP ${this.hp}/${MAX_HP}   ${Math.round(this.player.x / GOAL_X * 100)}%   ${secs}s`);
  }
}

window.__game = new Phaser.Game({
  type: Phaser.AUTO,
  width: W,
  height: H,
  backgroundColor: '#0f1724',
  physics: { default: 'arcade', arcade: { debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [TitleScene, StageScene],
});

window.__sceneReady = key => {
  const s = window.__game && window.__game.scene.getScene(key);
  return !!(s && s.sys && s.sys.isActive());
};
