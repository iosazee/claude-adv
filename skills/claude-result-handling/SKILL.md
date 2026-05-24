---
name: claude-result-handling
description: How to present claude-companion runtime output to the user without paraphrasing
---

# Claude Result Handling

When the `claude-companion` runtime returns stdout, present it to the user verbatim. This skill exists because the verbatim discipline is unusually strict.

## The rule

Return runtime stdout exactly as-is. Do NOT:
- Paraphrase findings.
- Summarize the verdict.
- Add a preamble like "Here are the review results:".
- Add a postamble like "Let me know if you'd like to address any of these."
- "Fix" issues mentioned in the review output.

## Why

The runtime is a separate AI instance. Its output represents that instance's epistemically-isolated judgment. Rewriting or summarizing it corrupts the trust boundary — the user is meant to see what the reviewer said, not what the orchestrating agent thought about what the reviewer said.

## What to do with findings

If the user reads a review and decides to address findings, that is a separate task they explicitly initiate. Do not pre-empt that decision. Specifically:
- After a `/claude-adv:adversarial-review` returns, do not propose fixes unless the user asks.
- After a `/claude-adv:rescue` returns, present its output and stop. The rescue subprocess already did the work; the orchestrating agent's job is over.
