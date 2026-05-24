# How-to guide

Task-oriented walkthroughs for `claude-adv`. Read [`README.md`](../README.md) first for what it is and why; this file is for what to actually *do*.

## Contents

1. [Install and verify](#1-install-and-verify)
2. [Run your first adversarial review](#2-run-your-first-adversarial-review)
3. [Focus a review on a specific concern](#3-focus-a-review-on-a-specific-concern)
4. [Review a branch instead of working-tree changes](#4-review-a-branch-instead-of-working-tree-changes)
5. [Review a large feature branch (raise the inline-diff caps)](#5-review-a-large-feature-branch-raise-the-inline-diff-caps)
6. [Use the Stop-time review gate](#6-use-the-stop-time-review-gate)
7. [Delegate a hard task to the rescue subagent](#7-delegate-a-hard-task-to-the-rescue-subagent)
8. [Run reviews in the background](#8-run-reviews-in-the-background)
9. [Pick the right model and effort level](#9-pick-the-right-model-and-effort-level)
10. [Set per-review budget caps](#10-set-per-review-budget-caps)
11. [Switch between auth modes](#11-switch-between-auth-modes)
12. [Iterate a review to approval](#12-iterate-a-review-to-approval)
13. [Troubleshooting](#13-troubleshooting)
14. [Cross-vendor review (experimental)](#14-cross-vendor-review-experimental)
15. [Develop on the plugin itself](#15-develop-on-the-plugin-itself)

---

## 1. Install and verify

```bash
# Prereqs
node --version    # must be ≥ 20
claude --version  # any recent version (2.1.x verified)
claude /login     # authenticate if you haven't already
```

Windows isn't supported natively (the Stop-gate worker relies on POSIX process groups and `setsid`); run claude-adv under **WSL2**, where it behaves exactly like any Linux install.

Two official install paths, depending on whether you want a persistent install or a working clone:

### A. From the marketplace (recommended for everyday use)

The repo is its own Claude Code marketplace (`.claude-plugin/marketplace.json` at the root), so you can add it straight from GitHub and install. The plugin then persists across sessions:

```bash
# In Claude Code:
/plugin marketplace add iosazee/claude-adv
/plugin install claude-adv@claude-adv
```

`claude plugin details claude-adv` confirms the install. To pull updates later, `/plugin marketplace update claude-adv` then `/plugin update claude-adv` (restart Claude Code to apply).

### B. From a local clone (for a specific commit, or developing on the plugin)

Clone the repo and load it with `--plugin-dir`. Nothing is registered globally — restart Claude Code without the flag and the plugin disappears:

```bash
git clone https://github.com/iosazee/claude-adv.git
claude --plugin-dir ./claude-adv
```

Inside that session, `/claude-adv:setup`, `/claude-adv:adversarial-review`, etc. are available. Edits to files in the clone take effect on the next Claude Code start (or `/plugin reload` if your version supports it). This is also the path the smoke-install script uses.

### Verify

After install via any path:

```bash
/claude-adv:setup
```

You should see something like:

```
claude-adv setup
  ready: yes
  node: v24.11.0
  claude: 2.1.140 (Claude Code)
  auth: logged in (claude.ai)
  config.stopReviewGate: false
  config.maxBudgetUsd: $5
```

Get the same output as JSON with `/claude-adv:setup --json`.

If `ready: no`, see the [troubleshooting section](#13-troubleshooting).

### Codex: when to use it, and how

**When.** Use the Codex path when you're in an OpenAI Codex session and want Claude to weigh in on Codex's work — an adversarial or neutral review of the current diff, or a write-capable rescue task. It exists so a Codex user gets the same isolated, fresh-subprocess Claude reviewer that Claude Code users get from the slash commands. If you're inside Claude Code, don't use this — use the `/claude-adv:*` slash commands; the adapter is the Codex-side entry point only.

**How.** Codex installs use `.codex-plugin/plugin.json` plus the skills under `codex/skills/` (`claude-adv-runtime`, `claude-adv-review`, `claude-adv-rescue`), which shell out to the adapter — or you can call the adapter directly. Claude Code installs, by contrast, use `.claude-plugin/`. Point Codex at the plugin root and run the first check:

```bash
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" setup --json
```

The `claude` CLI must be installed and authenticated for local Codex use:

```bash
npm install -g @anthropic-ai/claude-code
claude /login
```

The command surface (all foreground — `--background` is rejected):

```bash
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" adversarial-review --wait [focus…]
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" review --wait
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" task <prompt>      # write-capable rescue
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" status <job-id>
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" result <job-id>
node "<plugin-root>/codex/scripts/claude-adv-codex.mjs" cancel <job-id>
```

Constraints specific to this path: no Stop-gate hooks run, and in CI (`CODEX_CI` set) `status`/`result`/`cancel` require an explicit job id while `review`/`adversarial-review`/`task` run a setup preflight first (exit 78 if `claude` is missing or unauthenticated — see [§11](#11-switch-between-auth-modes)). State lives under `CODEX_HOME` (`$CODEX_HOME/state/claude-adv/…`), so separate `CODEX_HOME` values are the supported isolation boundary between roles or CI jobs — see [§8](#8-run-reviews-in-the-background).

Codex Desktop exposes absolute `SKILL.md` paths in observed builds, but Codex CLI/CI skill-path exposure is not guaranteed. In CI or any host that cannot resolve the skill path, set `CLAUDE_PLUGIN_ROOT=/path/to/claude-adv` explicitly before invoking the adapter.

### Manual Codex installed-plugin smoke

Before a release, run the Codex smoke test (gated behind `RUN_INTEGRATION_TESTS=true`) from the plugin root you want to verify. It uses a mock `claude`, so it needs no network and costs nothing:

```bash
RUN_INTEGRATION_TESTS=true node --test tests/integration/codex-plugin-installed-smoke.test.mjs
```

To test a copied or installed plugin root from another checkout, set:

```bash
CLAUDE_ADV_CODEX_PLUGIN_ROOT=/path/to/installed/claude-adv \
RUN_INTEGRATION_TESTS=true node --test tests/integration/codex-plugin-installed-smoke.test.mjs
```

Expected output shape:

```text
✔ codex installed plugin adapter smoke
ℹ tests 1
ℹ pass 1
```

The smoke uses a local mock `claude` binary. It asserts `setup --json` returns `ready: true`, both review commands return `approve` payloads, `task --json` returns a rescue payload, CI preflight permits a ready review, `--background` is rejected before any job is queued, and all Codex skills point at an adapter path that exists under the installed plugin root.

---

## 2. Run your first adversarial review

By default (`--scope auto`) the reviewer chooses its target from your repo state: if the working tree is **dirty**, it reviews your uncommitted changes (working tree vs `HEAD`); if the tree is **clean**, it reviews the current branch's diff against its merge-base with the default branch (usually `main`). For a first run the simplest path is an uncommitted change:

```bash
# In any git repo with uncommitted changes:
/claude-adv:adversarial-review --wait
```

`--wait` runs the review in the foreground and prints results when done. Without it, the slash command will prompt you to choose foreground or background.

**Already committed your change?** That's fine — `--scope auto` falls back to the branch diff, so committed work on a feature branch still gets reviewed (against its merge-base with `main`). To be explicit, or to compare against a different base, use `--scope branch` / `--base <ref>` — see [§4](#4-review-a-branch-instead-of-working-tree-changes). One caveat: if you committed straight onto the default branch, or the branch hasn't diverged from its base, the branch diff is empty and you'll get a vacuous `approve` on nothing — force a real comparison with `--base <ref> --scope branch` (or leave one line uncommitted). See [the troubleshooting note](#review-returns-verdict-approve-on-a-known-buggy-diff).

You'll see something like:

```
# Adversarial Review — working tree diff

Verdict: **needs-attention**

The proposed change to add() introduces a subtle off-by-one in the loop guard...

## Findings

- **high**: Off-by-one in retry counter
  src/queue.ts:42-49 (confidence 0.92)
  When retries == max, the loop body still runs once before checking ...
  → Move the increment to the top of the loop, or change `<=` to `<`.

Cost: $0.0042
```

The reviewer is not the implementing Claude. It saw no prior turns, didn't write the code, and has no stake in it shipping. That's the whole point.

---

## 3. Focus a review on a specific concern

Anything you write after the flags becomes the reviewer's focus:

```bash
/claude-adv:adversarial-review --wait the new auth middleware — am I leaking tokens?
```

The focus text is interpolated into the prompt template via `{{USER_FOCUS}}`. The reviewer still reports every material issue it finds, but it weights the focused area more heavily.

If you want a neutral (not adversarial) review:

```bash
/claude-adv:review --wait focus the public API surface
```

`review` uses a softer prompt — useful for routine reviews where the adversarial frame is overkill.

---

## 4. Review a branch instead of working-tree changes

Default scope is `auto`, which picks working-tree if dirty, else the current branch's diff against the merge-base with the default branch (typically `main`). To control this explicitly:

```bash
# Review only what's modified in the working tree (uncommitted edits)
/claude-adv:adversarial-review --wait --scope working-tree

# Review the current branch's diff against main (or whatever is the merge-base)
/claude-adv:adversarial-review --wait --scope branch

# Review against a specific base ref
/claude-adv:adversarial-review --wait --base develop --scope branch
```

`--scope auto` is the default and usually does the right thing.

---

## 5. Review a large feature branch (raise the inline-diff caps)

The reviewer subprocess runs with locked `--tools ""` and cannot fetch the diff itself. The runtime inlines the diff into the prompt up to two caps: **262 144 bytes (256 KiB) total** and **65 536 bytes (64 KiB) per file**. Either cap exceeded → the runtime drops to **self-collect mode**, gives the reviewer only file names and stats, and the paper-approve safeguard converts any approve verdict to `needs-attention` with a synthetic finding (because a verdict based on file names alone is not a real review).

For substantial feature branches that exceed the defaults, raise the caps per-invocation:

```bash
# Default 256 KiB total is too small for a medium feature branch; raise to 1 MiB
/claude-adv:adversarial-review --wait --scope branch \
  --max-inline-bytes 1048576

# Larger branch: bump the per-file cap too if any single file has a big diff
/claude-adv:adversarial-review --wait --scope branch \
  --max-inline-bytes 2097152 \
  --max-inline-file-bytes 524288
```

**What you can actually fit:** Opus 4.7's 1M context window leaves roughly ~900K tokens of diff budget after prompt overhead, which is ~3 MiB of code text numerically. The runtime will let you set caps up to that ceiling, but quality is the real constraint, not bytes:

| Branch size | Suggested cap | Verdict |
|---|---|---|
| Small (5-20 files, <100 KiB) | Default 262144 | Works out of the box |
| Medium (20-50 files, 100-500 KiB) | `--max-inline-bytes 524288` | Fits, quality solid |
| Large (50-150 files, 500 KiB-1.5 MiB) | `--max-inline-bytes 1572864 --max-inline-file-bytes 262144` | Fits, but the reviewer's coverage of subtle cross-file issues degrades. `approve-with-notes` is robust because severity×confidence filtering still calibrates well; raw approvals get less reliable |
| Worktree-sized (150+ files, multi-MiB) | Even with caps lifted, structurally wrong tool | Prefer scoped reviews per logical area (see below) |

**Cost:** at Opus 4.7 input pricing, a 1 MiB diff is roughly $1 per review pass. Iterate-to-approve runs the verification pass at convergence, doubling that. Plan for $2-4 per converged iteration on large branches.

**When the right answer is scoping, not raising caps:**

- **Narrow `--base` to a sub-range.** If the branch has natural checkpoints (a sibling feature merged first, a tagged commit, a logical phase boundary), point `--base` at it to review only the recent slice:
  ```bash
  /claude-adv:adversarial-review --wait --base auth-checkpoint --scope branch
  ```
- **Walk commits.** For a long branch where commits are themselves logical units:
  ```bash
  git rev-list main..HEAD --reverse | while read sha; do
    /claude-adv:adversarial-review --wait --base "${sha}^" --scope branch --json \
      > "/tmp/review-${sha}.json"
  done
  ```
  Trade-off: cross-commit issues (a bug introduced in commit A, amplified in commit C) won't be caught by either review in isolation. Use scoped reviews when commits are independent slices; raise the cap when they aren't.
- **Working-tree vs branch separately.** Long-running branch with uncommitted edits? `--scope working-tree` and `--scope branch` review the two halves independently. Smaller per-invocation, easier to reason about.

Invalid values throw rather than silently falling back to defaults — `--max-inline-bytes 0` or `--max-inline-bytes huge` will exit non-zero with a clear error. That's deliberate: a typo silently absorbing to the default would let you think you raised the cap and get a self-collect demotion anyway.

---

## 6. Use the Stop-time review gate

The Stop-time gate runs an adversarial review automatically at every turn boundary (when Claude Code's Stop event fires). If the review returns `verdict: "needs-attention"`, the turn is blocked — Claude Code sees the review's stderr as feedback and the user can't finish the turn on broken code.

Enable it:

```bash
/claude-adv:setup --enable-review-gate
```

Disable it:

```bash
/claude-adv:setup --disable-review-gate
```

The gate respects the `maxBudgetUsd` cap and skips work when the porcelain-v2 content digest hasn't changed since the last review (so back-to-back Stops on the same state are a no-op).

**Fail-open behavior.** The gate is engineered to *fail open*: any internal error (parse failure, worker timeout, network blip, schema-invalid output, ancestry break) results in exit 0 with the issue logged to `~/.claude/state/claude-adv/sessions/<session-id>/worker.log`. The only thing that exits with a block signal is an explicit `needs-attention` verdict from the model.

**State.** The gate stores a baseline at `~/.claude/state/claude-adv/sessions/<session-id>/last-reviewed.json` — a sha256 over HEAD + index-tree + sorted porcelain-v2 records. Untracked files, mode changes, symlink retargets, and unmerged-index states all advance the digest, so they all trigger a re-review.

**Worker.** The gate runs through a small Node supervisor (`claude-adv-worker.mjs`) started by SessionStart and stopped by SessionEnd. The worker pre-binds a Unix socket so per-Stop latency is dominated by the model call, not subprocess startup. It spawns a fresh `claude` subprocess per review (no shared in-memory state between reviews — critical for prompt-injection isolation).

---

## 7. Delegate a hard task to the rescue subagent

When you (or the implementing Claude) is stuck on something — couldn't get tests to pass, can't see why a refactor is breaking, has been chasing the same bug across several turns — hand it off to the rescue subagent:

```bash
/claude-adv:rescue Rewrite the retry logic in src/queue.ts so it handles partial-failure
correctly. Existing tests in test/queue.spec.ts MUST still pass.
The current code panics on a 503 from the upstream API.
```

The rescue subagent (`claude-rescue`) shapes your prompt with context, then forwards to `claude-companion.mjs task` which spawns a fresh `claude` subprocess (with `--bare` on API-key auth) via `buildRescueArgs`. That subprocess:

- Has write access to the working directory (no `--tools ""`).
- Has `--permission-mode bypassPermissions` (locked, not overridable). This lets rescue run `npm test`, `npx biome check`, `git diff`, and other verifiers on its own work — the prompt asks it to do so before summarizing. Trust boundary: rescue is invoked deliberately (slash command or another agent's explicit delegation), the system prompt is locked to `prompts/rescue.md`, and the threat surface beyond plain file-edit access is shell execution in the workspace.
- Has its own session, no carryover from your current Claude Code conversation.
- Inherits **no** project hooks or `settings.json` (`--setting-sources ""` is locked on every path). On API-key auth, `--bare` additionally strips user-level plugins, CLAUDE.md auto-discovery, and credential-store reads.

When rescue finishes, its output is returned **verbatim** — the `claude-result-handling` skill enforces that no other agent paraphrases or summarizes it.

**Tip:** A good rescue prompt names files in scope, lists what was already tried, and states an explicit done-condition ("tests pass", "function returns the expected value for these inputs"). The `opus-prompting` skill in this plugin documents the pattern.

---

## 8. Run reviews in the background

Long reviews can be backgrounded. The slash command returns immediately with a job ID; results land in the job record.

```bash
/claude-adv:adversarial-review --background --scope branch the auth refactor
# Returns:
# Claude Adversarial Review started in the background as adversarial-review-20260514-101523-XXXX.
```

Then later:

```bash
/claude-adv:status                    # list all jobs in this workspace
/claude-adv:status adversarial-review-20260514-101523-XXXX   # snapshot one job
/claude-adv:result adversarial-review-20260514-101523-XXXX   # show the stored result
/claude-adv:cancel adversarial-review-20260514-101523-XXXX   # SIGTERM the subprocess
```

Cancel works through two paths depending on what's running:

- Foreground review → SIGINT → SIGTERM → process-tree termination of the `claude-companion` subprocess.
- Background review/task → reads the PID from the job record, SIGTERMs it, falls back to SIGKILL after 5s.
- Stop-gate review (worker in flight) → connects to the worker socket, sends `{type: "interrupt"}`. Worker SIGTERMs the inner `claude`, respawns it. The interrupted review becomes a soft ALLOW with reason `"interrupted"` so your turn isn't blocked by the cancel.

### Hard cross-session isolation

Codex explicit lookups are intentionally permissive: `result <job-id>` and `cancel <job-id>` warn when the target job belongs to another Codex session, then proceed. That warning is a visibility aid, not an access-control boundary.

For hard isolation between roles, users, or CI jobs, run them with separate `CODEX_HOME` values. The Codex adapter stores its state under `$CODEX_HOME/state/claude-adv/...`, so separate `CODEX_HOME` directories are the supported boundary.

---

## 9. Pick the right model and effort level

Default reviewer: `claude-opus-4-7`. Default rescue effort: `high`.

To override:

```bash
# Cheaper review with haiku
/claude-adv:adversarial-review --wait --model claude-haiku-4-5

# Maximum-effort rescue
/claude-adv:rescue --effort xhigh "rewrite the entire scheduler"

# Or aliases:
/claude-adv:rescue --model opus --effort high "..."
```

`--model` takes a full id (`claude-opus-4-7`) or any alias the `claude` CLI resolves (`opus`, `sonnet`, `haiku`). `--effort` applies to rescue only and is passed straight through to the inner `claude` — the accepted levels are `low|medium|high|xhigh|max` and rescue defaults to `high`. (Consult `claude --help` for the authoritative set your CLI version accepts.)

**Practical guidance:**

- Adversarial reviews on small diffs (<200 LOC): `claude-haiku-4-5` is usually fine and runs in <10 seconds. Opus is overkill.
- Adversarial reviews on architectural changes: Opus catches more (different cost/quality trade-off).
- Rescue tasks: `high` is the right call. `xhigh` is rarely worth the cost; `medium` and below tend to leave work half-done.

---

## 10. Set per-review budget caps

```bash
# Cap each review at $2 instead of the default $5
/claude-adv:setup --set-budget-usd 2
```

This sets `maxBudgetUsd` for the workspace. It's the value passed to `--max-budget-usd` on every `claude` invocation from this plugin. Once a single review exceeds the cap, claude exits and the result is treated as `inner-dead` (review falls back, then fails open per the gate's policy).

Rescue uses a separate cap (`rescueBudgetUsd`, default $20) because rescue does real implementation work and $5 is too low. Adjust it with:

```bash
/claude-adv:setup --set-rescue-budget-usd 30
```

The worker session (for the Stop gate) has a cumulative cap of `maxBudgetUsd × workerBudgetMultiplier` (default 5 × 10 = $50). Once exhausted, the worker returns `code: "budget-exceeded"`, the hook falls back to a fresh subprocess, then fails open. Change the multiplier with:

```bash
/claude-adv:setup --set-worker-budget-multiplier 20
```

All three values persist to the workspace state file, which lives at `$CLAUDE_PLUGIN_DATA/state/<workspace-slug>-<hash>/state.json` (or `/tmp/claude-adv/<workspace-slug>-<hash>/state.json` when `$CLAUDE_PLUGIN_DATA` is unset). Prefer the flags over editing the file by hand — the flags validate inputs, and the file format is internal.

---

## 11. Switch between auth modes

`/claude-adv:setup --json` reports `auth.authMethod`. Three modes are supported:

### Claude Code subscription (Max plan)

This is the default if you've run `claude /login`. On subscription auth the reviewer is spawned **without `--bare`**, so the inner `claude` reads your OAuth credentials from its own credential store natively (the macOS Keychain, or the `claude` CLI's equivalent on Linux/WSL2) — there's no token extraction or injection. Isolation on this path comes from the other locked invariants (`--tools ""`, `--setting-sources ""`, `--no-session-persistence`, locked system prompt) plus a controlled temp working directory; see [Authentication paths (subscription vs API key)](#authentication-paths-subscription-vs-api-key) below for the full breakdown.

No per-call charges; reviews count against your subscription rate limits.

### Anthropic API key

Set `ANTHROPIC_API_KEY=sk-ant-api03-...` in your shell or process env. The plugin sees it and passes it through unchanged. Metered.

### Codex CI

In CI, provide `ANTHROPIC_API_KEY` or another documented Claude CLI auth environment accepted by `claude`. Adapter-detected CI mode runs a setup preflight before `review`, `adversarial-review`, and `task`.

Under CI mode, `status`, `result`, and `cancel` require explicit job ids. Default-scoped lookup is intentionally disabled because CI containers can share host boot fingerprints and do not provide a reliable interactive session scope.

CI preflight failures exit 78 with one of these reason codes:

- `claude-missing` — install or expose the `claude` CLI.
- `auth-missing` — authenticate or provide CI credentials.
- `auth-invalid` — refresh invalid or expired credentials.
- `auth-unknown` — malformed, unrecognized, or transient auth probe failure; retry or investigate separately from normal unauthenticated state.
- `setup-timeout` — setup preflight did not finish in time.
- `setup-malformed` — setup returned non-JSON, non-zero, or an inconsistent readiness payload.

### Bedrock / Vertex / Foundry

Set the provider's credentials per the standard `claude` CLI documentation. The plugin doesn't intermediate; the inner `claude` subprocess picks them up from env or settings.

---

## 12. Iterate a review to approval

The conceptual model — the three-value verdict, the `--continue` flag, and the automatic verification pass that makes `approve-with-notes` a real guarantee — is explained in the README: [Iterate-to-approve](../README.md#iterate-to-approve). This section is the operational recipe plus the when-to / when-not-to.

```bash
# Iteration 1: write JSON output to a file you can feed back in.
/claude-adv:adversarial-review --wait --json the new retry logic > /tmp/r1.json
cat /tmp/r1.json | jq '.review_output.verdict, (.review_output.findings | length)'

# Edit your code to address whichever findings you care about.

# Iteration 2: --continue passes iteration 1's findings to the reviewer as a
# <previously_addressed> block — it verifies resolution against the CURRENT
# diff, suppresses fixed concerns, and focuses on what's new or unresolved.
/claude-adv:adversarial-review --wait --json the new retry logic \
  --continue /tmp/r1.json > /tmp/r2.json

# Repeat until the verdict is approve or approve-with-notes.
```

Use the per-finding `fingerprint` (`sha1(file:line_start:normalized_title)[:16]`) to spot when the same concern recurs across iterations — a sign the fix didn't actually resolve the underlying issue. When a `--continue` run ends in `approve`/`approve-with-notes`, the runtime spawns one more unbiased pass automatically; the verification verdict is authoritative and both attempts are preserved under `.continueAttempt` / `.finalVerification`, so each terminal iteration costs ~2× a single review.

**When iterate-to-approve is the wrong tool:**

- Routine code review of a PR. Use single-shot. The first review is the highest-signal one; iterating mostly produces marginal findings.
- Approving someone else's diff. The reviewer never agrees absolutely; the human approves.
- Locking down a design decision. Iterating with the reviewer is useful for surfacing real gaps, but at some point you're polishing the spec for the reviewer rather than for the implementer.

**When it's the right tool:**

- Drafting a load-bearing design spec or architecture doc where missed gaps are expensive. Run the loop until `approve-with-notes`, then ship.
- A complex diff where you want a strict triage pass and a "did I address the real things?" pass before requesting human review.
- Pre-merge cleanup on a long-running branch.

The `validateAndNormalizeReview` calibration is opinionated: severity × confidence. If the reviewer says critical/high or confidence > 0.7, the loop won't terminate until you address that finding (or push back via the diff so the reviewer drops it on the next pass). That's by design — see the section on verdict-selection rules in `prompts/adversarial-review.md`.

---

## 13. Troubleshooting

### `setup` says `ready: no`

Check each field of the JSON report:

- `node.available: false` → install Node ≥ 20.
- `claude.available: false` → `npm install -g @anthropic-ai/claude-code`.
- `auth.loggedIn: false` → `claude /login` (or `export ANTHROPIC_API_KEY=...` if you're on API-key auth).

### Codex Known installs do not update

Codex skills use the install registry only as a "Known installs" hint. The registry is non-fatal: review and rescue still run if it cannot be updated.

If stderr says `plugin-installs lock held by foreign host=...`, another machine using the same `$CODEX_HOME` owns the registry lock. Fresh foreign-host locks are left alone. Locks older than 24 hours are quarantined automatically to `plugin-installs.json.lock.foreign-stale-<unix-ms>` and the update is retried. For a fresh lock you know is stale, remove the exact `lock=<path>` printed in the warning.

### Adversarial review hangs and never returns

This usually means the inner `claude` subprocess can't authenticate. Check:

```bash
# Does claude work directly?
echo "hello" | claude --bare --print --verbose --output-format stream-json \
  --max-budget-usd 0.10 --model claude-haiku-4-5
```

If that hangs or says "Not logged in", `--bare` mode is rejecting your auth. Fix: either run `claude /login` (refreshes the OAuth token in the `claude` CLI's credential store) or set `ANTHROPIC_API_KEY` directly.

### Authentication paths (subscription vs API key)

The plugin auto-detects which auth path the reviewer subprocess should take. You don't need to configure anything — both paths just work:

- **Subscription auth** (you're logged in to `claude.ai` via `claude /login`): the reviewer is spawned **without `--bare`** so the inner `claude` can read its own OAuth credential store. The runtime also spawns the subprocess from a controlled temp `cwd` to suppress project `CLAUDE.md` auto-discovery. Safety properties that survive: locked `--tools ""` (no tool access), locked `--setting-sources ""` (no hooks, no project settings), locked `--no-session-persistence`, locked `--system-prompt-file`. Surface that remains: user-level `~/.claude/CLAUDE.md` and user-installed plugins may be loaded into the subprocess context, but with `--tools ""` they cannot materially affect verdict behavior.

- **API-key auth** (you've exported `ANTHROPIC_API_KEY=sk-ant-…` OR configured `apiKeyHelper` in `~/.claude/settings.json`): the reviewer is spawned **with `--bare`** for strongest isolation. `--bare` strips everything in one flag: plugins, hooks, settings, credential-store reads, `CLAUDE.md` auto-discovery, auto-memory. This is the highest-isolation mode.

The mechanism: `detectReviewerAuthClass()` checks `env.ANTHROPIC_API_KEY` and user-level `apiKeyHelper` at every spawn. If either resolves to a usable key, `useBare=true`. Otherwise `useBare=false`. The argv builders take `useBare` as a required parameter (no default), so every call site has to visibly choose.

If you want subscription users on your machine to get the strongest isolation, export `ANTHROPIC_API_KEY` or configure `apiKeyHelper`. Both produce identical results (same `--bare` argv) — the only difference is where the API key comes from.

`apiKeyHelper` example (`~/.claude/settings.json`):

```json
{
  "apiKeyHelper": "/Users/you/.config/anthropic/fetch-key.sh"
}
```

The helper script must print the API key to stdout and exit 0. claude-adv only consults `~/.claude/settings.json` and `~/.claude/settings.local.json` — never the project's `.claude/settings.json`, since that file can be planted by an attacker controlling the workspace.

### Review returns `verdict: "approve"` on a known-buggy diff

The auto-scope might be picking an empty diff (e.g. you committed your buggy change and your branch is rooted at HEAD with no parent for comparison). Force a working-tree review:

```bash
/claude-adv:adversarial-review --wait --scope working-tree
```

If your change is committed, leave the working tree dirty (revert one line so there's something to review), or compare against a specific base: `--base main --scope branch`.

### Stop-time gate doesn't fire

Check:

```bash
/claude-adv:setup --json | grep stopReviewGate
```

Must be `true`. Enable with `/claude-adv:setup --enable-review-gate` and restart Claude Code (the SessionStart hook only fires at session boot, so it won't catch a mid-session toggle).

### Stop-time gate fires too often (or not often enough)

The gate fires once per Stop event whose porcelain-v2 content digest differs from the previous review's baseline. If you're seeing duplicate reviews on the same state, check `~/.claude/state/claude-adv/sessions/<session-id>/worker.log` for `digest-error` lines — the digest computation may be falling through to fail-open mode.

If the gate isn't firing on changes you'd expect to trigger it, the digest may not be advancing. Common cause: the change is in a path the digest deliberately ignores (none in normal use; see the spec's "Review-state digest" section for the exact algorithm).

### Worker won't start

Check `~/.claude/state/claude-adv/sessions/<session-id>/worker.json`:

- File present, ping responds → worker is up.
- File present, ping refused → stale; delete the file and reload Claude Code.
- File missing → SessionStart hook didn't fire. Verify `/claude-adv:setup --json` shows `stopReviewGate: true` and Claude Code knows about `hooks/hooks.json`.

### `EINVAL connect` errors on macOS with long $HOME

macOS limits AF_UNIX socket paths to 104 bytes. The worker automatically falls back to a short `/tmp/cadv-<hex>.sock` path when the canonical `~/.claude/state/claude-adv/sessions/<id>/worker.sock` would exceed 100 bytes (e.g. mkdtemp'd test homes under `/var/folders/...`). If you see EINVAL anyway, file an issue with `worker.json`'s `sockPath` field.

### Review caught an issue but I want it to ignore the change anyway

Disable the gate temporarily:

```bash
/claude-adv:setup --disable-review-gate
# ... your turn ...
/claude-adv:setup --enable-review-gate
```

There is intentionally no per-turn override. The whole point of the gate is to make "ship anyway" require a deliberate action.

### Rescue subagent makes the wrong edit

Two likely causes:

1. **Insufficient context in the rescue prompt.** Rescue runs with `--setting-sources ""` on every path (and `--bare` too on API-key auth), so your project's hooks, plugins, and `settings.json` don't shape its behavior. Spell out the constraints and relevant context in the rescue prompt body rather than assuming it inherits your project conventions — the `opus-prompting` skill documents the pattern.
2. **Conflicting done-condition.** "Make the test pass" + "don't change the test" is fine; "make the test pass" with no constraint can lead to test-rewriting. Be explicit.

To recover: `git status` to see what was changed, `git diff` to inspect, `git restore <file>` to roll back specific edits.

---

## 14. Cross-vendor review (experimental)

`scripts/cross-vendor-review.mjs` runs `claude-adv` and `codex-plugin-cc` in parallel against the same diff, fingerprint-merges the outputs, and surfaces where the two vendors agree, where they describe the same site differently, and where each is alone. The unique buckets are the signal: findings one architecture caught that the other missed.

Requirements:
- `claude-adv` installed and authenticated (this plugin)
- `codex-plugin-cc` installed at `~/.claude/plugins/cache/openai-codex/codex/<version>/` (or set `CODEX_PLUGIN_ROOT` to override)
- Both `setup --json` probes returning `ready: true`

```bash
# Defaults: --scope auto, no focus, text output
node scripts/cross-vendor-review.mjs --base main

# JSON output for forensic analysis (includes raw vendor payloads under .raw)
node scripts/cross-vendor-review.mjs --base main --scope working-tree --json > /tmp/cv-review.json

# Skip the readiness preflight if you know both vendors are configured
node scripts/cross-vendor-review.mjs --base main --skip-setup-check
```

Output sections:
- **Both vendors raised** — fingerprint match (same file + line + normalized title). Highest-confidence findings; both architectures independently flagged this.
- **Same site, different framing** — same file, line within ±3, different wording. Probably the same underlying issue described differently by the two vendors.
- **Claude-only findings (codex missed)** — cross-architecture blind-spot signal: things claude-adv caught that codex-plugin-cc didn't.
- **Codex-only findings (claude missed)** — the symmetric blind-spot signal.

Cost: roughly 2x a single review (parallel, latency = slower of the two). Each vendor uses its own credentials; neither needs to know the other exists.

This script is not wired to a slash command — it's a deliberately standalone probe you run directly with `node`.

---

## 15. Develop on the plugin itself

```bash
git clone https://github.com/iosazee/claude-adv.git
cd claude-adv
npm install        # no runtime deps; just creates package-lock.json
npm test           # CI-safe tests, no real claude calls
```

CI-safe tests use a `tests/fixtures/mock-claude.sh` script that fakes `stream-json` output, so they don't make real `claude` calls. All `claude` interactions in CI are mocked.

Real-claude integration tests live in `tests/integration/`, gated behind `RUN_INTEGRATION_TESTS=true` so `npm test`/CI skip them. Each one costs $0.001–$0.02 against `claude-haiku-4-5`. Run them manually before releases:

```bash
RUN_INTEGRATION_TESTS=true node --test tests/integration/
```

The four real-claude tests cover:

| Test | What it proves |
|---|---|
| `foundational-assumption` | `claude --bare --print --verbose --output-format stream-json --json-schema <inline>` parses correctly and the final assistant message can be extracted — a canary against a CLI upgrade changing the flag contract. |
| `injection-persistence` | A prompt-injection payload in review #1 does NOT bias review #2's verdict. |
| `tools-empty-jailbreak` | A prompt asking the reviewer to write a file does NOT result in any file write. |
| `malicious-settings-rescue` | A `.claude/settings.json` declaring extra hooks + permissions does NOT grant the rescue subprocess any of them. |

The Codex installed-plugin smoke (`codex-plugin-installed-smoke`) is mock-backed — no network or cost — and runs under the same `RUN_INTEGRATION_TESTS=true` gate.

### Changing argv invariants, prompts, or schema

If you change argv invariants, prompts, or schema, the affected golden tests in `tests/unit/claude-cli.builder.test.mjs` must be updated in the same commit. The locked-invariant set is enforced by tests that assert callers can't override forbidden keys — if you weaken those, the whole isolation story weakens with them.

### Layout reminder

```
scripts/lib/                  # internal helpers, no external deps
scripts/companion-handlers/   # one file per /claude-adv:<cmd>
scripts/claude-companion.mjs  # dispatcher invoked by every slash command
scripts/claude-adv-worker.mjs # Node supervisor for the Stop-gate
scripts/{session-lifecycle,stop-review-gate}-hook.mjs   # hook entry points
```

The dispatcher uses lazy `import()` so a misbehaving handler doesn't break `--help`. Handlers shouldn't import each other; they share state via the libs in `scripts/lib/`.
