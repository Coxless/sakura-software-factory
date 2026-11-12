PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`phase` text NOT NULL,
	`attempt` integer NOT NULL,
	`model` text NOT NULL,
	`outcome` text,
	`turns` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`blocked_calls` integer DEFAULT 0 NOT NULL,
	`compactions` integer DEFAULT 0 NOT NULL,
	`steers` integer DEFAULT 0 NOT NULL,
	`error` text,
	`verdict` text,
	`trace_path` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_runs_outcome_check" CHECK("__new_agent_runs"."outcome" IN ('completed', 'max_turns', 'timeout', 'budget_exceeded', 'blocked_repeatedly', 'aborted', 'failed')),
	CONSTRAINT "agent_runs_attempt_check" CHECK("__new_agent_runs"."attempt" >= 1),
	CONSTRAINT "agent_runs_verdict_check" CHECK("__new_agent_runs"."verdict" IN ('pass', 'fail'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_runs`("id", "job_id", "phase", "attempt", "model", "outcome", "turns", "requests", "tool_calls", "blocked_calls", "compactions", "steers", "error", "verdict", "trace_path", "started_at", "finished_at") SELECT "id", "job_id", "phase", "attempt", "model", "outcome", "turns", "requests", "tool_calls", "blocked_calls", "compactions", "steers", "error", NULL, "trace_path", "started_at", "finished_at" FROM `agent_runs`;--> statement-breakpoint
DROP TABLE `agent_runs`;--> statement-breakpoint
ALTER TABLE `__new_agent_runs` RENAME TO `agent_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_job_phase_attempt_unique` ON `agent_runs` (`job_id`,`phase`,`attempt`);