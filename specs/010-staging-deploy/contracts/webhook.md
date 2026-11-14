# Contract: `POST /webhook` の追加分（010）

007 の [webhook.md](../../007-github-intake/contracts/webhook.md) の判定の順の 3（JSON）のあとに、イベントの種類で分ける（009 の `check_suite`・`pull_request` と同じ位置）。

## 扱うイベント

| `X-GitHub-Event` | 条件 |
|---|---|
| `push` | `[staging].repo` が空でない、`repository.full_name` が `[staging].repo` と同じ（大文字小文字を区別しない）、`ref` が `refs/heads/<repository.default_branch>`、`deleted` が偽、`after` が 0 だけでない |

## 応答

| 場合 | 応答 |
|---|---|
| 必要な項目がない（TypeBox の検証に合わない） | `400 {"error":"invalid_payload"}` |
| 条件に合わない | `202 {"result":"ignored"}`（`info` のログに理由: `staging_disabled`・`repo`・`ref`・`deleted`） |
| 同じリポジトリの同じ commit の記録がある | `202 {"result":"duplicate","deployment":<id>}` |
| 積んだ | `202 {"result":"deploy_queued","deployment":<id>}`。`deployments` に `queued`。応答のあとでデプロイの実行器を起こす |
| DB に書けない | `500 {"error":"internal_error"}`（配送の ID をログに残す。App の Recent Deliveries から再送できる） |

- GitHub の API は呼ばない。ジョブとの結び付けは実行器が行う（research R3）
- 許可ユーザー・権限の確認はしない（main に push できるのはブランチ保護を通った人間か GitHub の auto-merge だけ。デプロイするのは設定で指定したリポジトリだけ）

## 取り出す項目（`src/github/events.ts` の `toPushEvent`）

```ts
{
  ref: string;
  before: string;   // 40 桁の16進
  after: string;    // 40 桁の16進
  deleted?: boolean;
  repository: { full_name: string; default_branch: string };
}
```

余分な項目は許す。GitHub の型は `github/` の外に出さず、`PushEvent`（data-model.md 6章）に変える。
