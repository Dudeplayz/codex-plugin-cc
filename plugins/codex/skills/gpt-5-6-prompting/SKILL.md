---
name: gpt-5-6-prompting
description: Internal guidance for composing and routing Codex GPT-6.1 Sol/GPT-6.1 Terra/GPT-6 Luna prompts for coding, review, diagnosis, and research inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-6.1 Sol/Terra/GPT-6 Luna Prompting

Use this skill only when `codex:codex-rescue` must shape a request or choose GPT-6.1 Sol/Terra/GPT-6 Luna runtime controls before forwarding it. The skill identifier is retained for compatibility; the policy targets current Sol/Terra/Luna models.

Preserve a concrete user request. Tighten it only when a missing success criterion, scope boundary, evidence requirement, output contract, or stopping rule would make Codex guess or stop early.

Prefer outcome-first prompts. State goal, material constraints, required evidence or validation, and completion bar. Use XML blocks only when they make a non-obvious contract clearer; do not add a fixed wrapper to every request.

Keep one coherent task, user-visible scope, required output shape, task-relevant tool routing, and concrete preservation and validation rules for code changes.

Remove generic "be concise", "be thorough", "think step by step", or "think harder" language; repeated rules; irrelevant tools; redundant examples; and permission gates for ordinary in-scope local work.

## Authoritative routing policy

Select runtime controls; never place them in forwarded task text:
- Use `gpt-6.1-sol` as master for complex or quality-first work when it is active Codex configuration. Preserve an explicit model and otherwise respect active model/provider configuration. Use Sol for non-trivial implementation, `gpt-6.1-terra` for the Low-Risk coding task below, browser/screenshot reproduction, and read-only interpretation that outgrows Luna, and Luna only for bounded routine no-source-write workers. Do not automatically route to Astra.
- Use `medium` when cause, scope, and validation are clear. Use `high` when multiple hypotheses, interacting components, or plan plus diagnosis plus validation are required. If effort or scope is unclear, route to Sol at `high`. Use `low` for simple Luna mapping, summaries, or named test commands; use Luna `medium` for harder interpretation and escalate to read-only Terra `medium` instead of Luna `high`; use `xhigh` or `max` only when measured quality needs it.
- Direct Luna stays no-source-write: mapping, supplied logs, or one named test command. Dedicated `test_runner` may use workspace-write for generated build/test artifacts only.
- Terra at `high` with `--write` may own one Low-Risk coding task only when every condition holds: clear expected behavior and acceptance check; one module or a few tightly related files; no auth, permissions, secrets, data loss, migration, public-contract, concurrency, or architecture impact; no independent research/review needed; and relevant verification can run. Terra inspects, changes, and verifies as one writer. If its verification fails or it needs scope beyond the task, rerun on Sol at `high`; do not retry on Terra.
- If any condition is unclear or false, use Sol. Sol owns plans, reviews, UI/product work, architecture, security, root-cause investigation, broad refactors, cross-module changes, and multi-step tasks.
- Use GPT-6 Luna for summaries of supplied material. It is read-only. The legacy `spark` alias maps to GPT-6 Luna and stays read-only.
- Switch on optional MCP servers per task with `--mcp`, never by default: add `--mcp rea` only for reverse-engineering work on shipped artifacts (binaries, bundles, APKs, firmware, packaged apps) and `--mcp playwright` only for browser reproduction. Every enabled server starts for each Codex thread, so leave `--mcp` unset otherwise and preserve an explicit `--mcp` from the user.

For long-running work, keep progress sparse and outcome-based. Define current layer when relevant: research, design, implementation, review, or external coordination.
