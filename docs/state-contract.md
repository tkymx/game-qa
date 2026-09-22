# State contract

game-qa never looks at pixels. Your game exposes its state through functions on `window`, and
game-qa reads them with Playwright. The function names are configurable via `hooks` in
`qa.config.json`; the defaults are below.

## nav mode — `window.__qaState()`

Return the tappable things on the current screen, or `null` when there is nothing to tap
(for example while a real-time scene is running).

```js
window.__qaState = () => ({
  scene: 'Title',                 // any string; used to track visited screens
  candidates: [
    { id: 'start', label: 'Start', x: 210, y: 520 },   // x/y in page (CSS) pixels
    { id: 'settings', label: 'Settings', x: 210, y: 600 },
  ],
  // any other fields are passed to the model as context (e.g. coins, level)
});
```

- `label` is matched against `dangerList` patterns; matching candidates are removed before the
  model sees them, so it cannot pick "Delete save data" or "Buy".
- If `nav.decorativePattern` is set, labels matching it are shown to the model as `[decorative]`.

## move mode — `window.__combatState()`

Real-time movement with an on-screen joystick. Positions are relative to the player, in game
pixels; `dir` is one of `N NE E SE S SW W NW`.

```js
window.__combatState = () => ({
  player: {
    hp: 80, maxHp: 100,
    // optional, only needed for scenarios with preferCenter / centerRadius
    centerDistance: 42, centerDir: 'SW', centerDx: -30, centerDy: 30,
  },
  enemies: [
    { id: 'e1', type: 'walker', dir: 'NE', distance: 120, dx: 85, dy: -85,
      telegraph: 'normal' },   // optional; e.g. 'charging' right before firing
  ],
  threats: [   // projectiles
    { id: 'p7', dir: 'N', distance: 90, dx: 0, dy: -90, vx: 0, vy: 185 },   // vx/vy in px/s
  ],
  joystick: { baseX: 210, baseY: 636, radius: 60 },   // page (CSS) pixels
  gameOver: false,
  win: false,
  // optional, recorded in logs / reports
  defeated: 3, target: 12, fps: 120, hits: [],
});
```

- The joystick is driven with real mouse input: press at `baseX/baseY`, then move within `radius`.
- Enemy `type`s listed under `move.chasers` in the config are treated as moving toward the
  player at the given `speed` when predicting collisions.
- `move.playerSpeed` must match the player's speed in px/s at full joystick tilt.

## Setup steps

Scenarios can prepare the game before the loop starts. Each step is a JS expression evaluated in
the page:

```json
"setup": [
  { "waitFor": "window.__sceneReady && window.__sceneReady('Title')" },
  { "eval": "window.__startScene('Battle')" },
  { "waitFor": "window.__sceneReady('Battle')", "timeoutMs": 5000 },
  { "wait": 500 }
]
```

These helpers are defined by the example game (`examples/archer-arena/game/js/game.js`); your game
can expose whatever it needs.
