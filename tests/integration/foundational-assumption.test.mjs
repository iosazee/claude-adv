// tests/integration/foundational-assumption.test.mjs
//
// Gated on RUN_INTEGRATION_TESTS=true so `npm test` skips it (it requires a
// real `claude` binary and an authenticated session). Run it manually before
// tagging a release:
//   RUN_INTEGRATION_TESTS=true node --test tests/integration/foundational-assumption.test.mjs
//
// Plan iter-8 amendments:
//   - --verbose is required when combining --print with --output-format
//     stream-json (the CLI rejects otherwise).
//   - --json-schema takes inline JSON, not a file path (CLI silently hangs
//     on a path arg).
//   - --bare strips keychain reads, so ANTHROPIC_API_KEY must be injected
//     into the subprocess env. We read it from the macOS keychain entry
//     "Claude Code-credentials" (the same place Claude Code stores it).
//   - The model wraps the final JSON in ```json ... ``` fences; we strip
//     them before JSON.parse.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  function resolveAnthropicAccessToken() {
    try {
      if (process.platform === "darwin") {
        const blob = execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        return JSON.parse(blob)?.claudeAiOauth?.accessToken ?? null;
      }
      const blob = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8");
      return JSON.parse(blob)?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  function stripMarkdownFences(text) {
    const trimmed = text.trim();
    const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : trimmed;
  }

  test("claude --bare --print --verbose --output-format stream-json --json-schema <inline> emits a final structured-output message that validates against the schema", async () => {
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

    const args = [
      "--bare",
      "--print",
      "--verbose",
      "--model",
      "claude-haiku-4-5",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--json-schema",
      schemaJson,
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

    const token = resolveAnthropicAccessToken();
    assert.ok(
      token,
      "ANTHROPIC OAuth access token must be resolvable (run `claude /login` if missing)"
    );
    const env = { ...process.env, ANTHROPIC_API_KEY: token };

    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env });
    child.stdin.write(
      "Reply with ONLY this literal JSON, nothing else: " +
        `{"verdict":"approve","summary":"foundation verified"}`
    );
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
    assert.equal(exitCode, 0, `claude exited ${exitCode}. stderr: ${stderrBuf}`);

    // Every line must be valid JSON (stream-json contract).
    const events = lines.map((l) => JSON.parse(l));
    assert.ok(events.length > 0, "stream produced at least one event");

    // The last assistant message must contain the schema-conformant JSON.
    const lastAssistant = [...events].reverse().find((e) => e.type === "assistant" && e.message);
    assert.ok(lastAssistant, "found a final assistant message");

    // Extract the assistant text, strip ```json fences if present, parse as JSON.
    const text = stripMarkdownFences(
      lastAssistant.message.content.map((c) => (c.type === "text" ? c.text : "")).join("")
    );
    const finalObj = JSON.parse(text);
    assert.equal(finalObj.verdict, "approve");
    assert.ok(finalObj.summary);
  });
}
