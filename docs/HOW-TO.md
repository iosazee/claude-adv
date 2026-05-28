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
16. [Command and flag reference](#16-command-and-flag-reference)
17. [For agents and scripting](#17-for-agents-and-scripting)

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

Use the Codex path when you're in an OpenAI Codex session and want a Claude second opinion — adversarial/neutral review of the current diff or a write-capable rescue. (Inside Claude Code, use `/claude-adv:*` slash commands instead; the adapter is the Codex-side entry point only.)

Prereq for local use:

```bash
npm install -g @anthropic-ai/claude-code && claude /login
```

#### Install

**A. From the Codex marketplace (recommended).**

In Codex Desktop, open Plugins → Add marketplace. Paste:

- Source: `iosazee/claude-adv`
- Git ref: `main`
- Sparse paths (optional): `.agents/plugins\nplugins/claude-adv` (limits checkout; leave blank to clone the full repo)

The plugin appears in the marketplace picker and installs natively. Codex copies `plugins/claude-adv/` to `~/.codex/plugins/cache/<marketplace>/claude-adv/<version>/`.

**B. Direct adapter (cloned checkout).**

```bash
git clone https://github.com/iosazee/claude-adv.git
PLUGIN_ROOT="<checkout>/plugins/claude-adv"
node "$PLUGIN_ROOT/scripts/claude-adv-codex.mjs" setup --json
```

The path moved from `codex/scripts/claude-adv-codex.mjs` to `plugins/claude-adv/scripts/claude-adv-codex.mjs` in this release. A backwards-compatibility shim at the old path continues to work for one release with a stderr deprecation notice.

Adapter command surface (all foreground — `--background` is rejected):

```bash
ADAPTER="<plugin-root>/scripts/claude-adv-codex.mjs"
node "$ADAPTER" setup --json
node "$ADAPTER" adversarial-review --wait [focus…]
node "$ADAPTER" review --wait
node "$ADAPTER" task <prompt>           # write-capable rescue
node "$ADAPTER" {status|result|cancel} <job-id>
```

Constraints on this path:

- **No Stop-gate hooks** ship.
- **CI mode** (`CODEX_CI` set): `status`/`result`/`cancel` require an explicit job id; `review`/`adversarial-review`/`task` run a setup preflight first (exit 78 if `claude` is missing or unauthenticated — see [§11](#11-switch-between-auth-modes)).
- **State** lives under `$CODEX_HOME/state/claude-adv/…`, so separate `CODEX_HOME` values are the supported isolation boundary between roles or CI jobs — see [§8](#8-run-reviews-in-the-background).
- **Skill path**: Codex Desktop exposes absolute `SKILL.md` paths in observed builds; CLI/CI exposure is not guaranteed. If the host can't resolve the path, set `CLAUDE_PLUGIN_ROOT=/path/to/claude-adv/plugins/claude-adv` before invoking the adapter from a checkout.

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

The reviewer runs with locked `--tools ""` and cannot fetch the diff itself. The runtime inlines the diff into the prompt up to two caps: **256 KiB total** and **64 KiB per file**. Exceeding either drops to **self-collect mode** (file names and stats only) — and the paper-approve safeguard converts any `approve` to `needs-attention` with a synthetic finding, since a verdict on file names isn't a real review.

Raise the caps per-invocation:

```bash
# 1 MiB total — handles a medium feature branch
/claude-adv:adversarial-review --wait --scope branch --max-inline-bytes 1048576

# Larger branch with one big file: bump per-file too
/claude-adv:adversarial-review --wait --scope branch \
  --max-inline-bytes 2097152 --max-inline-file-bytes 524288
```

**Ceiling.** Opus 4.7's 1M context leaves ~900K tokens (~3 MiB) for diff after prompt overhead. The runtime allows caps up to that, but quality degrades before bytes do:

| Branch size                      | Suggested cap                                                | Verdict                                                          |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Small (5–20 files, <100 KiB)     | Default 262144                                               | Works out of the box                                             |
| Medium (20–50 files, 100–500 KiB) | `--max-inline-bytes 524288`                                  | Fits, quality solid                                              |
| Large (50–150 files, 0.5–1.5 MiB) | `--max-inline-bytes 1572864 --max-inline-file-bytes 262144`  | Fits, but cross-file coverage degrades. `approve-with-notes` is still robust (severity×confidence calibrates well); raw approvals get less reliable |
| Worktree-sized (150+ files)      | Wrong tool even with caps lifted                             | Prefer scoped reviews per logical area (below)                   |

**Cost.** At Opus 4.7 input pricing, ~$1 per 1 MiB diff. Iterate-to-approve doubles this at convergence (verification pass). Plan for $2–4 per converged iteration on large branches.

**When scoping beats raising caps:**

- **Narrow `--base` to a sub-range** — point at a sibling-feature merge, a tagged commit, or a phase boundary to review only the recent slice:
  ```bash
  /claude-adv:adversarial-review --wait --base auth-checkpoint --scope branch
  ```
- **Walk commits** for a long branch where commits are themselves logical units:
  ```bash
  git rev-list main..HEAD --reverse | while read sha; do
    /claude-adv:adversarial-review --wait --base "${sha}^" --scope branch --json \
      > "/tmp/review-${sha}.json"
  done
  ```
  Trade-off: cross-commit issues (bug in A, amplified in C) get missed. Scope when commits are independent; raise the cap when they aren't.
- **Working-tree vs branch separately** — `--scope working-tree` and `--scope branch` review the two halves independently. Easier to reason about.

Invalid cap values throw rather than silently falling back — `--max-inline-bytes 0` or `huge` exits non-zero with a clear error. Deliberate: a silent fallback would let a typo demote you to self-collect mode without warning.

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

When you (or the implementing Claude) is stuck — tests won't pass, a refactor is breaking, the same bug keeps coming back across turns — hand it off:

```bash
/claude-adv:rescue Rewrite the retry logic in src/queue.ts so it handles partial-failure
correctly. Existing tests in test/queue.spec.ts MUST still pass.
The current code panics on a 503 from the upstream API.
```

The `claude-rescue` subagent shapes your prompt with context, then forwards to `claude-companion.mjs task`, which spawns a fresh `claude` subprocess (with `--bare` on API-key auth) via `buildRescueArgs`. That subprocess:

- **Writes files** (no `--tools ""`) and runs verifiers (`npm test`, `git diff`, etc.) via `--permission-mode bypassPermissions` (locked). The prompt asks it to verify before summarizing.
- **Own session**, no carryover from your Claude Code conversation.
- **No project hooks or `settings.json`** (`--setting-sources ""` locked everywhere). On API-key auth, `--bare` additionally strips user-level plugins, CLAUDE.md auto-discovery, and credential-store reads.

Trust boundary: rescue is invoked deliberately (slash command or explicit Agent delegation), the system prompt is locked to `prompts/rescue.md`, and the threat surface beyond plain file edits is shell execution in the workspace.

Output is returned **verbatim** — the `claude-result-handling` skill prevents downstream agents from paraphrasing or summarizing it.

**Tip:** Good rescue prompts name the files in scope, list what was already tried, and state an explicit done-condition ("tests pass", "function returns expected value for these inputs"). See the `opus-prompting` skill for the pattern.

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

`/claude-adv:setup --json` reports `auth.authMethod`. Three modes:

### Claude Code subscription (Max plan)

Default if you've run `claude /login`. Reviewer is spawned **without `--bare`**, so the inner `claude` reads OAuth credentials from its own credential store (macOS Keychain or equivalent on Linux/WSL2) — no token extraction or injection. Isolation comes from the other locked invariants (`--tools ""`, `--setting-sources ""`, `--no-session-persistence`, locked system prompt) plus a controlled temp `cwd`. See [Authentication paths](#authentication-paths-subscription-vs-api-key) for the full breakdown.

No per-call charges; reviews count against subscription rate limits.

### Anthropic API key

Export `ANTHROPIC_API_KEY=sk-ant-api03-...`. The plugin passes it through unchanged. Metered.

### Codex CI

Provide `ANTHROPIC_API_KEY` (or any auth env the `claude` CLI accepts). Adapter-detected CI mode runs a setup preflight before `review`, `adversarial-review`, and `task`. `status`/`result`/`cancel` require explicit job ids — default-scoped lookup is disabled because CI containers can share host boot fingerprints and lack reliable interactive session scope.

Preflight failures exit 78 with a reason code:

- `claude-missing` — install or expose the `claude` CLI.
- `auth-missing` — authenticate or provide CI credentials.
- `auth-invalid` — refresh invalid or expired credentials.
- `auth-unknown` — malformed/unrecognized/transient probe failure; retry or investigate.
- `setup-timeout` — preflight didn't finish in time.
- `setup-malformed` — non-JSON, non-zero, or inconsistent readiness payload.

### Bedrock / Vertex / Foundry

Set the provider's credentials per standard `claude` CLI docs. The plugin doesn't intermediate; the inner subprocess picks them up from env or settings.

---

## 12. Iterate a review to approval

Default workflow is one-shot: submit diff → verdict + findings → triage → ship. The plugin is designed as a tough single critic, calibrated to find things, not to validate.

To iterate (edit in response to findings, re-review, repeat until sign-off), pass the prior review's JSON back via `--continue`. The verdict has three values:

| Verdict              | Meaning                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `approve`            | No findings. Ship it.                                                                                                                |
| `approve-with-notes` | All remaining findings are severity ≤ `medium` AND confidence ≤ 0.7 — the reviewer can't defend any strongly enough to block. Ship; address notes or open follow-ups. |
| `needs-attention`    | At least one finding is `critical`/`high`, or confidence > 0.7. A careful engineer would block.                                      |

The loop terminates on `approve` or `approve-with-notes`. Both pass the Stop-gate; only `needs-attention` blocks.

Why three states: the adversarial reviewer is calibrated to find things. With only `approve`/`needs-attention`, anything defensible held the verdict at `needs-attention` and iterate-to-approve never converged. The `approve-with-notes` band makes the verdict a calibrated judgment (severity × confidence), so the loop has a fixed point.

### "Approved means approved": automatic final verification

`--continue` passes prior findings as context, which biases the reviewer: reading "these were addressed" makes it more likely to suppress findings it would otherwise raise, including legitimate high-severity ones. So the runtime **automatically runs a fresh unbiased verification pass** whenever a `--continue` review concludes `approve` or `approve-with-notes`:

1. Primary runs with `--continue` context (prior findings).
2. If verdict is `needs-attention`, return it — the primary already says "block."
3. Otherwise, spawn one more review with the **same diff and prompt** but **without any prior-findings context** — a clean adversarial pass with no "probably resolved" bias.
4. The fresh review's verdict is returned. The primary is preserved under `continueAttempt`.

`approve-with-notes` from an iterate-to-approve loop therefore means: a biased AND an unbiased reviewer both looked, neither found anything defensible at high severity or high confidence. A `--continue` review alone never produces an authoritative approval.

Cost: ~2× a single review at convergence, 1× while still `needs-attention`. Loops typically end in 1–3 converged iterations, so total cost is bounded.

`prompts/adversarial-review.md` also tells `--continue` reviewers to do an independent adversarial pass _first_ and cross-reference the prior list only for deduplication — a soft constraint backstopped by the hard verification pass.

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

Use the per-finding `fingerprint` (`sha1(file:line_start:normalized_title)[:16]`) to spot the same concern recurring across iterations — a sign the fix didn't resolve the underlying issue. Verification verdict and both attempts are preserved under `.continueAttempt` / `.finalVerification`.

**When iterate-to-approve is the wrong tool:**

- **Routine PR review.** Use single-shot — the first review is the highest-signal; iterating produces marginal findings.
- **Approving someone else's diff.** The reviewer never agrees absolutely; the human approves.
- **Locking down a design decision.** Useful for surfacing real gaps, but eventually you're polishing the spec for the reviewer rather than the implementer.

**When it's the right tool:**

- Drafting a load-bearing design spec where missed gaps are expensive. Loop until `approve-with-notes`, ship.
- Complex diffs where you want a strict triage pass plus a "did I address the real things?" pass before human review.
- Pre-merge cleanup on a long-running branch.

The `validateAndNormalizeReview` calibration is opinionated (severity × confidence): if the reviewer says critical/high or confidence > 0.7, the loop won't terminate until you address that finding (or push back via the diff so the reviewer drops it). By design — see verdict-selection rules in `prompts/adversarial-review.md`.

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

Auto-detected per spawn. Both paths just work:

- **Subscription** (`claude /login`): reviewer spawned **without `--bare`**, so the inner `claude` reads its OAuth credential store natively. Subprocess `cwd` is a controlled temp dir to suppress project `CLAUDE.md` auto-discovery. Surviving locks: `--tools ""`, `--setting-sources ""`, `--no-session-persistence`, `--system-prompt-file`. Remaining surface: user-level `~/.claude/CLAUDE.md` and plugins may load into the subprocess context, but with `--tools ""` they can't materially affect verdicts.

- **API-key** (`ANTHROPIC_API_KEY` exported OR `apiKeyHelper` in `~/.claude/settings.json`): reviewer spawned **with `--bare`** — strips plugins, hooks, settings, credential-store reads, `CLAUDE.md` auto-discovery, and auto-memory in one flag. Highest-isolation mode.

Mechanism: `detectReviewerAuthClass()` checks `env.ANTHROPIC_API_KEY` and user-level `apiKeyHelper` at every spawn. Either resolving to a usable key → `useBare=true`. Argv builders require `useBare` as a parameter (no default), so call sites have to choose visibly.

For strongest isolation on a subscription machine, export `ANTHROPIC_API_KEY` or configure `apiKeyHelper`. Both yield identical `--bare` argv — only the key source differs.

`apiKeyHelper` example (`~/.claude/settings.json`):

```json
{
  "apiKeyHelper": "/Users/you/.config/anthropic/fetch-key.sh"
}
```

The helper prints the API key to stdout and exits 0. claude-adv only consults `~/.claude/settings.json` and `~/.claude/settings.local.json` — never the project's `.claude/settings.json`, since that can be planted by an attacker controlling the workspace.

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

CI-safe tests use `tests/fixtures/mock-claude.sh` to fake `stream-json` output, so no real `claude` calls run in CI.

Real-claude integration tests in `tests/integration/` are gated behind `RUN_INTEGRATION_TESTS=true` (`npm test`/CI skip them). Each costs $0.001–$0.02 against `claude-haiku-4-5`. Run manually before releases:

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

Any such change must update the affected golden tests in `tests/unit/claude-cli.builder.test.mjs` in the same commit. The locked-invariant set is enforced by tests asserting callers can't override forbidden keys — weaken those and the isolation story weakens with them.

### Layout reminder

```
scripts/lib/                  # internal helpers, no external deps
scripts/companion-handlers/   # one file per /claude-adv:<cmd>
scripts/claude-companion.mjs  # dispatcher invoked by every slash command
scripts/claude-adv-worker.mjs # Node supervisor for the Stop-gate
scripts/{session-lifecycle,stop-review-gate}-hook.mjs   # hook entry points
```

The dispatcher uses lazy `import()` so a misbehaving handler doesn't break `--help`. Handlers shouldn't import each other; they share state via the libs in `scripts/lib/`.

---

## 16. Command and flag reference

`review`, `adversarial-review`, `status`, `result`, and `cancel` are marked **explicit-invocation only** (`disable-model-invocation: true`). `setup` and `rescue` stay model-invocable — setup is the readiness entry point, and rescue has a subagent route (`claude-adv:claude-rescue`). For adversarial review from agent code, use the `claude-adv:claude-reviewer` subagent; see [§17](#17-for-agents-and-scripting).

| Command                                   | Flags                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/claude-adv:adversarial-review [focus…]` | `--wait` \| `--background` · `--base <ref>` · `--scope auto\|working-tree\|branch` · `--continue <prior.json>` · `--json` · `--model <m>` · `--max-inline-bytes <n>` · `--max-inline-file-bytes <n>` |
| `/claude-adv:review`                      | same as above (no trailing focus text)                                                                                                                                                               |
| `/claude-adv:rescue [task…]`              | `--background` (foreground is the default) · `--model <m>` · `--effort <level>` · `--prompt-file <path>` · `--json`                                                                                  |
| `/claude-adv:setup`                       | `--json` · `--enable-review-gate` \| `--disable-review-gate` · `--set-budget-usd <n>` · `--set-rescue-budget-usd <n>` · `--set-worker-budget-multiplier <n>`                                         |
| `/claude-adv:status [job-id]`             | `--wait` · `--timeout-ms <ms>` · `--all`                                                                                                                                                             |
| `/claude-adv:result <job-id>`             | —                                                                                                                                                                                                    |
| `/claude-adv:cancel <job-id>`             | —                                                                                                                                                                                                    |

- **Scope.** `--scope auto` (default) reviews the working tree if dirty, else the branch diff against its merge-base. `--base <ref>` sets the comparison point for `--scope branch`. See [§4](#4-review-a-branch-instead-of-working-tree-changes).
- **`--model`** takes a full id (`claude-opus-4-7`) or any alias the `claude` CLI resolves (`opus`, `sonnet`, `haiku`). Reviewer default: `claude-opus-4-7`. See [§9](#9-pick-the-right-model-and-effort-level).
- **`--effort`** (rescue only) is passed straight through to the inner `claude`; rescue defaults to `high`. See [§9](#9-pick-the-right-model-and-effort-level).
- **`--max-inline-*`** raise the diff size the reviewer can see inline before it drops to a names-only fallback — see [§5](#5-review-a-large-feature-branch-raise-the-inline-diff-caps).

---

## 17. For agents and scripting

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
  "finalVerification": { "triggered": false }   // the unbiased pass; see §12
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

### Pick the right entry point

Three surfaces, easy to confuse. Picking wrong fails silently — `rescue` accepts a "review my diff" prompt, burns tokens on a free-form transcript, and never registers a tracked review job.

| You want…                                                  | User slash command               | Agent subagent (`Agent` tool) | Subcommand           | Writes? | Job ID prefix          |
| ---------------------------------------------------------- | -------------------------------- | ----------------------------- | -------------------- | ------- | ---------------------- |
| Adversarial verdict on the diff (BLOCK/FLAG/APPROVE)       | `/claude-adv:adversarial-review` | `claude-adv:claude-reviewer`  | `adversarial-review` | No      | `adversarial-review-…` |
| Neutral verdict on the diff                                | `/claude-adv:review`             | — (shell out via Bash)        | `review`             | No      | `review-…`             |
| Claude to apply fixes (after a review, or for any task)    | `/claude-adv:rescue`             | `claude-adv:claude-rescue`    | `task`               | Yes     | `task-…`               |

> **Misuse signal.** `/claude-adv:status` shows no record after you "started a review" → you invoked rescue. Rescue forwards to `task` (separate tracker, free-form transcript, no `review_output` JSON).

**Iterate-to-approve.** `adversarial-review --background` → poll `/claude-adv:status <id>` → read `/claude-adv:result <id>`. On `needs-attention`, fix manually or hand the findings JSON to `/claude-adv:rescue`, then re-run `adversarial-review`. Repeat until `approve`. There is no built-in orchestrator; the commands are deliberately separate.

### Invoking from agent code

All reviewer slash commands (`review`, `adversarial-review`, `status`, `result`, `cancel`) are marked `disable-model-invocation: true`, so `Skill(claude-adv:adversarial-review)` errors with `cannot be used with Skill tool`. Agent routes:

- **`adversarial-review`** → `Agent({ subagent_type: "claude-adv:claude-reviewer", … })`
- **`task` (rescue)** → `Agent({ subagent_type: "claude-adv:claude-rescue", … })`
- **`review`, `status`, `result`, `cancel`** → no subagent wrapper; shell out via Bash

`${CLAUDE_PLUGIN_ROOT}` is populated only inside slash-command bodies. In an agent's Bash call it expands to empty, silently producing `Cannot find module '/scripts/claude-companion.mjs'`. Resolve the path dynamically — the installed location is `~/.claude/plugins/cache/claude-adv/claude-adv/<version>/`, and the version segment changes across releases:

```bash
PLUGIN_DIR="$(ls -td ~/.claude/plugins/cache/claude-adv/claude-adv/*/ | head -1)"
node "${PLUGIN_DIR%/}/scripts/claude-companion.mjs" adversarial-review --wait --base main --scope branch
node "${PLUGIN_DIR%/}/scripts/claude-companion.mjs" status <job-id>
node "${PLUGIN_DIR%/}/scripts/claude-companion.mjs" result <job-id> --json
```

For `claude --plugin-dir ./claude-adv` installs, point at the clone (`node "/path/to/claude-adv/scripts/claude-companion.mjs" …`). The Codex adapter at `plugins/claude-adv/scripts/claude-adv-codex.mjs` resolves its plugin root from its own file path and needs no env var.
