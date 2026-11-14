# Specification Quality Checklist: 出荷とレポート（ship-and-report）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- gitleaks・GitHub の auto-merge・`factory.toml` の名前は、憲法（原則 VI）と設計（`03` 5章、`04` 層6）で決まっている前提として書いた（001〜007 の spec と同じ扱い）。ライブラリや API の呼び方は書いていない
- 判断が要る5点（秘密情報で push しない、CI の定義の変更で push しない、`ci_waiting` で Worker を離す、レポートの書き先、Issue を閉じない）は、007 と同じく推奨の回答で決め、Clarifications に書いた。`/speckit-clarify` で見直せる
- 起動時の掃除（007 FR-028）で `ci_waiting` を対象外にする変更（FR-019）は、007 の挙動の変更になる。計画で 007 の仕様・テストとの整合を確かめる
