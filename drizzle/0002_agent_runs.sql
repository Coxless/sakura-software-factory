CREATE TABLE `agent_runs` (
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
	`trace_path` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_runs_outcome_check" CHECK("agent_runs"."outcome" IN ('completed', 'max_turns', 'timeout', 'budget_exceeded', 'blocked_repeatedly', 'aborted', 'failed')),
	CONSTRAINT "agent_runs_attempt_check" CHECK("agent_runs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_job_phase_attempt_unique` ON `agent_runs` (`job_id`,`phase`,`attempt`);