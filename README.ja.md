# game-qa

[English](README.md) | 日本語

判断の速いAI（クラウドの [Jev](https://docs.typesafe.ai/introduction) と、手元の Mac で動く [Laya-MLX](https://github.com/mizorewww/laya-mlx)）に Web ゲームを遊ばせるための、Mac アプリと CLI です。シナリオを選んで実行し、AI が何を見て何を選んだかをログで追えます。

![同じステージ・同じシードで、上の Jev（1秒に約2回）は穴に落ち、下の Laya（1秒に約20回）は進み続ける](docs/media/side-runner-jev-vs-laya.gif)

game-qa がやるのは、ゲームを起動して、ゲームに今の状況を聞き、AI に選ばせて、その答えをゲームに返すことだけです。ゲームの操作方法やルールは知りません。何を選択肢にするか、選ばれたものをどう実行するかは、ゲーム側が決めます。

| 判断役 | 動く場所 | 1回の判断 | 必要なもの |
|---|---|---|---|
| Jev（TypeSafe AI） | クラウドAPI | 約240ミリ秒 | `TYPESAFE_API_KEY` |
| Laya-MLX | 手元の Mac（Apple Silicon の GPU） | 約20ミリ秒 | 初回のモデルダウンロード以降は不要 |

サンプルのアクションゲームでは、1秒に20回以上判断できる Laya のほうが、1秒に2〜3回の Jev よりかなり生き残れました（同じ敵の出方で、60秒間の平均被ダメージは 8 対 23）。

![archer-arena：同じ弾を、左の Jev と右の Laya が避けている](docs/media/archer-arena-jev-vs-laya.gif)

## はじめかた

### 1. インストール

```sh
npm install
npx playwright install chromium

cp .env.example .env            # Jev を使う場合: TYPESAFE_API_KEY を書く（game-qa 直下。どのゲームでも共通）
bash laya/setup.sh              # Laya を使う場合: Apple Silicon と uv が必要
bash monitor-app/build_app.sh   # Mac の監視アプリ → monitor-app/JevQAMonitor.app
```

### 2. サンプルを動かす

```sh
node bin/game-qa.cjs run --config examples/archer-arena/qa.config.json --scenario combat --provider laya --headed
```

監視アプリを使う場合は、プロジェクト（`qa.config.json`）、シナリオ、Jev か Laya を選んで再生を押します。画面右にブラウザが開き、左に AI の判断・確信度・ゲームの状況が1回ずつ流れます。

### 3. game-qa とゲームの間の約束ごと

約束ごとはこれだけです。ゲーム側で `window.__qa` を用意します。

```js
window.__qa = {
  configure(options) {},   // シナリオの条件（制限時間、どこで止めるか など）
  observe() {              // 繰り返し呼ばれる
    return {
      state:     { screen: 'Title' },                                        // AIに渡す状況
      questions: { tap: { type: 'choice', instructions: '...', criteria: { start: 'はじめる' } } },
      metrics:   { hp: 80 },                                                  // 記録・比較用（任意）
      done:      null,                                                        // 終わるときは { success, reason }
    };                                                                        // null なら「今は判断することがない」
  },
  act(answers) {           // answers.tap.choice === 'start'
    // ゲーム自身の入力として実行する（イベントを送る、ジョイスティックを倒す、キーを押す など）
  },
};
```

game-qa は `state` と `questions` をそのまま Jev / Laya に渡し、返ってきた答えを `act` に渡します。細かい決まりとコツは [docs/protocol.md](docs/protocol.md)（英語）にまとめています。

### 4. 自分のゲームを Claude Code でつなぐ

このリポジトリには、連携部分と設定ファイルを書いてくれる Claude Code のスキル [`.claude/skills/game-qa-integrate`](.claude/skills/game-qa-integrate/SKILL.md) を入れてあります。

```sh
# 自分のゲームのリポジトリで使えるようにする（~/.claude/skills/ に置いてもよい）
mkdir -p <your-game>/.claude/skills && cp -r .claude/skills/game-qa-integrate <your-game>/.claude/skills/
```

そのうえで、ゲームのリポジトリで Claude Code に「このゲームを game-qa につないで」と頼むか、`/game-qa-integrate` を実行します。ゲームを読んで `window.__qa` を足し、`qa.config.json` とシナリオを作り、実際に動かして確認するところまで進めます。

## サンプル

| サンプル | 入力 | アダプタがやっていること |
|---|---|---|
| [`examples/archer-arena`](examples/archer-arena) | メニューのタップ + 仮想ジョイスティック（マウスイベント） | 8方向の選択肢から、当たる向きを外す |
| [`examples/side-runner`](examples/side-runner) | キーボード（← → Space） | 走る・跳ぶの選択肢から、穴に落ちる・敵にぶつかる行動を外す。AIの返事が遅いほど先まで確認する |

`side-runner` では、Laya は毎回ゴールまで着きます（約20秒、被弾なし）。1秒に2回ほどの Jev は、ステージの途中で穴に落ちるか HP が尽きることがほとんどでした。

## プロジェクトのファイル

ゲームごとに違うものは、すべて `qa.config.json` の隣に置きます。

```
my-game-qa/
  qa.config.json      ゲームの起動方法、フック名、既定の判断役
  scenarios/*.json    何を確かめるか（制限時間・回数、開始前の準備、configure() に渡す条件）
  danger-list.json    絶対に選ばせないラベル（ゲーム側の除外に加えた安全網）
```

```json
{
  "name": "archer-arena",
  "app": { "serve": "./game", "port": 8124 },
  "scenarios": "./scenarios",
  "dangerList": "./danger-list.json",
  "provider": "jev"
}
```

`app` は、`{ "command": "npm run dev", "url": "http://localhost:5173/" }`（起動コマンドを実行）や `{ "url": "https://staging.example.com/" }`（起動済みのURLに接続）とも書けます。実行中の状態・判断の一覧・全ログは `<プロジェクト>/.game-qa/` に書き出されます。

## 判断役の比較

```sh
node bin/game-qa.cjs compare --config examples/archer-arena/qa.config.json --runs 5
node bin/game-qa.cjs report  examples/archer-arena/.game-qa/compare-<日時>
```

`compare` は各シナリオを判断役ごとに同じシードで回して録画します（ページを読み込む前に `Math.random` を固定するので、敵の出方が揃います）。`report` は横並びの比較動画（`ffmpeg` が必要）と HTML のレポートを作ります。

## 関連記事

作った経緯と、比べて分かったことを書いています。

- [Jevで自作ゲームを自動QA、AIがプレイして動作確認](https://taku-game.com/entry/2026/09/22/204608)
- [Laya-MLXでゲームの自動QAをMacだけで動かしてみた](https://taku-game.com/entry/2026/09/22/204614)
- [リアルタイムアクションならLayaが圧勝、Jevと自動QA比較](https://taku-game.com/entry/2026/09/22/204622)

## ライセンス

Apache-2.0。[LICENSE](LICENSE) を参照してください。

## 現状

まだ初期段階（v0.1）です。監視アプリの画面表示は今のところ日本語です。Issue や PR は歓迎です。
