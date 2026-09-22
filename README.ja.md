# game-qa

[English](README.md) | 日本語

判断の速いAIに、Webゲームを自動でプレイさせて確認するツールです。

ゲーム側に用意した小さな関数（`window` に生やすもの）から状態を読み取り、「どのボタンを押すか」「どちらへ動くか」を型付きの判断モデルに選ばせて、Playwright から本物のマウス操作として実行します。判断役は次の2つに対応していて、どちらも同じ呼び出し方で差し替えられます。

| 判断役 | 動く場所 | 1回の判断 | 備考 |
|---|---|---|---|
| [Jev](https://docs.typesafe.ai/introduction)（TypeSafe AI） | クラウドAPI | 約240ミリ秒 | `TYPESAFE_API_KEY` が必要 |
| [Laya-MLX](https://github.com/mizorewww/laya-mlx) | 手元の Mac（Apple Silicon の GPU） | 約20ミリ秒 | APIキー不要。初回のモデルダウンロード以降はネット接続も不要 |

サンプルのアクションゲームでは、1秒に20回以上判断できる Laya のほうが、1秒に2〜3回の Jev よりかなり生き残れました（同じ敵の出方・同じ回避コードで、60秒間の平均被ダメージは 8 対 23）。

## モード

- **nav（画面巡り）** — メニューのボタンを選んで押し、画面を渡り歩きながら、エラーで止まらないか・抜けられない画面がないかを確かめます。「削除」「購入」など危険ボタンのリストに当たるものは、AIに見せる前に選択肢から外します。
- **move（移動）** — 仮想ジョイスティックで動くリアルタイムのゲーム向けです。少し先の時間までに弾や敵に当たる向きをAIの選択肢から外し、追ってくる敵からの離脱や、シナリオで指定したときの中央への引き戻しは小さなガードコードが受け持ちます。

## はじめかた

```sh
npm install
npx playwright install chromium

# Jev を使う場合: 設定ファイルの隣に APIキーを置く
cp examples/archer-arena/.env.example examples/archer-arena/.env   # 中身を書き換える

# Laya を使う場合（Apple Silicon と uv が必要）
bash laya/setup.sh

node bin/game-qa.cjs list --config examples/archer-arena/qa.config.json
node bin/game-qa.cjs run  --config examples/archer-arena/qa.config.json --scenario combat --provider laya --headed
```

## プロジェクトの構成

ゲームごとに違うものは、すべて `qa.config.json` の隣に置きます。

```
my-game-qa/
  qa.config.json      アプリの起動方法、状態を返す関数の名前、移動の速さなど
  scenarios/*.json    何を確かめるか（モード、制限時間、開始前の準備）
  prompts.json        AIに渡す指示文と呼び名（省略可）
  danger-list.json    絶対に押させないボタンのラベル（省略可）
  .env                TYPESAFE_API_KEY（省略可）
```

`qa.config.json` の例:

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

`app` は、フォルダをそのまま配信する形のほかに、`{ "command": "npm run dev", "url": "http://localhost:5173/" }`（起動コマンドを実行）や `{ "url": "https://staging.example.com/" }`（起動済みのURLに接続）とも書けます。

ゲーム側で用意する関数の形は [docs/state-contract.md](docs/state-contract.md)（英語）にまとめています。

## 判断役の比較

```sh
node bin/game-qa.cjs compare --config examples/archer-arena/qa.config.json --runs 5
node bin/game-qa.cjs report  examples/archer-arena/.game-qa/compare-<日時>
```

`compare` は、移動モードのシナリオを判断役ごとに同じシードで回して録画します（ページを読み込む前に `Math.random` を差し替えるので、敵の出方が揃います）。`report` は横並びの比較動画（`ffmpeg` が必要）と HTML のレポートを作ります。

## 監視アプリ（macOS）

`monitor-app/` は、シナリオを選んで実行・一時停止・停止しながら、AIの判断をリアルタイムに一覧できる SwiftUI 製の小さなアプリです。`bash monitor-app/build_app.sh` でビルドできます。画面の表示は今のところ日本語です。

## ライセンス

Apache-2.0。[LICENSE](LICENSE) を参照してください。

## 現状

まだ初期段階で、移動モードは「仮想ジョイスティックで動く見下ろし型のゲーム」を前提にしています。状態の約束ごとを広げる提案やコントリビュートは歓迎です。
