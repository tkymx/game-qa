# game-qa

Let a fast decision model play your web game and check it.

game-qa reads your game's state from a small `window` hook, asks a typed decision model which
button to tap or which way to move, and performs that action with real mouse input through
Playwright. Two decision engines are supported and share the same interface:

| Engine | Where it runs | One decision | Notes |
|---|---|---|---|
| [Jev](https://docs.typesafe.ai/introduction) (TypeSafe AI) | cloud API | ~240 ms | needs `TYPESAFE_API_KEY` |
| [Laya-MLX](https://github.com/mizorewww/laya-mlx) | your Mac (Apple Silicon GPU) | ~20 ms | no API key, no network after the first model download |

In the example action game, Laya's 20+ decisions per second kept the player alive far better than
Jev's 2–3 (average damage over 60 s: 8 vs 23, same seeds, same guard code).

## Modes

- **nav** — exploratory QA over menus. Taps through screens looking for crashes and dead ends.
  Labels that match a danger list ("delete", "purchase", ...) are removed before the model sees them.
- **move** — real-time movement QA with a virtual joystick. Directions that would collide within
  a short horizon are removed from the model's choices; a small guard handles chasers and keeps
  the player near the center when a scenario asks for it.

## Quick start

```sh
npm install
npx playwright install chromium

# Jev: put your key next to the config
cp examples/archer-arena/.env.example examples/archer-arena/.env   # then edit

# Laya (Apple Silicon, uv required)
bash laya/setup.sh

node bin/game-qa.cjs list --config examples/archer-arena/qa.config.json
node bin/game-qa.cjs run  --config examples/archer-arena/qa.config.json --scenario combat --provider laya --headed
```

## Project layout

Everything specific to a game lives next to its `qa.config.json`:

```
my-game-qa/
  qa.config.json      how to start the app, hook names, movement parameters
  scenarios/*.json    what to test (mode, time limits, setup steps)
  prompts.json        instructions and labels shown to the model (optional)
  danger-list.json    labels that must never be tapped (optional)
  .env                TYPESAFE_API_KEY (optional)
```

`qa.config.json`:

```json
{
  "name": "archer-arena",
  "app": { "serve": "./game", "port": 8124 },
  "hooks": { "nav": "__qaState", "move": "__combatState" },
  "scenarios": "./scenarios",
  "prompts": "./prompts.ja.json",
  "dangerList": "./danger-list.json",
  "provider": "jev",
  "move": { "playerSpeed": 185, "chasers": { "walker": { "speed": 60 } } }
}
```

`app` can also be `{ "command": "npm run dev", "url": "http://localhost:5173/" }` or just
`{ "url": "https://staging.example.com/" }`.

What your game has to expose is described in [docs/state-contract.md](docs/state-contract.md).

## Comparing engines

```sh
node bin/game-qa.cjs compare --config examples/archer-arena/qa.config.json --runs 5
node bin/game-qa.cjs report  examples/archer-arena/.game-qa/compare-<timestamp>
```

`compare` runs every move scenario with the same seeds (it replaces `Math.random` before the page
loads) for each engine and records video. `report` builds side-by-side videos (needs `ffmpeg`) and
an HTML report.

## Monitor app (macOS)

`monitor-app/` is a small SwiftUI app that starts runs, pauses/stops them, and shows each decision
live. Build it with `bash monitor-app/build_app.sh`.

## Status

Early and opinionated: the move mode assumes a top-down game with a virtual joystick. Contributions
that widen the state contract are welcome.
