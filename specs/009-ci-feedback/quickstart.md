# Quickstart: CI連携（009）の確かめ方

## 自動テスト（GitHub と LLM を使わない）

```bash
workshop exec dev -- bash -lc 'cd /project && pnpm run check'
```

主に見るテスト:

| ファイル | 確かめること |
|---|---|
| `src/pipeline/ci.test.ts` | 結論の決め方（research R1）、通過・失敗・途中・時間切れ・マージ・閉じた、重複した知らせで記録が増えない、CI の欄 |
| `src/pipeline/ci-log.test.ts` | 時刻の除去、`##[error]` の前後、見つからなければ末尾、上限、マスク |
| `src/http/webhook.test.ts` | `check_suite`・`pull_request` の結び付け、`ci_noted`・`ignored`・`400` |
| `src/pipeline/worker.test.ts` | やり直しを先に取り出す、作業ブランチの取り直し（bare リポジトリ）、005 の入口に渡すもの、追加の push、上限での `failed` と Draft |
| `src/pipeline/ship.test.ts` | 更新の形（早送りの push、PR を作らない、格下げだけ、変更なしで `ci_unfixed`、閉じた PR で push しない） |
| `src/queue/jobs.test.ts` | `claimNextJob`・`noteCiEvent`・`listCiJobsToCheck` |

## 本物の GitHub での確認（AI解禁のあと、テスト用のリポジトリ）

前提: テスト用のリポジトリに CI（GitHub Actions）・main のブランチ保護（CI を必須チェック）・auto-merge の許可。App の設定に権限 Checks: read・Actions: read と、イベント `check_suite`・`pull_request` を足す。

1. CI が落ちる変更を頼む（例: 工程内テストのコマンドを CI より少なくしたリポジトリで、CI だけが検出する lint を踏む変更）
2. PR ができて `ci_waiting` になる → CI が落ちる → PR の本文の CI の欄に「❌ 失敗」、ジョブが `implementing` に戻る
3. やり直しの commit が同じ PR に積まれ、CI が通ると欄に「✅ 通過」、auto-merge でマージされて「🎉 マージ」、ジョブが `merged`
4. 記録の確認:

```sql
SELECT id, status, ci_status, ci_retries, head_sha FROM jobs ORDER BY id DESC LIMIT 5;
SELECT job_id, json_extract(detail, '$.kind') AS kind, detail FROM job_events
 WHERE json_extract(detail, '$.kind') LIKE 'ci_%' ORDER BY id DESC LIMIT 20;
```

時間切れの確認は、`ci_wait_timeout_minutes = 1` の設定で、CI のないリポジトリに PR を作らせる（1〜2 分後に `failed`（`ci_timeout`）と Draft）。
