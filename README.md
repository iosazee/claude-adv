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

The full flag reference for every command lives in [`docs/HOW-TO.md` §16](docs/HOW-TO.md#16-command-and-flag-reference).

## Three ways to run it

1. **Interactively in Claude Code** — the slash commands above. Review your working tree or a branch diff, or hand a stuck task to a write-capable rescue Claude. This is the primary surface.
2. **Autonomously or from scripts** — enable the [Stop-time gate](docs/HOW-TO.md#6-use-the-stop-time-review-gate) to auto-review at every turn boundary, run [iterate-to-approve](docs/HOW-TO.md#12-iterate-a-review-to-approval) loops, or drive any command with `--json` for machine-readable verdicts (see [For agents and scripting](docs/HOW-TO.md#17-for-agents-and-scripting)). Other agents can invoke rescue as a subagent.
3. **From Codex** — a [`.codex-plugin/`](#codex-install) layer exposes the same runtime to Codex (foreground-first) and to CI gates via API-key auth (see [`docs/HOW-TO.md` §11](docs/HOW-TO.md#11-switch-between-auth-modes)).

Auth (subscription / API key / Bedrock·Vertex·Foundry) is auto-detected on every run — see [auth modes and cost](docs/HOW-TO.md#11-switch-between-auth-modes).

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

That's the whole surface for everyday use. Everything below is orientation; the deep reference is in [`docs/HOW-TO.md`](docs/HOW-TO.md).

## Reference

The everyday surface is above. The full reference lives in [`docs/HOW-TO.md`](docs/HOW-TO.md):

- **[Command and flag reference](docs/HOW-TO.md#16-command-and-flag-reference)** — every flag for every command, plus scope / model / effort semantics and the inline-diff caps.
- **[For agents and scripting](docs/HOW-TO.md#17-for-agents-and-scripting)** — `--json` output shapes, exit codes, and delegating rescue from another agent.
- **[Iterate a review to approval](docs/HOW-TO.md#12-iterate-a-review-to-approval)** — the three-value verdict, `--continue`, and the automatic unbiased verification pass that makes `approve-with-notes` a real guarantee.
- **[Auth modes and cost](docs/HOW-TO.md#11-switch-between-auth-modes)** — subscription / API key / Bedrock·Vertex·Foundry, what each costs, and how the reviewer's auth class is detected per run.
- **[Develop on the plugin](docs/HOW-TO.md#15-develop-on-the-plugin-itself)** — running the test suite, the gated real-`claude` integration tests, and the invariant golden tests.

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
│   ├── integration/                Gated real-claude smoke/integration tests
│   └── fixtures/                   mock-claude.sh + adversarial fixtures
└── docs/
    └── HOW-TO.md                   Task-oriented walkthroughs
```

## Status

**v0.1.0** — implementation complete. The CI-safe suite (`npm test`) runs in CI against the mock-`claude` fixture and stays green. The real-`claude` integration tests are gated behind `RUN_INTEGRATION_TESTS=true` and should be rerun before tagging a release — see [`docs/HOW-TO.md` §15](docs/HOW-TO.md#15-develop-on-the-plugin-itself).

## License

MIT. See [`LICENSE`](LICENSE).

## Acknowledgements

This is an unofficial, independent port. Not affiliated with or endorsed by OpenAI or Anthropic. The plugin architecture is adapted from `codex-plugin-cc`; the trust-boundary design (fresh-subprocess-per-review, dual-channel kill auth, locked argv invariants, schema validation on top of non-enforcing CLI flag) is specific to this port.
