# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added
- `claude-reviewer` agent and `/claude-adv:adversarial-review` now surface and forward the existing `--continue <prior.json>` / `--json` flags, documenting iterative (round-N) re-review and the automatic unbiased verification pass. The runtime already supported this; the agent and command contracts did not expose it, so round-2+ re-reviews had to be hand-rolled.
- Machine-readable continuation signal in the review `--json` payload: `continueRequested`, `continueDegraded`, and `continueDegradeReason` (`unreadable` | `invalid-json` | `not-a-review`). Automated iterate-to-approve loops can now detect when a `--continue` file was missing, unparseable, or valid JSON that is not a review payload — cases where the run silently falls back to a first-pass review instead of a verified re-review.

## [0.2.1] — 2026-05-29

### Changed
- `sync-codex-bundle.mjs` now pins the Claude and Codex plugin manifest versions to `package.json`, so `npm run check:codex-bundle` fails on version drift instead of letting a half-bumped release reach CI. Added an always-on unit test asserting both manifests mirror `package.json`.

## [0.2.0] — 2026-05-29

### Added
- Native Codex marketplace install via `.agents/plugins/marketplace.json` so `iosazee/claude-adv` works in Codex Desktop's Add marketplace dialog.
- `scripts/release/sync-codex-bundle.mjs` keeps the Codex bundle (`plugins/claude-adv/`) in lockstep with root sources; CI checks for bundle drift.

### Changed
- Canonical Codex adapter path moved from `codex/scripts/claude-adv-codex.mjs` to `plugins/claude-adv/scripts/claude-adv-codex.mjs`.
- `claude-reviewer` and `claude-rescue` agent routes now resolve marketplace installs from the Claude plugin cache when `CLAUDE_PLUGIN_ROOT` is unavailable, and surface invocation failures instead of silently dropping the request.

### Deprecated
- `codex/scripts/claude-adv-codex.mjs` continues to work as a tombstone shim with a stderr deprecation notice. It is slated for removal in the release after next.

### Removed
- Root `.codex-plugin/` directory, replaced by `plugins/claude-adv/.codex-plugin/`.
- `codex/skills/` directory, replaced by `plugins/claude-adv/skills/`.
- `codex/scripts/lib/` directory, replaced by `plugins/claude-adv/scripts/lib/`.

## [0.1.0] — 2026-05-13

### Added
- 7 slash commands: `/claude-adv:adversarial-review`, `/claude-adv:review`, `/claude-adv:rescue`, `/claude-adv:setup`, `/claude-adv:status`, `/claude-adv:result`, `/claude-adv:cancel`.
- `claude-rescue` subagent for write-capable task delegation.
- 3 skills: `claude-cli-runtime`, `claude-result-handling`, `opus-prompting`.
- Codex plugin layer with `.codex-plugin/plugin.json`, Codex skills, foreground adapter, CI preflight, and install registry hints.
- Stop-time review gate hook with porcelain-v2 content digest, dual-channel kill auth, fresh-subprocess-per-review isolation.
- Adversarial tests for prompt-injection persistence, `--tools ""` jailbreak, and malicious-settings rescue isolation.
