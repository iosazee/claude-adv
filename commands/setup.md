---
description: Check whether the local Claude CLI is ready and optionally toggle the stop-time review gate or adjust budget caps
argument-hint: '[--enable-review-gate|--disable-review-gate] [--set-budget-usd <N>] [--set-rescue-budget-usd <N>] [--set-worker-budget-multiplier <N>]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" setup --json "$ARGUMENTS"
```

If the result says Claude is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install the Claude CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Claude (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @anthropic-ai/claude-code
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" setup --json "$ARGUMENTS"
```

If Claude is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Claude is installed but not authenticated, preserve the guidance to run `!claude /login`.
