---
description: Run a Claude review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--json] [--continue <prior.json>] [--max-inline-bytes <n>] [--max-inline-file-bytes <n>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Claude review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Claude's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/claude-adv:adversarial-review` uses the same review target selection as `/claude-adv:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/claude-adv:review`, it can still take extra focus text after the flags.
- `--max-inline-bytes <n>` and `--max-inline-file-bytes <n>` raise the inline-diff caps (defaults 262144 and 65536, in bytes). Use these to inline a larger feature-branch diff that would otherwise drop to self-collect mode (which produces a paper-approve safeguard verdict). Past ~1 MiB the model's attention degrades even when the diff fits numerically — prefer narrowing `--base` or per-commit reviews for branches above that size.
- `--json` returns the structured payload (verdict, findings, per-finding `fingerprint`) on stdout instead of the rendered text review. Use it for round 1 of an iterate-to-approval loop so the payload can be saved and fed back via `--continue`.
- `--continue <prior.json>` re-reviews with a previous run's JSON payload as context: the runtime injects the prior findings as a `<previously_addressed>` block, verifies resolution against the current diff, and — when the verdict lands on `approve`/`approve-with-notes` — automatically runs a fresh unbiased verification pass whose verdict is authoritative. It is iterable: repeat until clean, continuing from the immediately-prior run's JSON each round (round 3 from round 2's file, not round 1's); there is no live session to resume. Combined with `--json`, the payload's top-level `review_output` is that authoritative verdict, with the biased pass under `continueAttempt` and `finalVerification.triggered` true; on a `needs-attention` continuation no verification runs (`finalVerification.triggered` false, `continueAttempt` null) and `review_output` is that blocking verdict directly. It expects a `--json` payload (not a saved rendered review); a missing or non-JSON file degrades to a first-pass review rather than erroring. The payload signals this machine-readably via `continueRequested` and `continueDegraded` (+ `continueDegradeReason`: `unreadable` | `invalid-json` | `not-a-review`), so an automated loop can detect that a verdict is not a verified re-review. `schemas/review-output.schema.json` governs only the `review_output` object; these continuation fields and the rest of the envelope are documented in `docs/HOW-TO.md` §12.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Claude adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Claude adversarial review started in the background. Check `/claude-adv:status` for progress."
