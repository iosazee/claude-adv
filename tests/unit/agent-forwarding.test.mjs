import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS = [
  {
    file: path.join(ROOT, "agents/claude-reviewer.md"),
    subcommand: "adversarial-review",
    args: "--wait --base HEAD~1",
    errorPrefix: "claude-reviewer",
  },
  {
    file: path.join(ROOT, "agents/claude-rescue.md"),
    subcommand: "task",
    args: "fix the failing tests",
    errorPrefix: "claude-rescue",
  },
];

function extractForwardingSnippet(file, subcommand) {
  const body = readFileSync(file, "utf8");
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const snippet = blocks.find((block) =>
    block.includes(`claude-companion.mjs" ${subcommand} "$ARGUMENTS"`)
  );
  assert.ok(snippet, `${file}: missing executable ${subcommand} forwarding snippet`);
  return snippet;
}

function makeFakeInstall(home) {
  const pluginRoot = path.join(home, ".claude/plugins/cache/claude-adv/claude-adv/9.9.9");
  const companion = path.join(pluginRoot, "scripts/claude-companion.mjs");
  mkdirSync(path.dirname(companion), { recursive: true });
  writeFileSync(
    companion,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "process.stdout.write('stub-ok\\n');",
      "",
    ].join("\n")
  );
  return pluginRoot;
}

function runSnippet(snippet, { args, install = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "claude-adv-agent-home-"));
  const capture = path.join(home, "argv.json");
  if (install) makeFakeInstall(home);
  const result = spawnSync("bash", ["-lc", snippet], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARGUMENTS: args,
      CAPTURE: capture,
      CLAUDE_PLUGIN_ROOT: "",
      HOME: home,
    },
  });
  let captured = null;
  try {
    captured = JSON.parse(readFileSync(capture, "utf8"));
  } catch {
    captured = null;
  }
  rmSync(home, { recursive: true, force: true });
  return { result, captured };
}

test("agent forwarding snippets resolve plugin root from installed cache when CLAUDE_PLUGIN_ROOT is unset", () => {
  for (const agent of AGENTS) {
    const snippet = extractForwardingSnippet(agent.file, agent.subcommand);
    const { result, captured } = runSnippet(snippet, { args: agent.args });
    assert.equal(
      result.status,
      0,
      `${agent.file} failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    assert.equal(result.stdout, "stub-ok\n");
    assert.deepEqual(captured, [agent.subcommand, agent.args]);
  }
});

test("agent forwarding snippets fail visibly when no plugin root can be resolved", () => {
  for (const agent of AGENTS) {
    const snippet = extractForwardingSnippet(agent.file, agent.subcommand);
    const { result, captured } = runSnippet(snippet, { args: agent.args, install: false });
    assert.notEqual(result.status, 0, agent.file);
    assert.equal(result.stdout, "");
    assert.equal(captured, null);
    assert.match(result.stderr, new RegExp(`${agent.errorPrefix}: unable to resolve plugin root`));
  }
});

test("agent wrappers do not silently swallow forwarding failures", () => {
  for (const agent of AGENTS) {
    const body = readFileSync(agent.file, "utf8");
    assert.doesNotMatch(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/claude-companion\.mjs"/);
    assert.doesNotMatch(body, /return nothing/i);
    assert.match(body, /return the failure output exactly as-is/i);
  }
});
