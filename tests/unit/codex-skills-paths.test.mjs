import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_ROOT = path.join(ROOT, "plugins/claude-adv/skills");

test("Codex SKILL.md files reference relocated adapter paths", () => {
  for (const dir of readdirSync(SKILL_ROOT)) {
    const skillPath = path.join(SKILL_ROOT, dir, "SKILL.md");
    if (!statSync(skillPath, { throwIfNoEntry: false })?.isFile()) continue;
    const body = readFileSync(skillPath, "utf8");
    assert.doesNotMatch(body, /codex\/scripts\//, `${skillPath}: stale codex/scripts`);
    assert.doesNotMatch(body, /three directories up/, `${skillPath}: stale root-depth text`);
  }
});
