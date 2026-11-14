# Contract: `POST /webhook` の追加分（009）

007 の [webhook.md](../../007-github-intake/contracts/webhook.md) の判定の順の 3（JSON）のあとに、イベントの種類で分ける。`issue_comment`・`ping` は 007 のまま。

## 扱うイベント

| `X-GitHub-Event` | 扱う `action` | 結び付けるジョブ |
|---|---|---|
| `check_suite` | `completed` | `repo = repository.full_name` かつ `branch = check_suite.head_branch` かつ `head_sha = check_suite.head_sha` かつ `status = 'ci_waiting'` |
| `pull_request` | `closed` | `repo = repository.full_name` かつ `pr_number = pull_request.number` かつ `status = 'ci_waiting'` |

## 応答

| 場合 | 応答 |
|---|---|
| 必要な項目がない（TypeBox の検証に合わない） | `400 {"error":"invalid_payload"}` |
| 扱わない `action`、結び付くジョブがない | `202 {"result":"ignored"}`（`info` のログに理由: `action`・`no_job`） |
| 結び付いた | `202 {"result":"ci_noted","job":<id>}`。`jobs.ci_event_at` に今の時刻、`job_events` に `ci_event`。応答のあとで見回りを起こす |
| DB に書けない | `500 {"error":"internal_error"}` |

- GitHub の API は呼ばない（権限の確認も要らない。知らせは見回りが結論を取り直すきっかけにだけ使い、内容を信用しない）
- 同じ知らせが2回届いても、`ci_event_at` を上書きするだけ（見回りの評価が1回増えるだけで、結論の記録は重複しない）
- 許可ユーザーの確認はしない（ジョブに結び付かない知らせは何もしないため）

## 取り出す項目（`src/github/events.ts` の `toCiEvent`）

```ts
// check_suite
{ action: string; check_suite: { head_branch: string | null; head_sha: string }; repository: { full_name: string } }
// pull_request
{ action: string; pull_request: { number: number; merged: boolean | null }; repository: { full_name: string } }
```

余分な項目は許す。GitHub の型は `github/` の外に出さず、`CiEvent`（data-model.md 5章）に変える。
