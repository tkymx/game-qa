# Game ↔ game-qa protocol

game-qa does not know anything about your game's input, rules or genre. It only calls three
functions on `window.__qa` (the name is configurable with `"hook"` in `qa.config.json`).

```
game-qa                                   your game (window.__qa)
───────                                   ───────────────────────
configure(scenario.options)        ──▶    remember test conditions
loop:
  observe()                        ──▶    { state, questions, metrics?, display?, done? }
  decide(state, questions)  (Jev / Laya)
  act(answers)                     ──▶    turn the answers into the game's own input
```

## `observe()`

Called repeatedly. Return one of:

| Return | Meaning |
|---|---|
| `{ state, questions, ... }` | Ask the model something now |
| `{ done: { success, reason, ... }, metrics? }` | The run is over (win, lose, survived, reached a screen, ...) |
| `null` | Nothing to decide right now (loading, scene transition); game-qa waits a moment and asks again |

```js
observe() {
  return {
    // Context for the model. Any JSON; keep it short (local models get slower with long inputs).
    state: { screen: 'Title', coins: 120 },

    // Typed questions, passed to the decision engine as-is.
    // choice: pick one key of `criteria` / score: rate on a scale / noul: probability that something is true
    questions: {
      tap: {
        type: 'choice',
        instructions: 'Pick the next button to explore a screen you have not visited yet.',
        criteria: { start: 'Start', settings: 'Settings' },   // only offer what is safe and possible
      },
    },

    // Optional: numbers to log and compare between runs. Standard names used by the report:
    // hp, maxHp, centerDistance, guard (true when your code overrode the model), fps, scene
    metrics: { scene: 'Title' },

    // Optional: lines shown in the monitor app for this step
    display: ['Screen: Title', 'Buttons: Start / Settings'],
  };
}
```

## `act(answers)`

Receives the engine's answers keyed by question id, e.g.
`{ tap: { choice: 'start', confidence: 0.82, probabilities: { start: 0.82, settings: 0.18 } } }`.
Perform the action however your game is played: dispatch pointer/mouse/keyboard events on the
canvas, drag a virtual joystick, or call an internal function. Sending real input events is
recommended when you want the QA run to exercise your actual input handling.

## `configure(options)` (optional)

Called once after the scenario's `setup` steps, with the scenario's `options` object. Use it for
test conditions such as a time limit to survive, disabling the win condition, or where to stop.

## Tips from the example game

- **Remove choices instead of forbidding them in words.** Small, fast models follow "don't do X"
  poorly. Leave dangerous buttons and directions that would get hit out of `criteria`.
- **Keep code in charge of what must never fail.** The example game steers away from close
  enemies itself and only lets the model choose among safe directions.
- **Ask often in real-time games.** With Laya (~20 ms) the example asks 20–37 times per second;
  scenarios can set `intervalMs` (menus usually need ~500 ms for screens to change).

## Scenario file

```json
{
  "title": "Survive 60 s near the center",
  "maxSeconds": 75,
  "maxSteps": 1000,
  "intervalMs": 0,
  "setup": [
    { "waitFor": "window.__sceneReady && window.__sceneReady('Title')" },
    { "eval": "window.__startScene('Battle')" },
    { "wait": 500 }
  ],
  "options": { "surviveSeconds": 60 },
  "compare": true
}
```

`setup` steps are JS expressions evaluated in the page before the loop starts. `compare: false`
excludes a scenario from `game-qa compare`.
