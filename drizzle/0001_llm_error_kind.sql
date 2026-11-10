PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_llm_calls` (
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
	`error_kind` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "llm_calls_role_check" CHECK("__new_llm_calls"."role" IN ('planner', 'implementer', 'verifier')),
	CONSTRAINT "llm_calls_status_check" CHECK("__new_llm_calls"."status" IN ('ok', 'error')),
	CONSTRAINT "llm_calls_error_kind_check" CHECK("__new_llm_calls"."error_kind" IN ('transient', 'permanent', 'timeout', 'aborted')),
	CONSTRAINT "llm_calls_error_kind_status_check" CHECK(("__new_llm_calls"."status" = 'ok') = ("__new_llm_calls"."error_kind" IS NULL)),
	CONSTRAINT "llm_calls_attempt_check" CHECK("__new_llm_calls"."attempt" >= 1),
	CONSTRAINT "llm_calls_latency_check" CHECK("__new_llm_calls"."latency_ms" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_llm_calls`("id", "job_id", "phase", "role", "model", "attempt", "input_tokens", "output_tokens", "latency_ms", "status", "error_kind", "error", "created_at") SELECT "id", "job_id", "phase", "role", "model", "attempt", "input_tokens", "output_tokens", "latency_ms", "status", CASE WHEN "status" = 'ok' THEN NULL ELSE 'permanent' END, "error", "created_at" FROM `llm_calls`;--> statement-breakpoint
DROP TABLE `llm_calls`;--> statement-breakpoint
ALTER TABLE `__new_llm_calls` RENAME TO `llm_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `llm_calls_created_at_idx` ON `llm_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `llm_calls_job_id_idx` ON `llm_calls` (`job_id`);