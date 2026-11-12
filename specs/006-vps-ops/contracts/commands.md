# Contract: 追加する開発・運用コマンド（006）

001 の [commands.md](../../001-foundation/contracts/commands.md) と 003 の [commands.md](../../003-sandbox-tools/contracts/commands.md) に足す。

| コマンド | 中身 | 成功 | 失敗 |
|---|---|---|---|
| `pnpm start` | `node src/main.ts`（変更） | 起動処理のあと待ち受け、停止の合図まで動く。合図で正常に終わる（0） | 設定・マイグレーション・待ち受けの失敗で 1 |
| `pnpm run secrets:scan` | `gitleaks git --redact --no-banner --config .gitleaks.toml .` | 履歴全体で見つからなければ 0 | 見つかれば 1（値は伏せて出す）。gitleaks がなければ入れ方を示して失敗 |
| `pnpm run deploy:lint` | `bash deploy/scripts/lint.sh` | shellcheck・systemd-analyze・caddy validate/fmt がすべて通れば 0 | 最初に失敗した検査の出力を出して 1。Docker がなければ理由を出して失敗（飛ばさない） |
| `pnpm run deploy:rehearsal` | `bash deploy/rehearsal/run.sh` | 予行演習の確認項目がすべて通れば 0。後片付けまで行う | 失敗した手順・確認項目を出して 1。後片付けは行う |

## CI（`.github/workflows/ci.yml`）の変更

1. `actions/checkout` に `fetch-depth: 0`（履歴全体のスキャンのため）
2. `bash scripts/install-gitleaks.sh`（ランナーの `/usr/local/bin` に入れる。sudo を使う）
3. 既存の `pnpm install` → `sandbox:build` → `check` のあとに `pnpm run secrets:scan` と `pnpm run deploy:lint`

- `deploy:rehearsal` は CI では実行しない（特権付きのコンテナと 15 分の時間が要るため）
- `pnpm run check` は変えない（Docker なしでも通る今の形を保つ）

## Workshop（`.workshop/devtools/hooks/`）の変更

- `setup-base`: apt に `shellcheck` を足す
- `setup-project`（新規）: `bash /project/scripts/install-gitleaks.sh` を呼ぶ。`setup-base` の実行時には `/project` がまだマウントされていないため、マウントのあとに動く `setup-project` で入れる。`setup-project` は `workshop` ユーザーで動くので、スクリプトは `sudo` で `/usr/local/bin` に置く
