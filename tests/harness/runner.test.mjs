import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runNode, runPlaywright, inspectReports } from "../../tools/testing/runner.mjs";
import { execute, testEnvironment } from "../../tools/testing/process.mjs";
import { fixtureCli, fixtureDirectory, syntheticReports } from "../../tools/testing/harness-fixture.mjs";
import { cancellationFixture } from "../../tools/testing/cancellation-fixture.mjs";

const cli = new URL("../../tools/test-harness.mjs", import.meta.url).pathname;
for (const args of [["run", "--unknown"], ["run", "--all", "--runner", "node"],
  ["run", "--level", "unit", "--runner", "playwright"]]) {
  test(`CLI rejects ${args.join(" ")} with a nonzero process exit`, () => {
    // Given / When
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: testEnvironment() });
    // Then
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Test harness:/);
  });
}

for (const [name, source, expected] of [
  ["passing", 'import test from "node:test"; test("ok", () => {});', true],
  ["failing", 'import test from "node:test"; test("bad", () => { throw Error("fixture"); });', false],
  ["skipped", 'import test from "node:test"; test.skip("skip", () => {});', false],
  ["todo", 'import test from "node:test"; test.todo("later");', false],
  ["empty", "", false],
  ["cancelled", 'import test from "node:test";test("cancel",{timeout:30},async t=>{const h=setInterval(()=>{},1000);t.after(()=>clearInterval(h));await new Promise(()=>{})});', false],
  ["exited", "process.exit(9);", false],
  ["killed", 'process.kill(process.pid, "SIGTERM");', false],
  ["caught egress", 'import test from "node:test"; test("caught", async () => { await fetch("http://192.0.2.1").catch(() => {}); });', false],
  ["child egress", `import test from 'node:test'; import {spawnSync} from 'node:child_process'; test('child',()=>{spawnSync(process.execPath,['-e',${JSON.stringify('fetch("http://192.0.2.1").catch(()=>{})')}],{env:{}});});`, false]
]) test(`native runner reports failure truthfully when fixture is ${name}`, async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fixture.test.mjs");
  await writeFile(file, source);
  // When
  const result = await runNode([file], { cwd: root, outDir: join(root, "reports") });
  // Then
  assert.equal(result.ok, expected, JSON.stringify(result));
  if (name === "cancelled") {
    assert.equal(result.counts.cancelled, 1);
    assert.equal(result.counts.failed, 0);
    assert.equal(result.exitCode, 1);
  }
  if (name === "caught egress" || name === "child egress") {
    assert.equal(result.exitCode, 0, "native tests passed despite the caught request error");
    assert.equal(result.counts.passed, 1);
    assert.ok(result.violations > 0, "out-of-band evidence must override native success");
  }
  if (expected) {
    assert.equal(result.counts.passed, 1);
    assert.match(await readFile(join(result.directory, "junit.xml"), "utf8"), /<testsuites/);
    assert.match(await readFile(join(result.directory, "lcov.info"), "utf8"), /SF:/);
  }
});
test("actual relative-catalog CLI rejects an empty file instead of counting its wrapper", async (t) => {
  const { result, summary } = await fixtureCli(t, "");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(summary.ok, false);
  assert.equal(summary.results[0].counts.tests, 0);
});
test("actual CLI preserves registered path-named and nested tests", async (t) => {
  const { result, summary } = await fixtureCli(t, `import {test,describe,it} from 'node:test';
    test('tests/fixture.test.mjs',()=>{});
    test(import.meta.filename,()=>{});
    test('parent',async t=>{await t.test('child',()=>{})});
    describe('suite',()=>it('leaf',()=>{}));`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(summary.results[0].counts.passed, 5);
});
for (const runner of ["node", "playwright"]) for (const [name, xml] of [
  ["malformed", "<testsuites><broken></testsuites>"],
  ["truncated", "<testsuites><testcase name='ok'>"],
  ["unknown structure", "<testsuites><broken/></testsuites>"],
  ["empty structure", "<testsuites/>"],
  ["inconsistent tests", "<testsuites tests='9' failures='0' skipped='0' errors='0'><testsuite name='suite' tests='1' failures='0' errors='0' skipped='0'><testcase name='ok'/></testsuite></testsuites>"],
  ["inconsistent outcome", "<testsuites tests='1' failures='0' skipped='0' errors='0'><testsuite name='suite' tests='1' failures='0' errors='0' skipped='0'><testcase name='bad'><failure/></testcase></testsuite></testsuites>"]
]) test(`${runner} rejects ${name} native JUnit`, async (t) => {
  const root = await syntheticReports(t, xml, runner);
  await assert.rejects(inspectReports(root, runner));
});
test("rejects mutations of a real native report with its complete original event metadata", async (t) => {
  const root = await fixtureDirectory(t);
  await writeFile(join(root, "fixture.test.mjs"), 'import test from "node:test";test("ok",()=>{});');
  const result = await runNode(["fixture.test.mjs"], { cwd: root, outDir: root });
  assert.equal(result.ok, true);
  const file = join(result.directory, "junit.xml");
  const original = await readFile(file, "utf8");
  for (const xml of ["<testsuites><broken></testsuites>", original.slice(0, -20),
    original.replace('<testcase name="ok"', '<testcase name="different"'),
    original.replace("<testsuites>", '<testsuites tests="99">'),
    original.replace('/>', '><failure message="bad"/></testcase>')]) {
    await writeFile(file, xml);
    await assert.rejects(inspectReports(result.directory, "node"));
  }
  await writeFile(file, original);
  assert.equal((await inspectReports(result.directory, "node")).passed, 1);
});
test("rejects an empty selected file even when another selected file has tests", async (t) => {
  const root = await fixtureDirectory(t);
  await writeFile(join(root, "empty.test.mjs"), "");
  await writeFile(join(root, "ok.test.mjs"), 'import test from "node:test";test("ok",()=>{});');
  const result = await runNode(["empty.test.mjs", "ok.test.mjs"], { cwd: root, outDir: root });
  assert.equal(result.ok, false);
  assert.equal(result.counts.passed, 1);
  assert.match(result.infrastructureError, /zero tests/);
});
test("rejects reports when native artifacts are missing", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // When / Then
  await assert.rejects(inspectReports(root, "node"));
});
test("rejects inconsistent counts when a structured report is corrupted", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-corrupt-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "junit.xml"), "<testsuites></testsuites>");
  await writeFile(join(root, "lcov.info"), "SF:fixture.mjs\nend_of_record\n");
  await writeFile(join(root, "counts.json"), JSON.stringify({ tests: 2, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }));
  // When / Then
  await assert.rejects(inspectReports(root, "node"), /counts/);
});
test("fails browser prerequisites when the local package is absent", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-prerequisite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // When
  const result = await runPlaywright(["absent.spec.mjs"], { cwd: root, outDir: root });
  // Then
  assert.equal(result.ok, false);
  assert.match(result.infrastructureError, /prerequisite/);
});
test("fails infrastructure when a process cannot be spawned", async () => {
  // Given / When
  const result = await execute("/nonexistent/harness-executable", [], { env: testEnvironment() });
  // Then
  assert.equal(result.code, null);
  assert.equal(result.error, "ENOENT");
});
test("kills a hanging process group when its deadline expires", async () => {
  // Given / When
  const result = await execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: testEnvironment(), timeout: 200 });
  // Then
  assert.equal(result.interrupted, true);
  assert.equal(result.signal, "SIGTERM");
});
test("forwards cancellation when the orchestrator receives SIGTERM", async () => {
  // Given
  const module = new URL("../../tools/testing/process.mjs", import.meta.url).href;
  const source = `import {execute,testEnvironment} from ${JSON.stringify(module)}; const r=await execute(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000)'],{env:testEnvironment(),stream:true}); console.log(JSON.stringify(r));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: testEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let sent = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  // When
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!sent && output.includes("READY")) { sent = true; child.kill("SIGTERM"); }
  });
  try {
    await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    // Then
    assert.equal(sent, true);
    assert.match(output, /"interrupted":true/);
    assert.match(output, /"signal":"SIGTERM"/);
  } finally { clearTimeout(timer); }
});
for (const mode of ["timeout", "SIGTERM", "SIGINT", "force"]) {
  test(`nested execute descendants terminate and cleanup when cancellation is ${mode}`, async (t) => {
    const outcome = await cancellationFixture(t, mode);
    assert.equal(outcome.result.interrupted, true);
    assert.equal(outcome.alive, false, "grandchild must not survive outer cancellation");
    if (mode !== "force") {
      assert.equal(outcome.leafTempExists, false, "leaf signal cleanup must run before escalation");
      assert.equal(outcome.ownerTempExists, false, "owner finally cleanup must run before escalation");
    }
  });
}
