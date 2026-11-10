# Contract: 追加する開発・運用コマンド（003）

001 の [commands.md](../../001-foundation/contracts/commands.md) に足す。

| コマンド | 中身 | 成功 | 失敗 |
|---|---|---|---|
| `pnpm run sandbox:build` | `docker build -t factory-sandbox:latest sandbox` | 作業場のイメージができる | Docker のエラーをそのまま出す |

- `pnpm run check` は変えない。Docker とテスト用イメージがあれば作業場のテストも実行し、なければ飛ばす（理由を1行出す）
- イメージのビルドにはネットワークが要る（apt と pnpm の取得）。作業場そのものはネットワークなしで動く
