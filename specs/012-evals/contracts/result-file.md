# Contract: 結果のファイル（JSON）

置き場所: `[storage].eval_dir`（既定 `data/evals`）。1実行1ファイル `<runId>.json`、`runId = <YYYYMMDDTHHmmssZ>-<setName>`。

```jsonc
{
  "version": 1,
  "runId": "20261203T101500Z-evals",
  "setName": "evals",
  "startedAt": "2026-12-03T10:15:00.000Z",
  "finishedAt": "2026-12-03T11:40:12.000Z",
  "harness": { "commit": "68d2631…", "dirty": false },
  "provider": "sakura",
  "models": { "planner": "…", "implementer": "…", "verifier": "Qwen3.6", "verifier_alt": "gemma-4" },
  "options": { "cases": null, "repeat": 1, "maxRequests": 500 },
  // "stopped": "max_requests" | "budget_exceeded" | "aborted"   止まったときだけ
  "cases": [
    {
      "caseId": "bugfix-parse-quantity", "caseHash": "sha256:…", "workType": "bugfix", "attempt": 1,
      "status": "succeeded",             // succeeded | failed | error | not_run
      // "failure": "pipeline" | "grader"   failed のときだけ
      "reason": "…",
      "jobId": 41,
      "pipeline": { "outcome": "passed", "retries": 0, "rounds": 1, "requests": 18,
                    "diffStat": { "files": 2, "insertions": 12, "deletions": 3 },
                    "planWorkType": "bugfix", "tracePath": "…/job-41.jsonl" },
      "grader": { "status": "passed", "results": [ { "command": "…", "exitCode": 0, "durationMs": 812, "timedOut": false, "output": "…" } ] },
      "verifier":    { "model": "Qwen3.6", "verdict": "pass", "comparable": true, "calls": 1, "inputTokens": 5120, "outputTokens": 230, "latencyMs": 4100 },
      "verifierAlt": { "model": "gemma-4", "verdict": "fail", "comparable": true, "calls": 1, "inputTokens": 5050, "outputTokens": 310, "latencyMs": 3900 },
      "requests": 19,
      "durationMs": 412345
    }
  ],
  "summary": {
    "executed": 5, "succeeded": 3, "failed": 2, "errors": 0, "notRun": 0, "successRate": 0.6,
    "byWorkType": { "bugfix": { "executed": 1, "succeeded": 1, "successRate": 1 } },
    "requests": 151, "avgRequests": 30.2, "avgDurationMs": 380000,
    "verifiers": [
      { "label": "verifier", "model": "Qwen3.6", "comparable": 4, "correct": 3, "falsePass": 1, "falseFail": 0, "undecided": 0, "accuracy": 0.75, "avgInputTokens": 5000, "avgOutputTokens": 240, "avgLatencyMs": 4000 }
    ]
  }
}
```

- 値のない任意の項目（`stopped`・`failure`・`grader`・`verifier`・`verifierAlt` など）は省略する。率と平均は、分母が0なら `null`
- 文字列（reason・ログ・エラー）はマスクしてから書く。diff の本文は書かない（軌跡を参照する）
- 読み込みは TypeBox で検証し、合わないファイルは比較の相手の検索で警告して飛ばす

## 集計の規則

- `executed` = succeeded＋failed。`successRate` = succeeded ÷ executed（executed=0 なら null）。`error`・`not_run` は含めない
- `avgRequests`・`avgDurationMs` は executed のケースの平均
- 検査役: `comparable` は「判定まで進み、最後の回が判定され、隠しチェックが passed/failed」のケース。正解は隠しチェック（passed → pass が正しい）。`undecided`（判定できない）は分母に入れて不正解として数える。トークン・応答時間は1回の LLM 呼び出しあたりの平均

## 比較の規則

- 相手: `--baseline <file>`、なければ `eval_dir` の中で同じ `setName`・開始時刻が今回より前の最新
- (caseId, attempt) で突き合わせる。両方で executed のものを「共通」とし、成功率・平均リクエスト数・平均処理時間を共通の集合で計算し直して before / after / delta を出す
- 後退 = 前回 succeeded → 今回 failed/error。改善 = 前回 failed/error → 今回 succeeded
- 片方にしかない・not_run は別に列挙する。caseHash が違うケースは「ケースが変わった」と示す
- models・provider・harness.commit の違いを並べる
