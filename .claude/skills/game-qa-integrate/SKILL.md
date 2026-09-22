---
name: game-qa-integrate
description: Connect a web game to game-qa so Jev or Laya can play it. Adds a window.__qa adapter (observe / act / configure) to the game, creates qa.config.json and scenarios, and verifies with a real run. Use when the user says "connect my game to game-qa", "add game-qa to this game", "make this game playable by the QA app", or similar.
---

# Connect a game to game-qa

game-qa only talks to the game through `window.__qa` (see `docs/protocol.md` in the game-qa repo).
Your job is to write that adapter inside the user's game, plus a small project folder that tells
game-qa how to start the game and what to test. Do not change game-qa itself.

## 1. Understand the game (read, don't guess)

Find and note, with file paths:

- How the game is served locally (static folder, `npm run dev`, a URL) and on which port
- The engine (Phaser, PixiJS, Three.js, plain DOM, Unity WebGL, ...) and where the game object lives
- The screens/scenes and how to tell which one is active
- How the player gives input (buttons, keyboard, pointer drag, virtual joystick, swipe)
- What "finished" means for a run (game over, win, reaching a screen, surviving N seconds)

If the game has no global handle to its state, expose one minimal global (for example
`window.__game = game`) rather than restructuring the game.

## 2. Write the adapter

Create one file loaded after the game, e.g. `qa-adapter.js`, that defines:

```js
window.__qa = {
  configure(options) { /* store scenario options (time limits, where to stop, ...) */ },
  observe() {
    // null            -> nothing to decide now (loading / transition)
    // { done: {...} } -> run finished
    // otherwise       -> { state, questions, metrics?, display? }
  },
  act(answers) { /* turn answers.<questionId>.choice into the game's input */ },
};
```

Rules that matter (they come from measured runs, not taste):

- **Only offer safe, possible choices.** Build `criteria` from what can actually be done now.
  Leave out destructive buttons (delete data, purchase, reset) and moves that would obviously fail.
  Fast models ignore "don't do X" instructions far more often than they pick a missing option.
- **Keep `state` short.** A few keys with compact strings. Local models (Laya) slow down with
  long inputs.
- **Prefer real input events in `act`.** Dispatch mouse/pointer/keyboard events on the canvas or
  element so the game's own input handling is exercised. Hold state (e.g. a pressed joystick)
  inside the adapter and release it when the run is done.
- **Return `metrics`** with standard names when they exist: `scene`, `hp`, `maxHp`, `fps`,
  `centerDistance`, `guard` (true when adapter code overrode the model). Reports use them.
- **Remember the pending observation** in `observe()` so `act()` knows which candidate an id
  refers to.

Menu screens usually become one `choice` question over the visible buttons (label → screen
coordinates collected from the engine's interactive objects or the DOM). Real-time play usually
becomes a `choice` over movement directions or actions, asked many times per second.

Reference implementations in the game-qa repo:

- `examples/archer-arena/game/js/qa-adapter.js` — menu taps + a virtual joystick (mouse events),
  directions that would get hit are left out
- `examples/side-runner/game/js/qa-adapter.js` — keyboard platformer (KeyboardEvents with keyCode),
  each action is simulated ahead with the game's physics constants and left out if it ends in a pit
  or an enemy

Two things the side-runner taught:

- **Leave out choices that make no progress** unless nothing else is safe. A small model offered
  "go back" kept choosing it thousands of times; removing it from the choices fixed it at once.
- **Account for how slowly answers come back.** Measure the time between `observe()` calls and
  between `observe()` and `act()`, and simulate the current input continuing for that long before
  the chosen action starts. A cloud model answering in ~240 ms needs a much longer look-ahead.

## 3. Create the project folder

Next to the game (or in a `qa/` folder), create:

```
qa.config.json      { "name", "app": {...}, "scenarios": "./scenarios", "dangerList": "./danger-list.json", "provider": "laya" }
scenarios/<id>.json { "title", "maxSeconds", "intervalMs", "setup": [...], "options": {...} }
danger-list.json    { "patterns": ["delete", "reset", "purchase", "buy"] }
```

`app` is one of `{ "serve": "./dist", "port": 8124 }`, `{ "command": "npm run dev", "url": "http://localhost:5173/" }`
or `{ "url": "..." }`. Use `setup` steps to reach the screen the scenario starts on, and set
`intervalMs` to ~500 for menu scenarios so screens have time to change.

The Jev API key is **not** part of the project: it lives in `~/.config/game-qa/.env` (or an exported
`TYPESAFE_API_KEY`). Never write it into the game's repository.

## 4. Verify with a real run

From the game-qa directory:

```sh
node bin/game-qa.cjs list --config <path>/qa.config.json
node bin/game-qa.cjs run  --config <path>/qa.config.json --scenario <id> --provider laya --headed
```

Then read `<project>/.game-qa/status.json` and the latest `*.jsonl` log:

- `reason` should be the finish you expected (not `no_qa_hook`, not `timeout` on a menu scenario)
- each step should have a `choice` and, if you return them, sensible `metrics`
- `errors` should be 0 (page errors are recorded)

If `observe()` keeps returning `null`, check that the adapter script is loaded and that the scene
check matches the engine's real scene names. Fix, rerun, and report what the run did.
