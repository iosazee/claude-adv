// tests/integration/codex-plugin-installed-smoke.test.mjs
//
// Gated on RUN_INTEGRATION_TESTS=true; run manually before a release:
//   RUN_INTEGRATION_TESTS=true node --test tests/integration/codex-plugin-installed-smoke.test.mjs
//
// Unlike the other integration tests this uses a local mock `claude`, so it
// needs no network access, no real Claude login, and costs nothing.
//
// By default this checks the current checkout. To point at a copied/installed
// Codex plugin root, set CLAUDE_ADV_CODEX_PLUGIN_ROOT=/path/to/installed/root.
// The test uses a local mock `claude`, so it does not require network access
// or a real Claude login.
import { strict as assert } from "node:assert";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

if (process.env.RUN_INTEGRATION_TESTS !== "true") {
  test("skipping integration tests (set RUN_INTEGRATION_TESTS=true to run)", {
    skip: true,
  }, () => {});
} else {
  const CHECKOUT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
  const SKILL_NAMES = ["claude-adv-runtime", "claude-adv-review", "claude-adv-rescue"];

  function resolvePluginRoot() {
    const configured = process.env.CLAUDE_ADV_CODEX_PLUGIN_ROOT;
    const root = realpathSync(path.resolve(configured || CHECKOUT_ROOT));
    assert.ok(
      existsSync(path.join(root, ".codex-plugin", "plugin.json")),
      `missing .codex-plugin/plugin.json under ${root}`
    );
    assert.ok(
      existsSync(path.join(root, "codex", "scripts", "claude-adv-codex.mjs")),
      `missing codex adapter under ${root}`
    );
    return root;
  }

  function makeRepo() {
    const repo = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-installed-smoke-repo-"));
    execSync("git init -q", { cwd: repo });
    execSync('git config user.email "smoke@example.com" && git config user.name smoke', {
      cwd: repo,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(repo, "calc.js"), "export function add(a, b) { return a + b; }\n");
    execSync("git add . && git commit -q -m init", { cwd: repo, shell: "/bin/bash" });
    writeFileSync(path.join(repo, "calc.js"), "export function add(a, b) { return a - b; }\n");
    return repo;
  }

  function makeHomeWithCodex() {
    const home = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-installed-smoke-home-"));
    mkdirSync(path.join(home, ".codex"));
    return home;
  }

  function makeMockClaudePath() {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-installed-smoke-tools-"));
    symlinkSync(process.execPath, path.join(dir, "node"));
    writeFileSync(
      path.join(dir, "claude"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "fake claude 1.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  printf '%s\\n' '{"logged_in":true,"auth_method":"mock"}'
  exit 0
fi
cat > /dev/null
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"codex-installed-smoke"}
{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"verdict\\":\\"approve\\",\\"summary\\":\\"mock installed-plugin smoke approved\\",\\"findings\\":[],\\"next_steps\\":[]}"}]}}
{"type":"result","subtype":"success","total_cost_usd":0.001}
EOF
`,
      { mode: 0o755 }
    );
    return `${dir}:${process.env.PATH}`;
  }

  function runAdapter(pluginRoot, args, options = {}) {
    const adapter = path.join(pluginRoot, "codex", "scripts", "claude-adv-codex.mjs");
    return spawnSync(process.execPath, [adapter, ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: options.codexHome,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
        CODEX_THREAD_ID: "codex-installed-smoke",
        HOME: options.home,
        PATH: options.pathValue,
        CODEX_CI: options.codexCi ? "1" : "0",
      },
      timeout: 30_000,
    });
  }

  function parseJson(result) {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  test("codex installed plugin adapter smoke", () => {
    const pluginRoot = resolvePluginRoot();
    const repo = makeRepo();
    const codexHome = mkdtempSync(path.join(tmpdir(), "claude-adv-codex-installed-smoke-codex-"));
    const home = makeHomeWithCodex();
    const pathValue = makeMockClaudePath();

    const setup = parseJson(
      runAdapter(pluginRoot, ["setup", "--json"], { cwd: repo, codexHome, home, pathValue })
    );
    assert.equal(setup.ready, true);
    assert.equal(setup.config.stopReviewGate, false);

    const neutralReview = parseJson(
      runAdapter(pluginRoot, ["review", "--wait", "--json", "--scope", "working-tree"], {
        cwd: repo,
        codexHome,
        home,
        pathValue,
      })
    );
    assert.equal(neutralReview.review, "Review");
    assert.equal(neutralReview.review_output.verdict, "approve");

    const review = parseJson(
      runAdapter(
        pluginRoot,
        ["adversarial-review", "--wait", "--json", "--scope", "working-tree"],
        {
          cwd: repo,
          codexHome,
          home,
          pathValue,
        }
      )
    );
    assert.equal(review.review, "Adversarial Review");
    assert.equal(review.review_output.verdict, "approve");
    assert.equal(review.review_output.summary, "mock installed-plugin smoke approved");

    const rescue = parseJson(
      runAdapter(pluginRoot, ["task", "--json", "explain the calc.js change"], {
        cwd: repo,
        codexHome,
        home,
        pathValue,
      })
    );
    assert.equal(rescue.ok, true);
    assert.match(rescue.rawOutput, /mock installed-plugin smoke approved/);

    const ciReview = parseJson(
      runAdapter(
        pluginRoot,
        ["adversarial-review", "--wait", "--json", "--scope", "working-tree"],
        {
          cwd: repo,
          codexHome,
          home,
          pathValue,
          codexCi: true,
        }
      )
    );
    assert.equal(ciReview.review_output.verdict, "approve");

    const rejectedBackground = runAdapter(
      pluginRoot,
      ["adversarial-review", "--background", "--json", "--scope", "working-tree"],
      { cwd: repo, codexHome, home, pathValue }
    );
    assert.notEqual(rejectedBackground.status, 0);
    assert.match(rejectedBackground.stderr, /--background is not supported for adversarial-review/);

    const status = parseJson(
      runAdapter(pluginRoot, ["status", "--json"], { cwd: repo, codexHome, home, pathValue })
    );
    assert.deepEqual(status.running, []);
    assert.equal(status.latestFinished, null);
    assert.deepEqual(status.recent, []);

    const adapterPath = path.join(pluginRoot, "codex", "scripts", "claude-adv-codex.mjs");
    for (const skillName of SKILL_NAMES) {
      const skillFile = path.join(pluginRoot, "codex", "skills", skillName, "SKILL.md");
      assert.ok(existsSync(skillFile), `missing skill ${skillName}`);
      const skill = readFileSync(skillFile, "utf8");
      assert.match(skill, /codex\/scripts\/claude-adv-codex\.mjs/);
      assert.ok(existsSync(adapterPath), `skill ${skillName} points at missing adapter`);
    }
  });
}
