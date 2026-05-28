import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const SKILL_ROOT = path.join(ROOT, "plugins/claude-adv/skills");
const SKILLS = ["claude-adv-runtime", "claude-adv-review", "claude-adv-rescue"];
const RUNTIME_COMMANDS = [
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" setup --json',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" review --wait',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" adversarial-review --wait',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" status',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" result <job-id>',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" cancel <job-id>',
  'node "<plugin-root>/scripts/claude-adv-codex.mjs" task <prompt>',
];

function readSkill(name) {
  const file = path.join(SKILL_ROOT, name, "SKILL.md");
  const text = readFileSync(file, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, `${name} missing YAML frontmatter`);
  const frontmatter = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const [key, ...rest] = line.split(":");
      return [key.trim(), rest.join(":").trim()];
    })
  );
  return { file, text, body: match[2], frontmatter };
}

function pluginRootSection(text) {
  const match = text.match(/## Plugin Root Resolution\n([\s\S]*?)(?:\n## |\n# |$)/);
  assert.ok(match, "missing Plugin Root Resolution section");
  return match[1];
}

test("codex skills have valid concise frontmatter", () => {
  for (const name of SKILLS) {
    const skill = readSkill(name);
    assert.equal(skill.frontmatter.name, name);
    assert.ok(skill.frontmatter.description.length > 20, name);
    assert.ok(skill.frontmatter.description.length <= 180, name);
  }
});

test("runtime skill documents the adapter command surface", () => {
  const { text } = readSkill("claude-adv-runtime");
  for (const command of RUNTIME_COMMANDS) {
    assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("review and rescue skills route to supported foreground commands", () => {
  const review = readSkill("claude-adv-review").text;
  const rescue = readSkill("claude-adv-rescue").text;

  assert.match(review, /--wait/);
  assert.match(rescue, /task <prompt>/);
});

test("codex skills avoid unsupported behavior", () => {
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.doesNotMatch(text, /--background/);
    assert.doesNotMatch(text, /\bresume\b|--resume|--continue|--fresh/i);
    assert.doesNotMatch(text, /stop-gate|hook/i);
  }
});

test("codex skills describe non-authoritative plugin-root resolution", () => {
  for (const name of SKILLS) {
    const section = pluginRootSection(readSkill(name).text);
    assert.match(section, /CLAUDE_PLUGIN_ROOT/);
    assert.match(section, /SKILL\.md/);
    assert.match(section, /realpath/);
    assert.match(section, /Known installs/i);
    assert.match(section, /registry/i);
    assert.match(section, /Do not auto-resolve/i);
  }
});

test("runtime skill keeps realpath instruction in plugin-root resolution section", () => {
  assert.match(pluginRootSection(readSkill("claude-adv-runtime").text), /realpath/);
});

test("codex skills document CLI and CI plugin-root fallback", () => {
  for (const name of SKILLS) {
    const section = pluginRootSection(readSkill(name).text);
    assert.match(section, /Codex CLI\/CI/i, name);
    assert.match(section, /set `CLAUDE_PLUGIN_ROOT` explicitly/i, name);
    assert.match(section, /not guaranteed/i, name);
  }
});

test("codex skills surface foreground-only behavior", () => {
  for (const name of SKILLS) {
    const { text } = readSkill(name);
    assert.match(text, /foreground-only/i, name);
  }

  assert.match(readSkill("claude-adv-rescue").text, /Codex turn stays occupied/i);
});
