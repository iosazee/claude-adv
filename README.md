# claude-adv

> A second-opinion Claude inside your Claude Code session.
> Independent of the main thread, isolated from your project's settings and hooks,
> built to break confidence in your work — not validate it.

`claude-adv` runs an **adversarial reviewer** and a **write-capable rescue** out of your Claude Code session via slash commands. The reviewer is epistemically isolated from the implementing Claude: it spawns a fresh `claude` subprocess per review with locked argv invariants (`--tools ""`, `--no-session-persistence`, `--setting-sources ""`, plus `--bare` on API-key auth), so prompt injection in one turn cannot bias the next. The rescue path keeps the same isolation guarantees but grants edit permissions so a fresh Claude can do focused work on your behalf.

It also includes a Codex plugin layer under `.codex-plugin/` and `codex/`: Codex skills call the same runtime through a small adapter that maps Codex environment into the existing Claude-oriented state and subprocess model.

A Claude-flavored port of [OpenAI's `codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).

---

## What you get

| Command                          | What it does                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/claude-adv:adversarial-review` | Skeptical review focused on design choices and failure modes, not just defects. Default model: Claude Opus 4.7. |
| `/claude-adv:review`             | Neutral counterpart for routine reviews.                                                                        |
| `/claude-adv:rescue`             | Hand a substantial task to a fresh, write-capable Claude. Default model: Opus 4.7 at `--effort high`.           |
| `/claude-adv:setup`              | Auth check, configure review-gate toggle, set per-review budget cap.                                            |
| `/claude-adv:status [job-id]`    | List background jobs or inspect one.                                                                            |
| `/claude-adv:result <job-id>`    | Show the stored output of a completed job.                                                                      |
| `/claude-adv:cancel <job-id>`    | Cancel a running review or rescue.                                                                              |

Plus an **optional Stop-time review gate** — a hook that auto-fires an adversarial review at every turn boundary and blocks the main thread from finishing on broken work. Turn it on with `/claude-adv:setup --enable-review-gate`.

## Three ways to run it

1. **Interactively in Claude Code** — the slash commands above. Review your working tree or a branch diff, or hand a stuck task to a write-capable rescue Claude. This is the primary surface.
2. **Autonomously or from scripts** — enable the [Stop-time gate](docs/HOW-TO.md#6-use-the-stop-time-review-gate) to auto-review at every turn boundary, run [iterate-to-approve](#iterate-to-approve) loops, or drive any command with `--json` for machine-readable verdicts (see [For agents and scripting](#for-agents-and-scripting)). Other agents can invoke rescue as a subagent.
3. **From Codex** — a [`.codex-plugin/`](#codex-install) layer exposes the same runtime to Codex (foreground-first) and to CI gates via API-key auth (see [`docs/HOW-TO.md` §11](docs/HOW-TO.md#11-switch-between-auth-modes)).

Auth (subscription / API key / Bedrock·Vertex·Foundry) is auto-detected on every run — see [Cost model](#cost-model).

## Why it exists

When Claude reviews Claude's own work in the same conversation, two failure modes show up:

1. **Sycophancy by familiarity.** Same model, same context, same recent history → "looks good, here are minor suggestions."
2. **Prompt-injection persistence.** Untrusted text in a diff can poison the conversation state and bias later reviews.

`claude-adv` rules both out by structurally separating the reviewer from the implementer:

- **Different process**, not a sub-call. The reviewer is a separate `claude` subprocess, so it shares no in-memory state with the parent.
- **No history.** `--no-session-persistence` means the review session is never persisted; no resume, no carryover.
- **No settings.** `--setting-sources ""` blocks project hooks and settings on every path. On API-key auth, `--bare` additionally strips plugin sync, CLAUDE.md auto-discovery, and credential-store reads; on subscription auth those are bounded instead by the locked tool-less prompt and a controlled temp working directory (see [auth modes](docs/HOW-TO.md#11-switch-between-auth-modes)).
- **No tools.** `--tools ""` is a hard CLI-level gate. Even if the reviewer's prompt is jailbroken, it has no way to write files or run commands.
- **Fresh subprocess per review.** A persistent Node supervisor pre-binds a Unix socket for low-latency hook firing, but it spawns a brand-new `claude` for every review request. Diff content in one review cannot influence the next.

Each invariant is locked at the argv builder (`buildReviewerArgs`, `buildRescueArgs`) and asserted in golden-argv tests. Each is also verified end-to-end against real `claude`: prompt-injection persistence, `--tools ""` jailbreak resistance, and a malicious `.claude/settings.json` fixture all have adversarial integration tests.

## Quick start

> New here? [Install the plugin](#install) first.

```bash
# 1. Confirm the plugin is wired up and your claude CLI is authenticated
/claude-adv:setup

# 2. Adversarial review of your uncommitted changes, in the foreground
/claude-adv:adversarial-review --wait

# 3. Focus the reviewer on one concern (any text after the flags is the focus)
/claude-adv:adversarial-review --wait the new retry logic in queue.ts

# 4. Hand a stuck task to a fresh, write-capable Claude
/claude-adv:rescue fix the failing tests in test/queue.spec.ts — do NOT change the tests

# 5. Turn on the automatic Stop-time gate (re-reviews at every turn boundary)
/claude-adv:setup --enable-review-gate
```

That's the whole surface for everyday use. The sections below are the full reference; for background jobs, budgets, auth modes, and troubleshooting see [`docs/HOW-TO.md`](docs/HOW-TO.md).

## Commands and flags

The review/status/result/cancel command files are marked **explicit-invocation only** (`disable-model-invocation: true`). `setup` and `rescue` stay normally invokable because setup is the readiness entrypoint and rescue is also reachable as a subagent, but the intended surface is still deliberate: you invoke commands, or a supervising agent runs them as Bash/slash calls.

| Command                                   | Flags                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/claude-adv:adversarial-review [focus…]` | `--wait` \| `--background` · `--base <ref>` · `--scope auto\|working-tree\|branch` · `--continue <prior.json>` · `--json` · `--model <m>` · `--max-inline-bytes <n>` · `--max-inline-file-bytes <n>` |
| `/claude-adv:review`                      | same as above (no trailing focus text)                                                                                                                                                               |
| `/claude-adv:rescue [task…]`              | `--background` (foreground is the default) · `--model <m>` · `--effort <level>` · `--prompt-file <path>` · `--json`                                                                                  |
| `/claude-adv:setup`                       | `--json` · `--enable-review-gate` \| `--disable-review-gate` · `--set-budget-usd <n>` · `--set-rescue-budget-usd <n>` · `--set-worker-budget-multiplier <n>`                                         |
| `/claude-adv:status [job-id]`             | `--wait` · `--timeout-ms <ms>` · `--all`                                                                                                                                                             |
| `/claude-adv:result <job-id>`             | —                                                                                                                                                                                                    |
| `/claude-adv:cancel <job-id>`             | —                                                                                                                                                                                                    |

- **Scope.** `--scope auto` (default) reviews the working tree if dirty, else the branch diff against its merge-base. `--base <ref>` sets the comparison point for `--scope branch`.
- **`--model`** takes a full id (`claude-opus-4-7`) or any alias the `claude` CLI resolves (`opus`, `sonnet`, `haiku`). Reviewer default: `claude-opus-4-7`.
- **`--effort`** (rescue only) is passed straight through to the inner `claude`; rescue defaults to `high`.
- **`--max-inline-*`** raise the diff size the reviewer can see inline before it drops to a names-only fallback — see [`docs/HOW-TO.md`](docs/HOW-TO.md#5-review-a-large-feature-branch-raise-the-inline-diff-caps).

## For agents and scripting

All commands emit machine-readable output with `--json`.

**Review (`--json`)** writes one JSON object to stdout. The verdict lives in the payload, not the exit code:

```jsonc
{
  "review_output": {
    "verdict": "approve" | "approve-with-notes" | "needs-attention",
    "summary": "one-paragraph rationale",
    "findings": [
      {
        "severity": "critical" | "high" | "medium" | "low",
        "confidence": 0.0,            // 0–1
        "title": "...", "body": "...",
        "file": "src/queue.ts", "line_start": 42, "line_end": 49,
        "recommendation": "...",
        "fingerprint": "a1b2c3d4e5f60718"   // stable across iterations
      }
    ],
    "next_steps": ["..."]
  },
  "continueAttempt":   null,   // populated only on --continue runs (the biased pass)
  "finalVerification": { "triggered": false }   // the unbiased pass; see Iterate-to-approve
}
```

`fingerprint` is `sha1(file:line_start:title)[:16]`, so an agent can diff finding sets across `--continue` passes to see what was resolved.

**Rescue (`--json`)** writes `{ sessionId, ok, exitCode, costUsd, rawOutput, error, stderr }` — `rawOutput` is the rescue Claude's verbatim report.

**Background** (`--background`) returns `{ jobId, status, title }` immediately. Poll with `/claude-adv:status <job-id> --wait` and read the result with `/claude-adv:result <job-id>`.

**Exit codes**

| Context                       | Code | Meaning                                                      |
| ----------------------------- | ---- | ------------------------------------------------------------ |
| Slash command (review/rescue) | `0`  | Ran successfully — inspect `verdict` in the payload          |
| Slash command                 | `1`  | The inner `claude` failed (auth, budget, crash)              |
| Stop-time gate hook           | `2`  | **Block** — an explicit `needs-attention` verdict            |
| Stop-time gate hook           | `0`  | Pass, no change, or any internal error (the gate fails open) |

**Delegating from another agent.** `/claude-adv:rescue` forwards to the `claude-adv:claude-rescue` subagent — invoke it via the `Agent` tool with `subagent_type: "claude-adv:claude-rescue"`, not as a skill. The reviewer commands are not model-invocable; a supervising agent runs them as shell/slash calls and parses the JSON.

## Iterate-to-approve

The default workflow is one-shot: you submit a diff, the reviewer returns a verdict with findings, you triage them, you ship. That's how the plugin was designed — a tough single critic, calibrated to find things, not to validate.

If you want to iterate — edit your diff in response to findings, then re-review, repeat until the reviewer signs off — pass the prior review's JSON output back in via `--continue`:

```bash
# First pass: capture findings as JSON
/claude-adv:adversarial-review --wait --json > /tmp/review-1.json

# Edit your code to address whatever you want to address...

# Second pass: feed the prior findings in. The reviewer will check each
# against the current diff (was it resolved? still present? new issue?)
# and report only what remains plus any new concerns.
/claude-adv:adversarial-review --wait --json --continue /tmp/review-1.json > /tmp/review-2.json
```

The verdict has three values, not two:

| Verdict              | Meaning                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve`            | No findings. Ship it.                                                                                                                                                                                      |
| `approve-with-notes` | All remaining findings are severity ≤ `medium` AND confidence ≤ 0.7. The reviewer can't defend any of them strongly enough to block on. Ship it; address the notes if you want, or open follow-up tickets. |
| `needs-attention`    | At least one finding is `critical`/`high`, or confidence > 0.7. A careful engineer would block.                                                                                                            |

The loop terminates on `approve` or `approve-with-notes`. Both pass the Stop-gate; only `needs-attention` blocks.

Why three states instead of two: the adversarial reviewer is calibrated to find things. With only `approve` / `needs-attention`, anything defensible held the verdict at `needs-attention` and iterate-to-approve loops never converged. The `approve-with-notes` band makes the verdict a calibrated judgment (severity × confidence) rather than an absolute one, so the loop has a fixed point.

### "Approved means approved": automatic final verification

`--continue` passes prior findings into the next review as context. By itself that creates a subtle problem: the reviewer reads "these were addressed" and is more likely to suppress findings it would otherwise raise — including legitimate high-severity ones. The verdict reported back can be `approve-with-notes` even when an unbiased reviewer would say `needs-attention`.

To close that gap, the runtime **automatically runs a fresh independent verification pass** whenever a `--continue` review concludes with `approve` or `approve-with-notes`:

1. Primary review runs with the `--continue` context, including the prior findings.
2. If the verdict is `needs-attention`, that's authoritative and the runtime returns it (the primary already says "block"; no point spending another model call).
3. If the verdict is `approve` or `approve-with-notes`, the runtime spawns one more review with the **same diff** and the **same prompt** but **without any prior-findings context**. This is a clean adversarial pass from a reviewer with no bias toward "this was probably resolved."
4. The fresh review's verdict is what gets returned. The primary review is preserved in the payload under `continueAttempt` so you can inspect both.

So `approve-with-notes` from an iterate-to-approve loop means: at least one biased reviewer AND at least one independent unbiased reviewer both looked at the artifact and neither found anything they could defend at high severity or high confidence. A `--continue` review alone never produces an authoritative approval.

The cost trade-off: at convergence, each iteration costs ~2× a single review. Non-convergent iterations (still `needs-attention`) cost 1×. In practice the loop ends with 1–3 convergence iterations, so total cost is well-bounded.

`prompts/adversarial-review.md` also instructs the `--continue` reviewer to conduct an independent adversarial pass _first_ and cross-reference against the prior list only for deduplication, not as a list of things to skip. That's a soft constraint — the verification pass is the hard one.

## Install

Requirements:

- macOS or Linux (on Windows, run under WSL2 — native Windows is not supported)
- Node ≥ 20
- An installed and authenticated `claude` CLI: `npm install -g @anthropic-ai/claude-code && claude /login`

Two install paths — see [`docs/HOW-TO.md` §1](docs/HOW-TO.md#1-install-and-verify) for the full walkthrough.

**From the marketplace** — persistent, survives restarts. The repo is its own Claude Code marketplace, so add it straight from GitHub:

```bash
# In Claude Code:
/plugin marketplace add iosazee/claude-adv
/plugin install claude-adv@claude-adv
```

**From a local clone** — handy for trying a specific commit or developing on the plugin:

```bash
git clone https://github.com/iosazee/claude-adv.git
claude --plugin-dir ./claude-adv
```

Then verify:

```bash
/claude-adv:setup
```

You should see a JSON report with `ready: true`, your authenticated `claude` version, and the current review-gate config.

### Codex install

**When to use it:** you're working in an OpenAI Codex session and want a *Claude* second opinion — an adversarial review of your changes, or a write-capable rescue when Codex is stuck. It's the cross-vendor counterpart to running `claude-adv` inside Claude Code. If you're already in Claude Code, use the slash commands above instead; the Codex adapter is the Codex-side entry point only. Codex drives it through the skills in `codex/skills/`, which call the adapter at `codex/scripts/claude-adv-codex.mjs`.

Codex installs use `.codex-plugin/plugin.json`. Point Codex at the plugin root and run the first check:

```bash
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" setup --json
```

Then use it foreground-only: `adversarial-review --wait`, `review --wait`, and `task <prompt>` for rescue. Background jobs are rejected and Stop-gate hooks aren't shipped on this path. The `claude` CLI must be installed and authenticated (or CI must provide an auth environment it accepts). If the Codex host doesn't expose the skill's absolute path, set `CLAUDE_PLUGIN_ROOT` explicitly. Full walkthrough in [`docs/HOW-TO.md` §1](docs/HOW-TO.md#1-install-and-verify).

## Architecture in one paragraph

Each user-initiated review spawns a fresh `claude` subprocess (with `--bare` on API-key auth) via `buildReviewerArgs` with locked invariants. A Node supervisor (the worker) pre-binds a Unix socket so the Stop hook avoids per-event startup overhead, but spawns a fresh `claude` per review request to keep cross-request prompt-injection impossible by construction. State for the Stop gate is tracked via a porcelain-v2 content digest (not a commit SHA), so deletions, mode changes, untracked files, and unmerged-index states all advance the baseline. Cancel is dual-channel: socket-ping-nonce primary, OS-level process-start-time fallback — never a blind PID kill. The Stop gate fails open on every internal error; the only thing that exits with a `block` signal is an explicit `verdict: "needs-attention"` from the model.

The rationale for each invariant — and the threat model behind the trust boundary — is documented inline at the argv builders in [`scripts/lib/claude-cli.mjs`](scripts/lib/claude-cli.mjs).

## Repository layout

```
claude-adv/
├── .claude-plugin/plugin.json     Plugin manifest
├── .codex-plugin/plugin.json      Codex plugin manifest
├── codex/                          Codex adapter + skills
├── commands/                       7 slash commands
├── agents/claude-rescue.md         Rescue subagent (delegates to /claude-adv:rescue)
├── prompts/                        adversarial-review.md, review.md, rescue.md
├── schemas/review-output.schema.json   Strict schema for review verdict + findings
├── hooks/hooks.json                SessionStart / SessionEnd / Stop hook declarations
├── scripts/
│   ├── claude-companion.mjs        Entry point for every slash command
│   ├── claude-adv-worker.mjs       Node supervisor (started by SessionStart)
│   ├── session-lifecycle-hook.mjs  Boots / shuts down the worker
│   ├── stop-review-gate-hook.mjs   9-step state machine for the Stop gate
│   ├── companion-handlers/         One handler per slash command
│   └── lib/                        digest, worker-ipc, claude-cli, git, state, ...
├── skills/                         claude-cli-runtime, claude-result-handling, opus-prompting
├── tests/
│   ├── unit/                       CI-safe tests (mock claude, no real claude calls)
│   ├── integration/*.skip          Manual smoke/integration tests
│   └── fixtures/                   mock-claude.sh + adversarial fixtures
└── docs/
    └── HOW-TO.md                   Task-oriented walkthroughs
```

## Cost model

`claude-adv` uses your existing Claude Code authentication:

- **Claude Code subscription (Max)** — no per-call charges; reviews count against your subscription rate limits. On subscription auth the reviewer is spawned **without `--bare`**, so the inner `claude` reads your OAuth credentials from its own credential store natively (the macOS Keychain, or the `claude` CLI's equivalent on Linux/WSL2) — no token extraction or injection (see [auth modes](docs/HOW-TO.md#11-switch-between-auth-modes)).
- **`ANTHROPIC_API_KEY` set in your environment** — metered against your Anthropic API account. The `--max-budget-usd` flag (default `$5` per review, `$20` per rescue) is a per-invocation cost cap.
- **Bedrock / Vertex / Foundry** — uses each provider's credentials.

Run `/claude-adv:setup --json` to see which auth mode is active.

## Testing

The suite is two tiers: a CI-safe unit layer that runs everywhere with no cost, and a real-`claude` integration layer that's gated off by default.

### CI-safe unit suite — `npm test`

293 unit tests across 28 files under `tests/unit/` plus one `_smoke` import check (294 tests under `npm test`), run by CI on Node 20/22 × Linux/macOS. They exercise the real runtime code against the [`tests/fixtures/mock-claude.sh`](tests/fixtures/mock-claude.sh) stub, so they make **no network calls and cost nothing**. What they pin down:

- **Trust-boundary invariants** — `claude-cli.builder` asserts the locked argv from `buildReviewerArgs`/`buildRescueArgs` (`--tools ""`, `--no-session-persistence`, `--setting-sources ""`, `--bare` on API-key auth) and that callers cannot override them; `claude-cli.spawn` covers stream-json parsing, fence-stripping, and schema validation/normalization.
- **Stop gate** — `stop-gate` drives the state machine: fail-open on every internal error, `approve`/`approve-with-notes` pass, only `needs-attention` exits 2; `digest` covers the porcelain-v2 content baseline across deletions, untracked files, and unmerged index.
- **Supervisor & jobs** — `worker` / `worker-ipc` (busy guard, cumulative budget, interrupt kills the in-flight child, socket-path fallback), `state` / `job-liveness` (PID-reuse-safe locks and liveness), `render`, `git`, `args`, `inline-diff-options`, `companion-dispatch`, `command-invocation-quoting`, `cross-vendor-merge`, `auth-waterfall`.
- **Codex adapter** — eleven `codex-*` files cover the Codex layer: manifest/skills/registry shape, env mapping, argv invariants, background-job rejection, signal handling, and cross-session warnings.

### Real-`claude` integration suite — `tests/integration/*.test.mjs.skip`

These need an authenticated `claude` binary and cost real money (~$0.001–$0.02 each against `claude-haiku-4-5`), so they ship disabled (`.skip`) and are run before tagging a release — activate one by dropping the `.skip` suffix, run it with `node --test`, then restore the suffix. Seven exercise real `claude`:

- `foundational-assumption` — the `claude --bare --print --verbose --output-format stream-json --json-schema <inline>` contract holds.
- `end-to-end-review` — adversarial-review against a real diff returns a schema-conformant verdict.
- `claude-cli.real` — minimal real-`claude` smoke of `buildReviewerArgs` + `spawnAndCollect`.
- `injection-persistence` — prompt injection in review #1 does **not** bias review #2.
- `tools-empty-jailbreak` — a prompt asking the reviewer to write a file produces **no** file write.
- `malicious-settings-rescue` — a hostile `.claude/settings.json` in the target repo grants the rescue subprocess **no** extra tools or hooks.
- `codex-real-claude-review` — Codex adapter → real `claude` adversarial-review smoke.

The eighth, `codex-plugin-installed-smoke`, runs against a mock `claude` and validates the installed-plugin shell.

## Status

**v0.1.0** — implementation complete. The CI-safe suite (`npm test`, 293 unit tests plus one smoke import check in the current tree) runs in CI against the mock-`claude` fixture and stays green. Real-`claude` integration tests live as `.test.mjs.skip` files and should be rerun before tagging a release; the Codex installed-plugin smoke is also kept as a skipped manual release check.

## License

MIT. See [`LICENSE`](LICENSE).

## Acknowledgements

This is an unofficial, independent port. Not affiliated with or endorsed by OpenAI or Anthropic. The plugin architecture is adapted from `codex-plugin-cc`; the trust-boundary design (fresh-subprocess-per-review, dual-channel kill auth, locked argv invariants, schema validation on top of non-enforcing CLI flag) is specific to this port.
