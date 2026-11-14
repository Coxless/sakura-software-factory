-- 009: drizzle-kit generate はテーブルを作り直す SQL を出したが、元の jobs にない列を "base_sha" のように
-- 二重引用符で SELECT していた（SQLite は解決できない二重引用符の識別子を文字列として扱う）。
-- 既存の行を残すため、列の追加だけに手で書き直した（docs/journal/2026-11-14-009-ci-feedback-実装.md）
ALTER TABLE `jobs` ADD `base_sha` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `head_sha` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ci_status` text CONSTRAINT "jobs_ci_status_check" CHECK("ci_status" IN ('pending', 'passed', 'failed'));--> statement-breakpoint
ALTER TABLE `jobs` ADD `ci_deadline` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `ci_event_at` integer;--> statement-breakpoint
CREATE INDEX `jobs_status_ci_status_idx` ON `jobs` (`status`,`ci_status`);
