// tests/integration/foundational-assumption.test.mjs
//
// Gated on RUN_INTEGRATION_TESTS=true so `npm test` skips it (it requires a
// real `claude` binary and an authenticated session). Run it manually before
// tagging a release:
//   RUN_INTEGRATION_TESTS=true node --test tests/integration/foundational-assumption.test.mjs
//
// What this canary protects: the `claude` CLI flag contract the plugin's
// reviewer subprocess depends on. The plugin uses TWO paths depending on auth
// class (see detectReviewerAuthClass / buildReviewerArgs in
// scripts/lib/claude-cli.mjs):
//   - API-key auth   → `--bare --print --verbose --output-format stream-json
//                       --json-schema <inline> --system-prompt-file <f>
//                       --tools "" ...`
//   - subscription   → the same, WITHOUT `--bare`, spawned from a controlled
//                       temp cwd so the CLI reads its own OAuth keychain.
//
// So this test asks the production auth-class detector which path THIS machine
// would actually use, then issues that exact raw CLI invocation and asserts
// the flag contract still holds (stream-json parses, the final assistant
// message carries schema-conformant JSON). It reuses the auth-class *decision*
// and the *parsing* helpers from the plugin; the argv list is spelled out
// inline so the test independently pins the flags.
//
// Why a --system-prompt-file is mandatory here, not optional: production
// ALWAYS passes one. Without it, the non-bare (subscription) path runs under
// Claude's full default persona, which refuses to emit a context-free
// "approval" verdict — the model returns prose instead of JSON and the canary
// false-fails. The system prompt reframes the role as a structured-output
// emitter, which is exactly what the real reviewer prompt does. Passing it
// also makes the canary exercise the --system-prompt-file flag the plugin
// depends on.
//
// Why branch on auth class at all: `--bare` requires a real API key
// (`sk-ant-api…`). An OAuth access token (`sk-ant-oat…`, what `claude /login`
// stores) is rejected by `--bare` with a 401 ("Invalid API key · Fix external
// API key"). The subscription path omits `--bare` and never injects the OAuth
// token; forcing --bare on a subscription machine is the documented failure
// mode this canary used to trip over.
//
// Other notes:
//   - --verbose is required when combining --print with --output-format
//     stream-json (the CLI rejects otherwise).
//   - --json-schema takes inline JSON, not a file path (the CLI silently hangs
//     on a path arg). It is non-enforcing, so the model can still wrap the
//     object in ```json fences or prose — hence the lib's strip/extract path.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectReviewerAuthClass,
  stripMarkdownFences,
  extractFirstJsonObject,
} from "../../scripts/lib/claude-cli.mjs";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  test("claude flag contract (auth-class-aware): the path production selects emits a final structured-output message that validates against the schema", async () => {
    const schemaJson = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["verdict", "summary"],
      properties: {
        verdict: { type: "string", enum: ["approve", "needs-attention"] },
        summary: { type: "string", minLength: 1 },
      },
    });

    // Minimal system prompt: establish the structured-output-emitter role (so
    // the default persona doesn't refuse) and pin a deterministic verdict so
    // the assertion is stable.
    const systemPrompt = [
      "You are a structured-output emitter used in an automated self-test of the CLI flag contract.",
      "Output ONLY a single JSON object conforming to the provided schema — no prose, no commentary.",
      'For this self-test, emit exactly: {"verdict":"approve","summary":"foundation verified"}',
    ].join("\n");

    // Ask production which path this machine's auth resolves to.
    const { authClass, useBare, credential } = detectReviewerAuthClass();

    // One temp dir holds the system-prompt file (always) and doubles as the
    // controlled cwd on the subscription path.
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-adv-canary-"));
    const promptFile = join(tmpDir, "system-prompt.md");
    writeFileSync(promptFile, systemPrompt);

    // The flag list the plugin's reviewer depends on, spelled out inline so a
    // CLI change that drops/renames any of these trips this canary.
    const baseArgs = [
      "--print",
      "--verbose",
      "--model",
      "claude-haiku-4-5",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--json-schema",
      schemaJson,
      "--system-prompt-file",
      promptFile,
      "--tools",
      "",
      "--permission-mode",
      "default",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--max-budget-usd",
      "0.50",
    ];
    const args = useBare ? ["--bare", ...baseArgs] : baseArgs;

    // Auth-class plumbing mirrors spawnAndCollect:
    //   - bare path: inject the resolved real API key into env.
    //   - subscription path: no injection; spawn from the controlled temp cwd
    //     so the CLI reads its own OAuth keychain and project CLAUDE.md is
    //     suppressed.
    const env = { ...process.env };
    let cwd = process.cwd();
    if (useBare) {
      assert.ok(
        credential?.value,
        "api-key auth class but no resolvable API key value — this is a detector bug"
      );
      env.ANTHROPIC_API_KEY = credential.value;
    } else {
      cwd = tmpDir;
    }

    try {
      const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });
      child.stdin.write("Run the flag-contract self-test and emit your verdict.");
      child.stdin.end();

      const lines = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) lines.push(trimmed);
        }
      });
      let stderrBuf = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => {
        stderrBuf += c;
      });

      const exitCode = await new Promise((resolve) => child.on("close", resolve));

      // Every line must be valid JSON (stream-json contract). Parse first so an
      // auth/API error surfaces in the assertion message — claude routes those
      // to stdout as a `result` event with is_error:true, NOT to stderr.
      const events = lines.map((l) => JSON.parse(l));
      const resultEvent = events.find((e) => e.type === "result");
      assert.equal(
        exitCode,
        0,
        `claude (${authClass} path, useBare=${useBare}) exited ${exitCode}. ` +
          `stderr: ${stderrBuf} | result: ${JSON.stringify(resultEvent ?? null)}`
      );
      assert.ok(events.length > 0, "stream produced at least one event");

      // The last assistant message must contain the schema-conformant JSON.
      const lastAssistant = [...events].reverse().find((e) => e.type === "assistant" && e.message);
      assert.ok(lastAssistant, "found a final assistant message");

      // Extract using the same path production uses: fence-strip, then fall
      // back to first-balanced-object extraction if the model wrapped the JSON
      // in prose. This is the foundational assumption — that production can
      // recover schema-conformant JSON from whatever the CLI emits.
      const rawText = lastAssistant.message.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      const text = stripMarkdownFences(rawText);
      let finalObj;
      try {
        finalObj = JSON.parse(text);
      } catch {
        const extracted = extractFirstJsonObject(text);
        assert.ok(
          extracted,
          `final assistant text is not parseable JSON: ${rawText.slice(0, 300)}`
        );
        finalObj = JSON.parse(extracted);
      }
      assert.equal(finalObj.verdict, "approve");
      assert.ok(finalObj.summary);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
}
