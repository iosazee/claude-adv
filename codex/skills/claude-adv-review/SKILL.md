---
name: claude-adv-review
description: Run Claude-powered foreground review from Codex through Claude Adv.
---

# Claude Adv Review

Use this skill when Codex should ask Claude for an isolated review of the current work.

## Plugin Root Resolution

Resolve `<plugin-root>` in this order:

1. Use user-set `CLAUDE_PLUGIN_ROOT` when it is an absolute path containing `.codex-plugin/plugin.json`.
2. If Codex exposes this `SKILL.md` path, resolve the `SKILL.md` path with `realpath`, then go three directories up from `codex/skills/claude-adv-review/SKILL.md`.
3. Otherwise fail and show a Known installs hint from the registry contents.

Codex CLI/CI skill-path exposure is not guaranteed; in CI, set `CLAUDE_PLUGIN_ROOT` explicitly.
Registry entries are hints only. Do not auto-resolve plugin root from the registry.

## Review

Run a neutral foreground review:

```bash
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" review --wait
```

Run a skeptical foreground review:

```bash
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" adversarial-review --wait
```

Pass `--scope working-tree` when the repository has no default branch yet.

The Codex layer is foreground-only; return the adapter output after the review exits.
