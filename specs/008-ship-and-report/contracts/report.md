# Contract: PR の本文と Issue のコメントの文面（008）

本文はすべて `maskWith`（007。`maskSecrets` ＋ トークンの値）を通してから投稿する。ファクトリーの文面は日本語で書く。007 の [report.md](../../007-github-intake/contracts/report.md) に足す。

## PR の題

計画の概要（`plan.summary`）の1行目を 72 文字で切り詰めたもの。計画がなければ `Issue #<番号> への対応`。

## PR の本文（まとめレポート）

```markdown
### 🏭 ファクトリー: ジョブ #<id> のまとめ

Refs #<issue>

**自動マージ**: <振り分けの文>

| 条件 | 結果 | 値 |
|---|---|---|
| 検査役の判定 | ✅ | 合格 |
| diff の大きさ | ✅ / ❌ | <lines> 行 / 上限 <max> 行 |
| 禁止パス | ✅ / ❌ | なし / `<path>`（`<pattern>`）… |
| 秘密情報のスキャン | ✅ | 見つかりませんでした |
| `<skip_label>` ラベル | ✅ / ❌ | なし / あり / 確かめられませんでした |
| 作業の種類 | ✅ / ❌ | `<work_type>`（許可: `bugfix`, …） |

#### 計画
<plan.summary>

受け入れ条件:
1. …

#### 結果
| 項目 | 内容 |
|---|---|
| 工程内テスト | <最後の回の状態: 成功 / 失敗 / 実行していない>（<runs> 回実行） |
| 判定 | 合格。<受け入れ条件ごとの ✅／❌ の数> |
| やり直し | <retries> 回 |
| 消費したリクエスト | <requests> / 1ジョブの上限 <per_job_requests> |
| 変更 | <files> ファイル（+<insertions> −<deletions>） |

<details><summary>判定の理由</summary>

<verdict.reasons（2000 文字で切り詰め）>

</details>

<details><summary>変更したファイル</summary>

- `<path>`（50 件まで。超えたら「ほか <n> 件」）

</details>

<!-- 009・010 で CI・マージ・デプロイの結果をここに書き足す -->
```

振り分けの文:

| 振り分け | 文 |
|---|---|
| `auto_merge` | auto-merge（squash）を有効にしました。必須チェックがすべて通ると main にマージされます |
| `draft` | Draft PR にしました。人間の確認を待ちます。満たさなかった条件: <条件の名前の一覧>（`notes` があれば続けて書く） |
| `unsettled` | auto-merge を有効にできず、Draft にも変えられませんでした。この PR は自動ではマージされない可能性があります: <notes> |

- `draft_unavailable`（Draft を作れず通常の PR にした）のときは、`draft` の文に「このリポジトリでは Draft PR を作れないため、通常の PR にしました。auto-merge は有効にしていません」と足す
- `auto_merge_failed: <理由>`（有効化に失敗して Draft に変えた）のときは、`draft` の文に「auto-merge を有効にできませんでした: <理由>」と足す
- 本文全体は 60000 文字に収める（超えたら判定の理由とファイルの一覧を短くする）

## Issue のコメント（PR を作ったとき、1回）

```markdown
🏭 ジョブ #<id> の変更を PR にしました: <pr_url>

- 自動マージ: <auto-merge を予約しました / Draft にしました（満たさなかった条件: …） / 確定できませんでした>
- 消費したリクエスト: <requests>
```

## 失敗の報告（007 の表に足す分類）

| 分類 | 説明の文 |
|---|---|
| `secret_detected` | 変更に秘密情報らしい値が見つかった（または確かめられなかった）ため、push していません |
| `unshippable_change` | CI の定義（`.github/workflows`）を変更したため、push していません |
| `ship_failed` | commit・push・PR の作成に失敗しました |

- `shipping_not_available` は消す
- `secret_detected` の詳細は、見つかったものを `- <file>:<line>（<rule>）` の形で並べる（20 件まで）。値は書かない。スキャンできなかったときは「秘密情報のスキャンを実行できませんでした: <理由>」
- `unshippable_change` の詳細は、当たったパスの一覧
- 作業ブランチの行: push の前に止まったら 007 のとおり「`<branch>`（push していません）」、push のあとなら「`<branch>`（push 済み）」
