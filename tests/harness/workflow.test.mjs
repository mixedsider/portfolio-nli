import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);
const source = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const required = ["check", "node-unit", "node-integration", "browser"];
const commands = {
  check: "mkdir -p test-results/check\npnpm test:check 2>&1 | tee test-results/check/check.log\n",
  "node-unit": "node tools/test-harness.mjs run --level unit --runner node --out-dir test-results/node-unit",
  "node-integration": "node tools/test-harness.mjs run --level integration --runner node --out-dir test-results/node-integration",
  browser: "node tools/test-harness.mjs run --runner playwright --out-dir test-results/browser",
};

function workflow() {
  const document = parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS();
}

function contract(value) {
  assert.equal(value.name, "CI");
  assert.deepEqual(Object.keys(value.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  for (const event of Object.values(value.on)) assert.ok(event === null || Object.keys(event).length === 0);
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.defaults, { run: { shell: "bash" } });
  assert.equal(value.concurrency.group, "${{ github.workflow }}-${{ github.ref }}");
  assert.equal(value.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(value.jobs).sort(), [...required, "verify"].sort());
  assert.doesNotMatch(JSON.stringify(value), /secrets\s*[.\[]|pull_request_target|workflow_run|192\.168\.|--live/);
  const names = [];
  for (const [id, job] of Object.entries(value.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job.permissions, undefined);
    assert.equal(job["continue-on-error"], undefined);
    assert.equal(job.strategy, undefined, "Explicit lanes must not acquire duplicate technique matrix jobs");
    assert.equal(job.environment, undefined);
    assert.equal(job.services, undefined);
    assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30);
    for (const step of job.steps) {
      assert.equal(step["continue-on-error"], undefined);
      if (step.run) assert.doesNotMatch(step.run, /\|\|\s*true|set\s+\+e|exit\s+0/);
    }
    if (id === "verify") continue;
    assert.equal(job.if, undefined, "Required lanes cannot conditionally skip");
    assert.deepEqual(job.needs, id === "check" ? undefined : "check");
    assert.equal(job.steps[0].uses, "actions/checkout@v4");
    assert.equal(job.steps[0].with["persist-credentials"], false);
    const node = job.steps.find((step) => step.uses === "actions/setup-node@v4");
    assert.equal(String(node?.with["node-version"]), "24");
    const pnpm = job.steps.find((step) => step.uses === "pnpm/action-setup@v4");
    assert.ok(pnpm);
    assert.equal(pnpm.with?.version, undefined, "Read pinned packageManager rather than a second version");
    assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
    const execute = job.steps.find((step) => step.run === commands[id]);
    assert.ok(execute, `Missing CLI contract for ${id}`);
    assert.equal(execute.if, undefined);
    const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(uploads.length, 1);
    const upload = uploads[0];
    assert.equal(upload.uses, "actions/upload-artifact@v7");
    assert.equal(upload.if, "${{ always() }}");
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["include-hidden-files"], false);
    assert.ok(upload.with["retention-days"] > 0 && upload.with["retention-days"] <= 30);
    assert.equal(upload.with.name, `ci-${id}-\${{ github.run_id }}-\${{ github.run_attempt }}`);
    names.push(upload.with.name);
    assert.deepEqual(upload.with.path.trim().split("\n"), [
      `test-results/${id}/`, "playwright-report/", "coverage/",
    ]);
    for (const step of job.steps) {
      if (step !== upload) assert.equal(step.if, undefined);
    }
  }
  assert.equal(new Set(names).size, required.length);
  const browser = value.jobs.browser.steps;
  const install = browser.findIndex((step) => step.run === "pnpm exec playwright install --with-deps chromium");
  assert.ok(install >= 0 && install < browser.findIndex((step) => step.run === commands.browser));
  assert.ok(!browser.some((step) => step.uses?.startsWith("actions/cache@")));
  const verify = value.jobs.verify;
  assert.equal(verify.name, "Verify portfolio");
  assert.equal(verify.if, "${{ always() }}");
  assert.deepEqual([...verify.needs].sort(), [...required].sort());
  assert.equal(verify.steps.length, 1);
  assert.deepEqual(verify.steps[0].env, Object.fromEntries(required.map((id) => [
    id.replaceAll("-", "_").toUpperCase(), `\${{ needs['${id}'].result }}`,
  ])));
  assert.equal(verify.steps[0].if, undefined);
  assert.equal(verify.steps[0].shell, "bash");
}

test("hosted CI satisfies parsed workflow contract when loaded from disk", () => {
  // Given / When
  const value = workflow();
  // Then
  contract(value);
});

for (const [label, mutate] of [
  ["branch filter", (value) => { value.on.push = { branches: ["main"] }; }],
  ["self-hosted PR runner", (value) => { value.jobs.check["runs-on"] = ["self-hosted"]; }],
  ["continue-on-error", (value) => { value.jobs["node-unit"]["continue-on-error"] = true; }],
  ["missing required job", (value) => { value.jobs.verify.needs.pop(); }],
  ["required job skip", (value) => { value.jobs.browser.if = "${{ false }}"; }],
  ["conditional test skip", (value) => { value.jobs.browser.steps.find((step) => step.run === commands.browser).if = "${{ false }}"; }],
  ["missing artifact ignored", (value) => { value.jobs.browser.steps.at(-1).with["if-no-files-found"] = "ignore"; }],
]) {
  test(`contract rejects ${label} when workflow is mutated in memory`, () => {
    // Given
    const value = workflow();
    contract(value);
    // When
    mutate(value);
    // Then
    assert.throws(() => contract(value), assert.AssertionError);
  });
}

test("aggregate rejects every failed or skipped dependency when its real shell runs", () => {
  // Given
  const step = workflow().jobs.verify.steps[0];
  const success = Object.fromEntries(required.map((id) => [id.replaceAll("-", "_").toUpperCase(), "success"]));
  // When
  const passing = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], { env: { ...process.env, ...success } });
  // Then
  assert.equal(passing.status, 0, passing.stderr?.toString());
  for (const key of Object.keys(success)) for (const state of ["failure", "cancelled", "skipped", ""]) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
      env: { ...process.env, ...success, [key]: state },
    });
    assert.equal(result.status, 1, `${key}=${state} must fail`);
  }
});

test("workflow scripts have valid Bash syntax when expressions are environment-only", () => {
  // Given
  const steps = Object.values(workflow().jobs).flatMap((job) => job.steps).filter((step) => step.run);
  // When / Then
  for (const step of steps) {
    const result = spawnSync("bash", ["-n"], { input: step.run });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
});

test("package scripts match harness filters when the pinned manifest is loaded", () => {
  // Given
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const prefix = "node tools/test-harness.mjs ";
  const expected = { test: "run --all", "test:ci": "run --all", "test:check": "check", "test:list": "list" };
  for (const level of ["unit", "integration", "e2e"]) expected[`test:${level}`] = `run --level ${level}`;
  for (const technique of ["blackbox", "whitebox"]) expected[`test:${technique}`] = `run --technique ${technique}`;
  expected["test:node"] = "run --runner node";
  expected["test:browser"] = "run --runner playwright";
  // When / Then
  for (const [name, suffix] of Object.entries(expected)) assert.equal(manifest.scripts[name], prefix + suffix);
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\..+)?$/);
});
