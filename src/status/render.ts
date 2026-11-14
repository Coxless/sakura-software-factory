import { createHash } from "node:crypto";
import { html } from "hono/html";
import type { BreakdownItem, Rate, StatusSnapshot } from "./schema.ts";

/**
 * 状況ページの HTML（011 contracts/http-status.md）。
 * 値は hono/html の html タグで埋め込み、自動でエスケープする（raw は使わない）。
 * スクリプト・外部の読み込みはなく、CSS はこの1つの <style> だけ（CSP にハッシュを入れる）
 */
const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #ffffff; --line: #d2d2d7; --card: #f5f5f7; --warn: #b25000; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #161617; --line: #3a3a3c; --card: #232325; --warn: #ff9f0a; } }
body { margin: 0; padding: 16px; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 28px 0 8px; }
.meta, .note { color: var(--muted); font-size: 12px; }
.warn { color: var(--warn); font-weight: 600; margin: 12px 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
.card { background: var(--card); border-radius: 8px; padding: 12px; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
td.num { text-align: right; }
`;

/** CSP の style-src に入れる、<style> の中身の SHA-256 */
export function styleHash(): string {
  return `sha256-${createHash("sha256").update(STYLE).digest("base64")}`;
}

export function formatRate(rate: Rate): string {
  if (rate.ratio === null) return "データなし";
  return `${(rate.ratio * 100).toFixed(1)}%（${rate.numerator}/${rate.denominator}）`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function formatTime(epochMs: number | null, timeZone: string): string {
  if (epochMs === null) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(epochMs);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const dash = (value: string | number | null) => (value === null ? "—" : value);

function breakdownTable(title: string, items: BreakdownItem[]) {
  return html`<div class="card">
    <div class="label">${title}</div>
    ${
      items.length === 0
        ? html`<div class="note">なし</div>`
        : html`<table>
            ${items.map((item) => html`<tr><td>${item.key}</td><td class="num">${item.count}</td></tr>`)}
          </table>`
    }
  </div>`;
}

function card(label: string, value: string, sub: string) {
  return html`<div class="card">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
    <div class="note">${sub}</div>
  </div>`;
}

export async function renderStatusHtml(s: StatusSnapshot): Promise<string> {
  const tz = s.month.time_zone;
  const t = (ms: number | null) => formatTime(ms, tz);
  const c = s.consumption;
  const d = s.jobs.duration_ms;

  const page = html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Factory Status</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>ソフトウェアファクトリーの状況</h1>
<div class="meta">${s.month.key}（${tz}）・計算した時刻 ${t(s.generated_at)}</div>
${
  c.intake_stopped_at === null
    ? ""
    : html`<div class="warn">予算で新しいジョブの受付を止めています（${t(c.intake_stopped_at)}）</div>`
}

<section class="cards">
  ${card("今月の消費", `${c.requests} / ${c.monthly_limit}`, `残り ${c.remaining} リクエスト`)}
  ${card("成功率", formatRate(s.jobs.success), "今月終わったジョブのうちステージングまで反映")}
  ${card(
    "平均処理時間",
    formatDuration(d.mean),
    `中央値 ${formatDuration(d.median)}（${d.count} 件）・実行中 ${s.jobs.in_progress} 件`,
  )}
  ${card("CI 初回通過率", formatRate(s.ci.first_pass), "1回目の CI で通ったジョブ")}
  ${card(
    "デプロイ成功率",
    formatRate(s.deployments.success),
    `ロールバック ${s.deployments.rolled_back} 件`,
  )}
</section>
<p class="note">処理時間は開始から終わりまで。Draft PR は人間がマージするまで待つので長くなる。</p>

<h2>消費の内訳</h2>
<section class="cards">
  ${breakdownTable("役割", c.by_role)}
  ${breakdownTable("モデル", c.by_model)}
  ${breakdownTable("失敗の種類", c.errors_by_kind)}
  <div class="card">
    <div class="label">ジョブ／ジョブ以外・トークン</div>
    <table>
      <tr><td>ジョブ</td><td class="num">${c.job_requests}</td></tr>
      <tr><td>ジョブ以外（評価など）</td><td class="num">${c.non_job_requests}</td></tr>
      <tr><td>入力トークン</td><td class="num">${c.input_tokens}</td></tr>
      <tr><td>出力トークン</td><td class="num">${c.output_tokens}</td></tr>
    </table>
  </div>
</section>

<h2>今月終わったジョブ</h2>
<section class="cards">
  ${breakdownTable("状態", s.jobs.by_status)}
  ${breakdownTable("失敗の理由", s.jobs.failures_by_reason)}
</section>

<h2>最近のジョブ</h2>
<div class="scroll"><table>
  <tr><th>#</th><th>リポジトリ</th><th>Issue</th><th>PR</th><th>状態</th><th>失敗の理由</th><th>作成</th><th>所要時間</th><th>リクエスト</th></tr>
  ${s.recent.jobs.map(
    (j) => html`<tr>
      <td class="num">${j.id}</td><td>${j.repo}</td><td class="num">#${j.issue_number}</td>
      <td class="num">${j.pr_number === null ? "—" : `#${j.pr_number}`}</td>
      <td>${j.status}</td><td>${dash(j.failure_kind)}</td><td>${t(j.created_at)}</td>
      <td>${formatDuration(j.duration_ms)}</td><td class="num">${j.requests}</td>
    </tr>`,
  )}
</table></div>

<h2>最近の工程の実行</h2>
<div class="scroll"><table>
  <tr><th>ジョブ</th><th>工程</th><th>回</th><th>モデル</th><th>終わり方</th><th>判定</th><th>ターン</th><th>リクエスト</th><th>ツール</th><th>拒否</th><th>圧縮</th><th>開始</th><th>所要時間</th></tr>
  ${s.recent.runs.map(
    (r) => html`<tr>
      <td class="num">${r.job_id}</td><td>${r.phase}</td><td class="num">${r.attempt}</td>
      <td>${r.model}</td><td>${r.outcome ?? "実行中"}</td><td>${dash(r.verdict)}</td>
      <td class="num">${r.turns}</td><td class="num">${r.requests}</td>
      <td class="num">${r.tool_calls}</td><td class="num">${r.blocked_calls}</td>
      <td class="num">${r.compactions}</td><td>${t(r.started_at)}</td>
      <td>${formatDuration(r.duration_ms)}</td>
    </tr>`,
  )}
</table></div>

<h2>最近のデプロイ</h2>
<div class="scroll"><table>
  <tr><th>#</th><th>リポジトリ</th><th>ジョブ</th><th>commit</th><th>状態</th><th>失敗した段階</th><th>ロールバック</th><th>revert PR</th><th>作成</th><th>所要時間</th></tr>
  ${s.recent.deployments.map(
    (x) => html`<tr>
      <td class="num">${x.id}</td><td>${x.repo}</td><td class="num">${dash(x.job_id)}</td>
      <td><code>${x.commit}</code></td><td>${x.status}</td><td>${dash(x.failed_stage)}</td>
      <td>${x.rolled_back ? "あり" : "—"}</td>
      <td class="num">${x.revert_pr_number === null ? "—" : `#${x.revert_pr_number}`}</td>
      <td>${t(x.created_at)}</td><td>${formatDuration(x.duration_ms)}</td>
    </tr>`,
  )}
</table></div>
</main>
</body>
</html>`;
  return String(await page);
}
