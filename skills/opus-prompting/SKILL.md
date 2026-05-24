---
name: opus-prompting
description: Shape prompts for Claude Opus 4.7 (the claude-adv plugin's default model) when delegating implementation work via rescue
---

# Opus Prompting

Guidance for shaping the rescue prompt before forwarding to `claude-companion.mjs task`. Used only by the `claude-rescue` subagent.

## What Claude Opus 4.7 wants from a rescue prompt

1. **A clear, single primary goal.** Opus is willing to be exhaustive; if you give it two goals it will spread effort across both rather than nail the first. State the highest-value outcome in one sentence.
2. **Context that's already filtered, not raw.** Rescue is a long horizon task; the prompter should pre-filter the codebase pointers (files, line ranges) instead of dumping the whole repo. Opus reads what you give it carefully but won't grep ambitiously.
3. **An explicit done-condition.** "Tests pass" / "the function returns the expected value for these inputs" / "the build completes without warning." Without a done-condition, Opus tends to over-edit.
4. **No premature solution proposals.** If the parent thread already tried a fix and it failed, say what was tried and why it failed, but don't dictate the next attempt. Let Opus form its own diagnosis.

## What to omit

- Verbosity hints like "be concise" — Opus reads tone cues from the prompt structure. A terse, well-bounded prompt yields a terse response.
- `--effort` micromanagement — the default `high` is the right call for rescue. Lower effort risks half-done work; `xhigh` is rarely worth the cost.
- Project-wide CLAUDE.md context — rescue runs with `--bare` and `--setting-sources ""`, so CLAUDE.md and project settings don't reach it. If the rescue needs project conventions, include the relevant excerpt in the prompt body.

## Anatomy of a good rescue prompt

```
The user is debugging <one-line summary>.

Context the parent thread has already established:
- <fact 1>
- <fact 2>

Files in scope:
- <path1>:<line-range>
- <path2>:<line-range>

Already tried (and failed):
- <attempt and observed failure>

Done condition:
- <specific, testable outcome>

Constraints:
- <any "do not touch" lines>
```

## Anti-pattern

Avoid forwarding the user's raw chat-style request as the rescue prompt. The orchestrating Claude has more context than the user typed; package that context into the rescue prompt, do not assume the rescue subprocess can rederive it.
