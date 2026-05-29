import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ALLOWED_BY_PATTERN = [
  {
    pattern: /codex\/scripts\//,
    files: new Set([
      "CHANGELOG.md",
      "codex/scripts/claude-adv-codex.mjs",
      "tests/unit/codex-shim.test.mjs",
      "tests/integration/codex-shim.test.mjs",
      "tests/unit/codex-no-stray-codex-paths.test.mjs",
    ]),
  },
  {
    pattern: /codex\/skills\//,
    files: new Set(["CHANGELOG.md", "tests/unit/codex-no-stray-codex-paths.test.mjs"]),
  },
  {
    pattern: /\.codex-plugin\//,
    files: new Set([
      "CHANGELOG.md",
      "plugins/claude-adv/skills/claude-adv-rescue/SKILL.md",
      "plugins/claude-adv/skills/claude-adv-review/SKILL.md",
      "plugins/claude-adv/skills/claude-adv-runtime/SKILL.md",
      "scripts/release/sync-codex-bundle.mjs",
      "tests/integration/codex-plugin-installed-smoke.test.mjs",
      "tests/unit/codex-manifest.test.mjs",
      "tests/unit/codex-marketplace-manifest.test.mjs",
      "tests/unit/codex-no-stray-codex-paths.test.mjs",
      "tests/unit/codex-registry.test.mjs",
      "tests/unit/plugin-manifest-versions.test.mjs",
    ]),
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);
    if (rel.startsWith(".git") || rel.startsWith("node_modules") || rel.startsWith("docs")) {
      continue;
    }
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else yield full;
  }
}

test("no stray codex legacy paths outside explicit allowlists", () => {
  const violations = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (!/\.(mjs|json|md|ya?ml|sh)$/.test(file)) continue;
    const body = readFileSync(file, "utf8");
    for (const { pattern, files } of ALLOWED_BY_PATTERN) {
      if (!pattern.test(body) || files.has(rel)) continue;
      violations.push(`${rel}: matches ${pattern}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `unexpected legacy Codex path references:\n${violations.join("\n")}`
  );
});
