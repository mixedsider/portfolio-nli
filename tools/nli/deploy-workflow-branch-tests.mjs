import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

export function registerWorkflowBranchTests(workflow) {
  const start = workflow.indexOf("  deploy:\n");
  assert.ok(start >= 0, "deployment job must exist");
  const nextJob = workflow.slice(start + 1).search(/^  [\w-]+:\n/m);
  const deploy = workflow.slice(start, nextJob < 0 ? undefined : start + 1 + nextJob);
  const header = deploy.slice(0, deploy.indexOf("    steps:\n"));
  const step = extractStep(deploy, "Deploy exact triggering revision");
  test("dependency-free workflow extraction checks every embedded run block with bash -n offline", () => {
    const runs = [...workflow.matchAll(/^        run: (.+)\n((?:          .*\n|\n)*)/gm)];
    assert.equal(runs.length, (workflow.match(/^        run:/gm) ?? []).length);
    assert.ok(runs.length > 0);
    for (const [, value, body] of runs) {
      const script = value === "|" ? body.replace(/^          /gm, "") : value;
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  });
  test("branch gate evaluates skipped needs and fails closed for each prerequisite", () => {
    assert.equal(scalar(header, 4, "needs"), "[main-paths, cd-test-diagnostics]");
    const expression = scalar(header, 4, "if");
    const evaluate = compileGate(expression);
    for (const ref of ["refs/heads/main", "refs/heads/cd/test", "refs/heads/other"]) {
      for (const main of ["success", "failure", "skipped", "cancelled"]) {
        for (const diagnostic of ["success", "failure", "skipped", "cancelled"]) {
          for (const eligible of ["true", "false", ""]) for (const cancelled of [false, true]) {
            const expected = !cancelled && ((ref === "refs/heads/main" && main === "success" && eligible === "true") ||
              (ref === "refs/heads/cd/test" && diagnostic === "success"));
            assert.equal(evaluate({ "github.ref": ref, "needs.main-paths.result": main,
              "needs.main-paths.outputs.eligible": eligible, "needs.cd-test-diagnostics.result": diagnostic,
              "always()": true, "cancelled()": cancelled }), expected,
            JSON.stringify({ ref, main, diagnostic, eligible, cancelled }));
          }
        }
      }
    }
    assert.match(expression, /always\(\) && !cancelled\(\)/);
    assert.match(header, /    concurrency:\n      group: deploy-nli-gateway\n      cancel-in-progress: false\n/);
    const checkout = extractStep(deploy, "Checkout", false);
    assert.equal(scalar(checkout.header, 10, "ref"), "${{ github.sha }}");
  });

  test("gate interpreter rejects executable syntax and faithfully preserves operator precedence", () => {
    for (const expression of ["${{ process.exit() }}", "${{ always(); cancelled() }}",
      "${{ github.ref.constructor }}", "${{ always() || unknown() }}", "${{ always() }} trailing"]) {
      assert.throws(() => compileGate(expression));
    }
    const input = { "always()": true, "cancelled()": false, "github.ref": "refs/heads/main" };
    assert.equal(compileGate("${{ always() || cancelled() && !always() }}")(input), true);
    assert.equal(compileGate("${{ (always() || cancelled()) && !always() }}")(input), false);
    assert.equal(compileGate("${{ github.ref == 'refs/heads/main' && !cancelled() }}")(input), true);
    assert.equal(compileGate("${{ github.ref == 'refs/heads/cd/test' && !cancelled() }}")(input), false);
  });

  test("executable ref mapping rejects unknown refs and invalid SHA before SSH", () => {
    assert.equal(scalar(step.header, 10, "DEPLOY_REF"), "${{ github.ref }}");
    const command = step.run.split("\nset -euo pipefail")[0] + "\nREMOTE\n";
    for (const ref of ["refs/heads/main", "refs/heads/cd/test", "", "refs/heads/other", "refs/tags/main",
      "refs/heads/cd/test' ; echo injected", "refs/heads/main\n", "$(echo injected)"]) {
      for (const sha of ["b".repeat(40), "", "b".repeat(39), "b".repeat(40) + "' ; echo injected"]) {
        const result = spawnSync("bash", ["-ceu", `ssh() { printf '%s\\0' "$@"; }\n${command}`], {
          encoding: "utf8", env: { ...process.env, DEPLOY_REF: ref, DEPLOY_SHA: sha,
            NLI_GATEWAY_USER: "offline", NLI_GATEWAY_HOST: "offline", NLI_GATEWAY_SSH_PORT: "22",
            NLI_GATEWAY_APP_DIR: "/offline", NLI_GATEWAY_PROCESS: "offline", NLI_GATEWAY_PORT: "8787", PREFLIGHT_ID: "1-1" }
        });
        const valid = ["refs/heads/main", "refs/heads/cd/test"].includes(ref) && sha === "b".repeat(40);
        assert.equal(result.status === 0, valid, JSON.stringify({ ref, sha }));
        if (valid) assert.ok(result.stdout.includes(`DEPLOY_BRANCH='${ref.slice(11)}'`));
        else assert.equal(result.stdout.includes("\0"), false, "must reject before SSH");
        assert.doesNotMatch(result.stdout + result.stderr, /injected/);
      }
    }
  });

  test("cd/test requires explicit host before SSH while main retains its default", () => {
    const validate = extractStep(deploy, "Validate required secrets");
    assert.equal(scalar(validate.header, 10, "DEPLOY_REF"), "${{ github.ref }}");
    for (const ref of ["refs/heads/main", "refs/heads/cd/test"]) for (const host of ["", "migrated-offline-host"]) {
      const result = spawnSync("bash", ["-ceu", validate.run], { encoding: "utf8", env: { ...process.env,
        DEPLOY_REF: ref, NLI_GATEWAY_HOST: host, NLI_GATEWAY_USER: "sentinel", NLI_GATEWAY_SSH_KEY: "sentinel",
        NLI_GATEWAY_KNOWN_HOSTS: "sentinel" } });
      assert.equal(result.status === 0, ref === "refs/heads/main" || host !== "");
      assert.doesNotMatch(result.stdout + result.stderr, /sentinel|migrated-offline-host/);
    }
  });

  test("real local Git checks selected branch ancestry and checks out event SHA, not tip", () => {
    const remote = step.run.split("\nset -euo pipefail")[1];
    assert.ok(remote);
    const start = remote.indexOf("# Validate selected source");
    const end = remote.indexOf("\nnode \"${PREFLIGHT_DIR}/lifecycle.mjs\" restart");
    assert.ok(start >= 0 && end > start);
    const script = remote.slice(start, end);
    const dir = mkdtempSync(join(tmpdir(), "deploy-branch-"));
    const git = (cwd, ...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      git(dir, "init", "--bare", "origin.git");
      git(dir, "clone", join(dir, "origin.git"), "work");
      const work = join(dir, "work");
      const commit = (message) => git(work, "-c", "user.name=Offline", "-c", "user.email=offline@example.invalid",
        "commit", "--allow-empty", "-m", message);
      git(work, "checkout", "-b", "main"); commit("base");
      const base = git(work, "rev-parse", "HEAD");
      commit("main only"); const main = git(work, "rev-parse", "HEAD");
      git(work, "checkout", "-b", "cd/test", base); commit("event");
      const event = git(work, "rev-parse", "HEAD"); commit("later tip");
      git(work, "push", "origin", "main", "cd/test");
      for (const [branch, sha, valid] of [["cd/test", event, true], ["main", main, true],
        ["main", event, false], ["cd/test", main, false], ["cd/test", "a".repeat(40), false],
        ["other", base, false], ["cd/test' ; echo injected", base, false],
        ["cd/test", "", false], ["cd/test", base + "' ; echo injected", false]]) {
        git(work, "checkout", "--detach", base);
        const result = spawnSync("bash", ["-ceu", script], { cwd: work, encoding: "utf8",
          env: { ...process.env, GIT_MASTER: "1", DEPLOY_BRANCH: branch, DEPLOY_SHA: sha } });
        assert.equal(result.status === 0, valid, result.stderr);
        assert.equal(git(work, "rev-parse", "HEAD"), valid ? sha : base);
      }
      git(work, "push", "origin", "--delete", "cd/test");
      const missing = spawnSync("bash", ["-ceu", script], { cwd: work, encoding: "utf8",
        env: { ...process.env, GIT_MASTER: "1", DEPLOY_BRANCH: "cd/test", DEPLOY_SHA: event } });
      assert.notEqual(missing.status, 0, "stale remote-tracking branch must not authorize missing source");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function scalar(source, indentation, name) {
  const prefix = " ".repeat(indentation) + name + ": ";
  const lines = source.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `expected one ${name} field`);
  return lines[0].slice(prefix.length);
}

function extractStep(source, name, requireRun = true) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  assert.equal(source.indexOf(marker, start + marker.length), -1, `Duplicate workflow step: ${name}`);
  const end = source.indexOf("\n      - name:", start + marker.length);
  const body = source.slice(start, end < 0 ? undefined : end);
  const runMarker = "        run: |\n";
  const runStart = body.indexOf(runMarker);
  if (!requireRun) return { header: body };
  assert.ok(runStart >= 0, `Missing run block: ${name}`);
  return { header: body.slice(0, runStart), run: body.slice(runStart + runMarker.length).replace(/^          /gm, "") };
}

// Interpret only the small Actions gate grammar; never evaluate source as JavaScript.
function compileGate(expression) {
  assert.match(expression, /^\$\{\{[\s\S]*\}\}$/);
  let remaining = expression.slice(3, -2).trim();
  const tokens = [];
  while (remaining) {
    const match = /^(always\(\)|cancelled\(\)|[a-zA-Z][\w.-]*|'[^'\n]*'|&&|\|\||==|[!()])/.exec(remaining);
    assert.ok(match, "unsupported gate token");
    tokens.push(match[0]);
    remaining = remaining.slice(match[0].length).trimStart();
  }
  const fields = new Set(["github.ref", "needs.main-paths.result", "needs.main-paths.outputs.eligible",
    "needs.cd-test-diagnostics.result", "always()", "cancelled()"]);
  let position = 0;
  function primary() {
    const token = tokens[position++];
    if (token === "!") { const child = primary(); return (input) => !child(input); }
    if (token === "(") {
      const child = binary(0);
      assert.equal(tokens[position++], ")", "unclosed gate group");
      return child;
    }
    if (token?.startsWith("'")) return () => token.slice(1, -1);
    assert.ok(fields.has(token), "unsupported gate field");
    return (input) => { assert.ok(Object.hasOwn(input, token), "missing gate input"); return input[token]; };
  }
  function binary(level) {
    if (level === 3) return primary();
    const operator = ["||", "&&", "=="][level];
    let left = binary(level + 1);
    while (tokens[position] === operator) {
      position++;
      const previous = left, right = binary(level + 1);
      left = operator === "||" ? (input) => previous(input) || right(input) :
        operator === "&&" ? (input) => previous(input) && right(input) : (input) => previous(input) === right(input);
    }
    return left;
  }
  const evaluate = binary(0);
  assert.equal(position, tokens.length, "unexpected trailing gate token");
  return evaluate;
}
