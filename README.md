# claude-adv

> A second-opinion Claude inside your Claude Code session.
> Independent of the main thread, isolated from your project's settings and hooks,
> built to break confidence in your work — not validate it.

`claude-adv` runs an **adversarial reviewer** and a **write-capable rescue** out of your Claude Code session via slash commands. The reviewer is epistemically isolated from the implementing Claude — fresh `claude` subprocess per review with locked argv invariants (`--tools ""`, `--no-session-persistence`, `--setting-sources ""`, plus `--bare` on API-key auth) — so prompt injection in one turn cannot bias the next. Rescue keeps the same isolation but grants edit permissions.

A self-contained Codex bundle (`plugins/claude-adv/`) exposes the same runtime to Codex sessions through a small adapter and native marketplace manifest.

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

- **Interactively in Claude Code** — the slash commands above. Primary surface.
- **Autonomously or from scripts** — the [Stop-time gate](docs/HOW-TO.md#6-use-the-stop-time-review-gate) auto-reviews at every turn boundary; [iterate-to-approve](docs/HOW-TO.md#12-iterate-a-review-to-approval) loops; `--json` for machine-readable verdicts (see [For agents and scripting](docs/HOW-TO.md#17-for-agents-and-scripting)).
- **From Codex** — the [Codex marketplace bundle](#codex-install) covers Codex sessions and CI gates ([§11](docs/HOW-TO.md#11-switch-between-auth-modes)).

Auth (subscription / API key / Bedrock·Vertex·Foundry) is auto-detected per run — see [auth modes and cost](docs/HOW-TO.md#11-switch-between-auth-modes).

## Why it exists

Claude reviewing Claude's own work in the same conversation has two failure modes:

1. **Sycophancy by familiarity.** Same model, same context, same recent history → "looks good, minor suggestions."
2. **Prompt-injection persistence.** Untrusted text in a diff can poison conversation state and bias later reviews.

`claude-adv` rules both out by structurally separating reviewer from implementer:

- **Different process**, not a sub-call — no shared in-memory state.
- **No history** — `--no-session-persistence`; no resume, no carryover.
- **No settings** — `--setting-sources ""` blocks project hooks/settings everywhere. On API-key auth, `--bare` additionally strips plugin sync, CLAUDE.md auto-discovery, and credential-store reads; on subscription auth those are bounded by the locked tool-less prompt and a controlled temp `cwd` ([auth modes](docs/HOW-TO.md#11-switch-between-auth-modes)).
- **No tools** — `--tools ""` at the CLI level. Even a jailbroken prompt has no way to write files or run commands.
- **Fresh subprocess per review** — a Node supervisor pre-binds a Unix socket for low-latency hook firing, but spawns brand-new `claude` per request.

Each invariant is locked at the argv builders (`buildReviewerArgs`, `buildRescueArgs`), asserted in golden-argv tests, and verified end-to-end against real `claude` (prompt-injection persistence, `--tools ""` jailbreak resistance, malicious `.claude/settings.json` fixture).

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

Full reference in [`docs/HOW-TO.md`](docs/HOW-TO.md):

- [Command and flag reference](docs/HOW-TO.md#16-command-and-flag-reference) — every flag, scope/model/effort semantics, inline-diff caps.
- [For agents and scripting](docs/HOW-TO.md#17-for-agents-and-scripting) — `--json` shapes, exit codes, subagent routes.
- [Iterate a review to approval](docs/HOW-TO.md#12-iterate-a-review-to-approval) — three-value verdict, `--continue`, automatic unbiased verification pass.
- [Auth modes and cost](docs/HOW-TO.md#11-switch-between-auth-modes) — subscription / API key / Bedrock·Vertex·Foundry.
- [Develop on the plugin](docs/HOW-TO.md#15-develop-on-the-plugin-itself) — test suite, gated real-`claude` integration tests, invariant golden tests.

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

Use this when you're in an OpenAI Codex session and want a *Claude* second opinion — adversarial review of your changes, or write-capable rescue when Codex is stuck. The cross-vendor counterpart to running `claude-adv` inside Claude Code. (Already in Claude Code? Use the slash commands above; the Codex adapter is the Codex-side entry point only.) Codex drives the adapter at `scripts/claude-adv-codex.mjs` inside the installed `plugins/claude-adv/` bundle.

Recommended: in Codex Desktop, open Plugins → Add marketplace and paste `iosazee/claude-adv` (Git ref `main`). Optional sparse paths: `.agents/plugins` and `plugins/claude-adv`. For a cloned checkout, run:

```bash
node "<checkout>/plugins/claude-adv/scripts/claude-adv-codex.mjs" setup --json
```

Foreground-only — `adversarial-review --wait`, `review --wait`, `task <prompt>` for rescue. Background jobs are rejected and Stop-gate hooks aren't shipped on this path. Requires authenticated `claude` CLI (or CI auth env). If the Codex host doesn't expose the skill's absolute path, set `CLAUDE_PLUGIN_ROOT` explicitly. Full walkthrough: [`docs/HOW-TO.md` §1](docs/HOW-TO.md#1-install-and-verify).

## Architecture in one paragraph

Each user-initiated review spawns a fresh `claude` subprocess (with `--bare` on API-key auth) via `buildReviewerArgs` with locked invariants. A Node supervisor (the worker) pre-binds a Unix socket so the Stop hook avoids per-event startup overhead, but spawns a fresh `claude` per review request to keep cross-request prompt-injection impossible by construction. State for the Stop gate is tracked via a porcelain-v2 content digest (not a commit SHA), so deletions, mode changes, untracked files, and unmerged-index states all advance the baseline. Cancel is dual-channel: socket-ping-nonce primary, OS-level process-start-time fallback — never a blind PID kill. The Stop gate fails open on every internal error; the only thing that exits with a `block` signal is an explicit `verdict: "needs-attention"` from the model.

The rationale for each invariant — and the threat model behind the trust boundary — is documented inline at the argv builders in [`scripts/lib/claude-cli.mjs`](scripts/lib/claude-cli.mjs).

## Repository layout

```
claude-adv/
├── .claude-plugin/plugin.json     Plugin manifest
├── .agents/plugins/marketplace.json  Codex marketplace manifest
├── plugins/claude-adv/             Self-contained Codex bundle
├── codex/                          One-release compatibility shim for the old adapter path
├── commands/                       7 slash commands
├── agents/                         claude-rescue.md, claude-reviewer.md (Agent-tool routes)
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

## License

MIT. See [`LICENSE`](LICENSE).

## Acknowledgements

This is an unofficial, independent port. Not affiliated with or endorsed by OpenAI or Anthropic. The plugin architecture is adapted from `codex-plugin-cc`; the trust-boundary design (fresh-subprocess-per-review, dual-channel kill auth, locked argv invariants, schema validation on top of non-enforcing CLI flag) is specific to this port.
