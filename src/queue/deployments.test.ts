import { describe, expect, test } from "vitest";
import {
  claimNextDeployment,
  enqueueDeployment,
  finishDeployment,
  interruptRunningDeployments,
  lastSucceededDeployment,
  latestDeployment,
  listDeploymentsForJob,
  updateRunningDeployment,
} from "./deployments.ts";
import { jobs } from "./schema.ts";
import { migratedMemoryDb } from "./testing.ts";

const REPO = "Coxless/factory-sandbox";
const sha = (c: string) => c.repeat(40);
const input = (c: string) => ({
  repo: REPO,
  commitSha: sha(c),
  beforeSha: null,
  imageTag: `app:${sha(c).slice(0, 12)}`,
});

describe("deployments のキュー（010）", () => {
  test("同じ commit の2回目は積まずに既存を返す", () => {
    const { db, close } = migratedMemoryDb();
    const first = enqueueDeployment(db, input("a"), 10);
    const second = enqueueDeployment(db, input("a"), 20);
    expect(first.created).toBe(true);
    expect(second).toEqual({ deployment: first.deployment, created: false });
    expect(first.deployment).toMatchObject({ status: "queued", created_at: 10, before_sha: null });
    close();
  });

  test("最も古い queued から running にし、二度は取らない", () => {
    const { db, close } = migratedMemoryDb();
    enqueueDeployment(db, input("a"), 1);
    enqueueDeployment(db, input("b"), 2);
    const first = claimNextDeployment(db, 5);
    expect(first).toMatchObject({ commit_sha: sha("a"), status: "running", started_at: 5 });
    const second = claimNextDeployment(db, 6);
    expect(second?.commit_sha).toBe(sha("b"));
    expect(claimNextDeployment(db, 7)).toBeUndefined();
    close();
  });

  test("running の行だけを終わらせる", () => {
    const { db, close } = migratedMemoryDb();
    const { deployment } = enqueueDeployment(db, input("a"), 1);
    expect(finishDeployment(db, deployment.id, { status: "succeeded" }, 9)).toBe(false);
    claimNextDeployment(db, 2);
    expect(
      finishDeployment(
        db,
        deployment.id,
        {
          status: "failed",
          stage: "health",
          rolledBack: true,
          rolledBackTo: "app:old",
          rollbackHealthy: true,
          revertPrNumber: 7,
          error: "x".repeat(3000),
        },
        9,
      ),
    ).toBe(true);
    const done = latestDeployment(db, REPO);
    expect(done).toMatchObject({
      status: "failed",
      failed_stage: "health",
      rolled_back: true,
      rolled_back_to: "app:old",
      rollback_healthy: true,
      revert_pr_number: 7,
      finished_at: 9,
    });
    expect(Array.from(done?.error ?? "").length).toBe(2000);
    expect(finishDeployment(db, deployment.id, { status: "succeeded" }, 10)).toBe(false);
    close();
  });

  test("ロールバックしていない失敗は戻し先を書かない", () => {
    const { db, close } = migratedMemoryDb();
    const { deployment } = enqueueDeployment(db, input("a"), 1);
    claimNextDeployment(db, 2);
    finishDeployment(
      db,
      deployment.id,
      { status: "failed", stage: "build", rolledBackTo: "app:old" },
      3,
    );
    expect(latestDeployment(db, REPO)).toMatchObject({
      rolled_back: false,
      rolled_back_to: null,
      rollback_healthy: null,
    });
    close();
  });

  test("直前の成功は exceptId を除いた最新の succeeded", () => {
    const { db, close } = migratedMemoryDb();
    for (const c of ["a", "b", "c"]) {
      const { deployment } = enqueueDeployment(db, input(c), 1);
      claimNextDeployment(db, 2);
      finishDeployment(
        db,
        deployment.id,
        c === "b" ? { status: "failed", stage: "build" } : { status: "succeeded" },
        3,
      );
    }
    const latest = latestDeployment(db, REPO);
    expect(lastSucceededDeployment(db, REPO)?.commit_sha).toBe(sha("c"));
    expect(lastSucceededDeployment(db, REPO, latest?.id)?.commit_sha).toBe(sha("a"));
    expect(lastSucceededDeployment(db, "other/repo")).toBeUndefined();
    close();
  });

  test("起動時: running を interrupted にし、queued は残す", () => {
    const { db, close } = migratedMemoryDb();
    enqueueDeployment(db, input("a"), 1);
    enqueueDeployment(db, input("b"), 2);
    claimNextDeployment(db, 3);
    const interrupted = interruptRunningDeployments(db, 4);
    expect(interrupted.map((d) => [d.commit_sha, d.status, d.failed_stage])).toEqual([
      [sha("a"), "failed", "interrupted"],
    ]);
    expect(claimNextDeployment(db, 5)?.commit_sha).toBe(sha("b"));
    close();
  });

  test("ジョブの結び付けとジョブごとの一覧", () => {
    const { db, close } = migratedMemoryDb();
    const jobId = db
      .insert(jobs)
      .values({
        repo: REPO,
        issue_number: 1,
        trigger_comment_id: 1,
        requested_by: "u",
        instruction: "x",
        created_at: 1,
        updated_at: 1,
      })
      .returning()
      .get().id;
    const { deployment } = enqueueDeployment(db, input("a"), 1);
    updateRunningDeployment(db, deployment.id, { job_id: jobId });
    expect(listDeploymentsForJob(db, jobId)).toEqual([]);
    claimNextDeployment(db, 2);
    updateRunningDeployment(db, deployment.id, { job_id: jobId, error: "link" });
    expect(listDeploymentsForJob(db, jobId).map((d) => [d.id, d.error])).toEqual([
      [deployment.id, "link"],
    ]);
    close();
  });
});
