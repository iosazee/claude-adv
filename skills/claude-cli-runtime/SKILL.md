---
name: claude-cli-runtime
description: Internal helper contract for calling the claude-companion runtime from Claude Code subagents and slash commands
---

# Claude CLI Runtime

This skill describes how to invoke `claude-companion.mjs` correctly.

## Entry point

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" <subcommand> [args...]
```

The companion script dispatches to per-subcommand handlers and writes results to stdout.

## Subcommands

- `setup [--enable-review-gate|--disable-review-gate] [--set-budget-usd <N>] [--set-rescue-budget-usd <N>] [--set-worker-budget-multiplier <N>] [--json]` — auth check, config toggles, budget caps.
- `review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json]` — neutral review.
- `adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--json] [focus text]` — skeptical review.
- `task [--background] [--model <model>] [--effort <low|medium|high|xhigh|max>] [prompt]` — write-capable rescue. Each call spawns a fresh `claude` subprocess; sessions are not persisted, so there are no `--resume`/`--fresh` flags.
- `status [job-id] [--all] [--json]` — list jobs or inspect one.
- `result [job-id] [--json]` — fetch a stored job result.
- `cancel [job-id] [--json]` — cancel a running job.

## Argument conventions

- All subcommands accept `--json` for machine-readable output.
- `--wait` runs in the foreground; `--background` detaches; default is to ask via `AskUserQuestion` (handled by the slash command, not the runtime).
- `--cwd <path>` overrides the working directory for state and git ops.

## When to invoke from a subagent

- For review-class work (`review`, `adversarial-review`), prefer letting the user invoke the slash command directly. Subagents should not auto-fire reviews.
- For rescue-class work (`task`), the `claude-rescue` subagent is the only authorized caller. Other subagents should not invoke `task`.

## Output discipline

Return the runtime's stdout verbatim. Do not paraphrase, summarize, or annotate the JSON output.
