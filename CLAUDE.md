# CLAUDE.md

さくらのVPS上で24時間稼働する自律型ソフトウェアファクトリー。Issue のコメント（`@agent`）をトリガーに、計画・実装・検査を別モデルで回し、自動マージ → ステージングデプロイまで行う。推論は さくらのAI Engine だけで行う。Zennfes Autumn 2026 への応募作品（締切 2026-12-16）。

## 設計ドキュメント（`docs/design/`）

- 作業前に関係する文書を読む。方針は `01`、構成は `03` を正とする
- 決定事項が変わったら、関係する文書をすべて同時に直す
- 決定事項と根拠だけを書く。TODO・次のアクション・変更履歴は書かない
- 「国産インフラで完結」とは書かない（リポジトリは GitHub）。「推論を国産・ZDRで閉じる」と書く

## 試行錯誤の記録（`docs/journal/`）

ブログ記事の材料にするため、試行錯誤を `docs/journal/` に残す。設計ドキュメントには決定事項だけを書くので、経緯はこちらに分ける。

- 1件1ファイル: `docs/journal/YYYY-MM-DD-<短い題名>.md`。同じ日の同じ話題は1つのファイルに追記する
- 書くタイミング: 想定と違った挙動・エラーに当たったとき、方針を変えたとき、選択肢を比べて決めたとき、調べて分かった事実（バージョン・仕様の食い違いなど）があったとき
- 書く内容: 何をしようとしたか、何が起きたか（エラー文・コマンド・数値はそのまま）、試したこと、結論と理由、まだ分かっていないこと
- うまくいかなかった試みも消さずに残す。記事で使えるよう、具体的な数値と再現手順を優先する
- 秘密情報（APIキー、トークン、秘密鍵）は書かない

## 応答

- ユーザーへの応答は日本語で書く

## 開発環境

ローカル開発は Ubuntu Workshop の `dev` を使う。定義は `.workshop/`、Node.js は Workshop の `node` SDK（`24/stable`）、Docker・git・ripgrep は `.workshop/devtools/hooks/setup-base` で入れる。

- 起動: `workshop launch dev`（初回）／`workshop start dev`。定義を変えたら `workshop refresh dev`
- コマンドは Workshop の中で実行する: `workshop exec dev -- <command>`（プロジェクトは `/project` にマウントされる）
- パッケージマネージャーは pnpm（corepack 経由）。npm・yarn は使わない。pnpm のバージョンは `package.json` の `packageManager` で固定する
- ツールを追加するときは `setup-base` に書く（ホストに直接入れない）。`/project` のファイルを使うもの（`scripts/install-gitleaks.sh` など）は、マウントのあとに動く `setup-project` に書く

## 開発

- Spec Kit（`/speckit-*`）で進める。設計と食い違う変更が要るときは、先に設計ドキュメントを直す
- スキーマは TypeBox に統一する（Zod は使わない）
- Pi は `@earendil-works/*` を使い、バージョンを完全に固定する（旧名 `@mariozechner/*` の情報は使わない）
- LLM は OpenAI互換の Chat Completions API で呼ぶ（無償枠で使えるのはこれだけ。Responses API は使わない）。開発中の動作確認は Google AI Studio の無償枠（`factory.dev.toml`）で行い、さくらは AI解禁（`docs/実装計画.md` 3章）まで呼ばない。Google AI Studio には公開してよいデータだけを送る。モデル名は `factory.toml` に置き、呼び出しはすべて予算ゲート（`streamFn` ラッパー）を通す
- APIキーや GitHub トークンをサンドボックスのコンテナに渡さない
