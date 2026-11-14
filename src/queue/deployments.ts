import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { type Deployment, type DeployStage, deployments } from "./schema.ts";

/** deployments.error の上限（data-model.md 1章） */
const MAX_ERROR_CHARS = 2000;

function clip(text: string | null | undefined): string | null {
  if (text === undefined || text === null) return null;
  const chars = Array.from(text);
  return chars.length <= MAX_ERROR_CHARS
    ? text
    : `${chars.slice(0, MAX_ERROR_CHARS - 1).join("")}…`;
}

export interface NewDeploymentInput {
  repo: string;
  commitSha: string;
  beforeSha: string | null;
  imageTag: string;
}

/**
 * queued で積む（FR-003）。同じ (repo, commit_sha) があれば積まずに既存を返す（配送の重複・再送・同じ commit の再 push に冪等）
 */
export function enqueueDeployment(
  db: Db,
  input: NewDeploymentInput,
  now: number,
): { deployment: Deployment; created: boolean } {
  return db.transaction(
    (tx) => {
      const inserted = tx
        .insert(deployments)
        .values({
          repo: input.repo,
          commit_sha: input.commitSha,
          before_sha: input.beforeSha,
          image_tag: input.imageTag,
          status: "queued",
          created_at: now,
        })
        .onConflictDoNothing({ target: [deployments.repo, deployments.commit_sha] })
        .returning()
        .get();
      if (inserted) return { deployment: inserted, created: true };
      const existing = tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.repo, input.repo), eq(deployments.commit_sha, input.commitSha)))
        .get();
      if (!existing) throw new Error("積んだはずのデプロイが見つかりません");
      return { deployment: existing, created: false };
    },
    { behavior: "immediate" },
  );
}

/** 最も古い queued を running にして返す。選ぶ・書き換えるを1文にするので二重に取らない（research R2） */
export function claimNextDeployment(db: Db, now: number): Deployment | undefined {
  return db.transaction(
    (tx) =>
      tx
        .update(deployments)
        .set({ status: "running", started_at: now })
        .where(
          sql`${deployments.id} = (SELECT ${deployments.id} FROM ${deployments} WHERE ${deployments.status} = 'queued' ORDER BY ${deployments.id} LIMIT 1)`,
        )
        .returning()
        .get(),
    { behavior: "immediate" },
  );
}

/** running の行に書く値（ジョブの結び付けなど、途中で書くもの） */
export function updateRunningDeployment(
  db: Db,
  id: number,
  fields: Partial<Pick<Deployment, "job_id" | "error">>,
): void {
  db.update(deployments)
    .set({
      ...fields,
      ...(fields.error === undefined ? {} : { error: clip(fields.error) }),
    })
    .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
    .run();
}

export type FinishFields =
  | { status: "succeeded"; error?: string | null }
  | {
      status: "failed";
      stage: DeployStage;
      rolledBack?: boolean;
      rolledBackTo?: string | null;
      rollbackHealthy?: boolean | null;
      revertPrNumber?: number | null;
      error?: string | null;
    };

/** running の行だけを終わらせる。変えたら true */
export function finishDeployment(db: Db, id: number, fields: FinishFields, now: number): boolean {
  const values =
    fields.status === "succeeded"
      ? { status: "succeeded" as const, failed_stage: null }
      : {
          status: "failed" as const,
          failed_stage: fields.stage,
          rolled_back: fields.rolledBack ?? false,
          rolled_back_to: fields.rolledBack ? (fields.rolledBackTo ?? null) : null,
          rollback_healthy: fields.rolledBack ? (fields.rollbackHealthy ?? null) : null,
          revert_pr_number: fields.revertPrNumber ?? null,
        };
  return (
    db
      .update(deployments)
      .set({
        ...values,
        ...(fields.error === undefined ? {} : { error: clip(fields.error) }),
        finished_at: now,
      })
      .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
      .run().changes === 1
  );
}

export function getDeployment(db: Db, id: number): Deployment | undefined {
  return db.select().from(deployments).where(eq(deployments.id, id)).get();
}

/** 同じリポジトリの succeeded のうち最も新しいもの（exceptId を除く。research R7 の戻し先） */
export function lastSucceededDeployment(
  db: Db,
  repo: string,
  exceptId?: number,
): Deployment | undefined {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.repo, repo),
        eq(deployments.status, "succeeded"),
        ...(exceptId === undefined ? [] : [ne(deployments.id, exceptId)]),
      ),
    )
    .orderBy(desc(deployments.id))
    .get();
}

/** 同じリポジトリの最も新しい記録（状態を問わない。起動時の取り直しの before） */
export function latestDeployment(db: Db, repo: string): Deployment | undefined {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.repo, repo))
    .orderBy(desc(deployments.id))
    .get();
}

/** 同じリポジトリの succeeded（新しい順） */
export function listSucceededDeployments(db: Db, repo: string): Deployment[] {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.repo, repo), eq(deployments.status, "succeeded")))
    .orderBy(desc(deployments.id))
    .all();
}

/** 同じリポジトリのすべての記録（新しい順。イメージの片付け） */
export function listDeployments(db: Db, repo: string): Deployment[] {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.repo, repo))
    .orderBy(desc(deployments.id))
    .all();
}

/** 起動時: running を failed（interrupted）にして、その行を返す（research R9） */
export function interruptRunningDeployments(db: Db, now: number): Deployment[] {
  return db
    .update(deployments)
    .set({
      status: "failed",
      failed_stage: "interrupted",
      error: "前回の起動でデプロイの途中のまま止まりました",
      finished_at: now,
    })
    .where(eq(deployments.status, "running"))
    .returning()
    .all();
}

/** ジョブに結び付いたデプロイ（古い順。PR の本文のデプロイの欄） */
export function listDeploymentsForJob(db: Db, jobId: number): Deployment[] {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.job_id, jobId))
    .orderBy(deployments.id)
    .all();
}
