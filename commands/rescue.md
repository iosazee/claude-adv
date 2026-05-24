---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Claude rescue subagent
argument-hint: "[--background|--wait] [--model <model|spark>] [--effort <low|medium|high|xhigh|max>] [--prompt-file <path>] [what Claude should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `claude-adv:claude-rescue` subagent via the `Agent` tool (`subagent_type: "claude-adv:claude-rescue"`), forwarding the raw user request as the prompt.
`claude-adv:claude-rescue` is a subagent, not a skill — do not call `Skill(claude-adv:claude-rescue)` (no such skill) or `Skill(claude-adv:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Claude's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `claude-adv:claude-rescue` subagent in the background.
- If the request includes `--wait`, run the `claude-adv:claude-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--prompt-file <path>` is a task-input flag. Preserve it for the forwarded `task` call, but do not treat either token as part of the natural-language task text.

Operating rules:

- Each rescue invocation spawns a fresh `claude` subprocess. Sessions are not persisted (`--no-session-persistence` is locked in `buildRescueArgs`), so there is no resumable thread to continue. Always route the user's request as a new rescue.
- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" task ...` with the preserved runtime/input flags and return that command's stdout as-is.
- Return the Claude companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/claude-adv:status`, fetch `/claude-adv:result`, call `/claude-adv:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `claude-haiku-4-5`.
- If the user supplies `--prompt-file <path>`, pass it through to `task --prompt-file <path>` instead of copying the file content into the prompt.
- If Claude is missing or unauthenticated, stop and tell the user to run `/claude-adv:setup`.
- If the user did not supply a request, ask what Claude should investigate or fix.
