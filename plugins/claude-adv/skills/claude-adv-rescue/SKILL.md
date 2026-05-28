---
name: claude-adv-rescue
description: Ask Claude Adv to run a write-capable Claude rescue task from Codex.
---

# Claude Adv Rescue

Use this skill when Codex needs Claude to attempt a bounded write-capable repair.

## Plugin Root Resolution

Resolve `<plugin-root>` in this order:

1. Use user-set `CLAUDE_PLUGIN_ROOT` when it is an absolute path containing `.codex-plugin/plugin.json`.
2. If Codex exposes this `SKILL.md` path, resolve the `SKILL.md` path with `realpath`, then go two directories up from `skills/claude-adv-rescue/SKILL.md` (the plugin root contains `.codex-plugin/plugin.json`).
3. Otherwise fail and show a Known installs hint from the registry contents.

Codex CLI/CI skill-path exposure is not guaranteed; in CI, set `CLAUDE_PLUGIN_ROOT` explicitly.
Registry entries are hints only. Do not auto-resolve plugin root from the registry.

## Rescue

Package the goal, relevant files, failed attempts, and done condition into one prompt, then invoke:

```bash
node "<plugin-root>/scripts/claude-adv-codex.mjs" task <prompt>
```

Keep the prompt focused on one primary repair.

The Codex layer is foreground-only; the Codex turn stays occupied until the rescue task exits.
