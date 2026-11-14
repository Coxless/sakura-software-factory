# evals（回帰評価）

ハーネス（プロンプト・ツール・ガード・コンテキスト管理）を変えたときに、計画から判定までの工程を作業の種類ごとのサンプル Issue で回し、成功率・消費リクエスト数・処理時間を前回と比べるためのセット。設計は `docs/design/04_ガードレールとハーネス設計.md` 4章、仕様は `specs/012-evals/`。

## 中身

```
projects/inventory/   依存のない小さな TypeScript のプロジェクト（node --test と自前の lint）
cases/<id>/
  case.toml           作業の種類・対象・工程内テストのコマンド・合格条件
  issue.md            1行目がタイトル、残りが本文
  setup/              （任意）工程の前に対象へ重ねるファイル（初期状態）
  hidden/             合格条件で使う隠しのファイル。工程が終わるまで作業ディレクトリに置かない
  solution/           模範解答（自己確認で使う）
```

形の詳細は `specs/012-evals/contracts/case-format.md`。

| ID                      | 作業の種類 | 内容                                                                                         |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `test-format-price`     | test       | `formatPrice` のテストを書く。壊した版を4種類とも見つけられるかで採点                        |
| `bugfix-parse-quantity` | bugfix     | `parseQuantity` の空白・小数の不具合を直す                                                   |
| `lint-no-console`       | chore      | lint の指摘（`console.log`・`any`）を挙動を変えずに直す。lint のスクリプトは採点前に元に戻す |
| `docs-api-section`      | docs       | README に公開関数の API の節を書く                                                           |
| `refactor-round-helper` | refactor   | 重複した丸めを `roundTo` にまとめる                                                          |

## 実行

コマンドは Workshop の中で実行する（`workshop exec dev -- …`）。

```sh
pnpm run sandbox:build
pnpm run eval:dev -- --self-check                    # LLM なし。何もしなければ落ち、模範解答で通るか
FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... pnpm run eval:dev -- --max-requests 250
pnpm run eval:compare -- data/evals-dev/<前>.json data/evals-dev/<後>.json
```

結果は `[storage].eval_dir`（開発用は `data/evals-dev`）に1回1ファイルで残り、同じセットの直前の実行と比べて表示される。

## ケースを足すとき

- 本リポジトリに置いてよい公開のデータだけで作る（開発用の LLM（Google AI Studio）に送るため）
- 合格条件は「Issue を解かないと通らない」ものにし、`--self-check` で確かめる
- 隠しのファイルは実装役が触らない場所（`.eval/`）に置く。実装役が書き換えうるファイル（lint のスクリプトなど）で採点するときは、元の版を `hidden/` に置いて上書きする
- 1ケースあたり 20〜50 リクエストを見込む。セットは小さく保つ（月3,000リクエストの枠を食うため）
