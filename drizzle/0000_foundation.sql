CREATE TABLE `budget` (
	`month` text PRIMARY KEY NOT NULL,
	`monthly_limit` integer NOT NULL,
	`intake_stopped_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "budget_monthly_limit_check" CHECK("budget"."monthly_limit" >= 1)
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`commit_sha` text NOT NULL,
	`image_tag` text NOT NULL,
	`status` text NOT NULL,
	`rolled_back` integer DEFAULT false NOT NULL,
	`rolled_back_to` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deployments_status_check" CHECK("deployments"."status" IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `deployments_status_created_at_idx` ON `deployments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_events_type_check" CHECK("job_events"."type" IN ('state_changed', 'note', 'error'))
);
--> statement-breakpoint
CREATE INDEX `job_events_job_id_id_idx` ON `job_events` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`issue_number` integer NOT NULL,
	`trigger_comment_id` integer NOT NULL,
	`requested_by` text NOT NULL,
	`instruction` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`judge_retries` integer DEFAULT 0 NOT NULL,
	`ci_retries` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`pr_number` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" IN ('queued', 'planning', 'implementing', 'testing', 'judging', 'pr_opened', 'ci_waiting', 'merged', 'deploying', 'deployed', 'rolled_back', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_created_at_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_repo_trigger_comment_unique` ON `jobs` (`repo`,`trigger_comment_id`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`phase` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`attempt` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "llm_calls_role_check" CHECK("llm_calls"."role" IN ('planner', 'implementer', 'verifier')),
	CONSTRAINT "llm_calls_status_check" CHECK("llm_calls"."status" IN ('ok', 'error')),
	CONSTRAINT "llm_calls_attempt_check" CHECK("llm_calls"."attempt" >= 1),
	CONSTRAINT "llm_calls_latency_check" CHECK("llm_calls"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `llm_calls_created_at_idx` ON `llm_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `llm_calls_job_id_idx` ON `llm_calls` (`job_id`);