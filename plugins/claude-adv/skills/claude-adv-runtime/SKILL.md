---
name: claude-adv-runtime
description: Invoke the Claude Adv Codex adapter for setup, foreground review, rescue tasks, and job lookup.
---

# Claude Adv Runtime

Use this skill when Codex needs the Claude Adv adapter command surface.

## Plugin Root Resolution

Resolve `<plugin-root>` in this order:

1. Use user-set `CLAUDE_PLUGIN_ROOT` when it is an absolute path containing `.codex-plugin/plugin.json`.
2. If Codex exposes this `SKILL.md` path, resolve the `SKILL.md` path with `realpath`, then go two directories up from `skills/claude-adv-runtime/SKILL.md` (the plugin root contains `.codex-plugin/plugin.json`).
3. Otherwise fail and show a Known installs hint from the registry contents.

Codex CLI/CI skill-path exposure is not guaranteed; in CI, set `CLAUDE_PLUGIN_ROOT` explicitly.
Registry entries are hints only. Do not auto-resolve plugin root from the registry.

## Commands

```bash
node "<plugin-root>/scripts/claude-adv-codex.mjs" setup --json
node "<plugin-root>/scripts/claude-adv-codex.mjs" review --wait
node "<plugin-root>/scripts/claude-adv-codex.mjs" adversarial-review --wait
node "<plugin-root>/scripts/claude-adv-codex.mjs" status
node "<plugin-root>/scripts/claude-adv-codex.mjs" result <job-id>
node "<plugin-root>/scripts/claude-adv-codex.mjs" cancel <job-id>
node "<plugin-root>/scripts/claude-adv-codex.mjs" task <prompt>
```

Use `result <job-id>` and `cancel <job-id>` with explicit ids in CI.

The Codex layer is foreground-only; review and rescue commands keep the invoking Codex turn occupied until `claude` exits.
