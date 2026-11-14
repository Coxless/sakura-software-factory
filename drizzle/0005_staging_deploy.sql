-- 010: drizzle-kit generate は、元の deployments にない列（repo など）を二重引用符で SELECT していた
-- （SQLite は解決できない二重引用符の識別子を文字列として扱い、'repo' という値が入る）。
-- 元の表にある列だけを写すように手で書き直した（docs/journal/2026-11-14-010-staging-deploy-実装.md）。
-- 001〜009 では deployments に行を書いていないので、写す行は通常ない
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`job_id` integer,
	`commit_sha` text NOT NULL,
	`before_sha` text,
	`image_tag` text NOT NULL,
	`status` text NOT NULL,
	`failed_stage` text,
	`rolled_back` integer DEFAULT false NOT NULL,
	`rolled_back_to` text,
	`rollback_healthy` integer,
	`revert_pr_number` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deployments_status_check" CHECK("__new_deployments"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "deployments_failed_stage_check" CHECK("__new_deployments"."failed_stage" IN ('fetch', 'build', 'release', 'health', 'interrupted')),
	CONSTRAINT "deployments_failed_stage_status_check" CHECK(("__new_deployments"."status" = 'failed') = ("__new_deployments"."failed_stage" IS NOT NULL)),
	CONSTRAINT "deployments_rollback_check" CHECK("__new_deployments"."rolled_back" = 1 OR ("__new_deployments"."rolled_back_to" IS NULL AND "__new_deployments"."rollback_healthy" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_deployments`(`id`, `repo`, `job_id`, `commit_sha`, `image_tag`, `status`, `failed_stage`, `rolled_back`, `rolled_back_to`, `created_at`, `finished_at`) SELECT `id`, '', `job_id`, `commit_sha`, `image_tag`, `status`, CASE WHEN `status` = 'failed' THEN 'interrupted' END, `rolled_back`, CASE WHEN `rolled_back` = 1 THEN `rolled_back_to` END, `created_at`, `finished_at` FROM `deployments`;--> statement-breakpoint
DROP TABLE `deployments`;--> statement-breakpoint
ALTER TABLE `__new_deployments` RENAME TO `deployments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `deployments_status_id_idx` ON `deployments` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `deployments_job_id_idx` ON `deployments` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_repo_commit_unique` ON `deployments` (`repo`,`commit_sha`);