# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-13

### Added
- 7 slash commands: `/claude-adv:adversarial-review`, `/claude-adv:review`, `/claude-adv:rescue`, `/claude-adv:setup`, `/claude-adv:status`, `/claude-adv:result`, `/claude-adv:cancel`.
- `claude-rescue` subagent for write-capable task delegation.
- 3 skills: `claude-cli-runtime`, `claude-result-handling`, `opus-prompting`.
- Codex plugin layer with `.codex-plugin/plugin.json`, Codex skills, foreground adapter, CI preflight, and install registry hints.
- Stop-time review gate hook with porcelain-v2 content digest, dual-channel kill auth, fresh-subprocess-per-review isolation.
- Adversarial tests for prompt-injection persistence, `--tools ""` jailbreak, and malicious-settings rescue isolation.
