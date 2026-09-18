import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_GATES, readyVerdict } from "./eval-report.mjs";
import { summarizeCommand, summarizeEvaluation } from "./eval-inspect.mjs";
import { readFile, readdir } from "node:fs/promises";
import { runChild } from "./eval-suites.mjs";

test("every required gate must explicitly pass; missing/false/unknown gates block readiness", () => {
  const gates = Object.fromEntries(REQUIRED_GATES.map((key) => [key, true]));
  assert.equal(readyVerdict(gates).ready, true);
  for (const key of REQUIRED_GATES) {
    for (const value of [false, undefined, null, "true", 1]) {
      assert.deepEqual(readyVerdict({ ...gates, [key]: value }).blockers, [key]);
    }
  }
});

test("all task12 modules stay at most 250 physical lines and pass Node syntax checks", async () => {
  const files = ["tools/nli-cascade-eval.mjs", "tools/nli-cascade-eval.test.mjs",
    ...(await readdir(new URL("./", import.meta.url))).filter((name) => /^eval-.*\.mjs$/.test(name)).map((name) => `tools/nli/${name}`)];
  for (const file of files) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    const count = source.trimEnd().split("\n").length;
    assert.ok(count <= 250, `${file}: ${count} physical lines`);
    const child = await runChild(["--check", file]);
    assert.equal(child.code, 0, `${file}: ${child.stderr}`);
  }
});

test("report-only inspection retains actual failures and refuses missing input", () => {
  assert.throws(() => summarizeEvaluation({}));
  assert.throws(() => summarizeCommand({}));
  const summary = summarizeCommand({ code: 1, stdout: "# tests 4\n# pass 3\n# fail 1\n# skipped 0\n",
    stderr: "NLI tests failed: 3/4 passed (75.0%)\n" });
  assert.equal(summary.code, 1);
  assert.deepEqual(summary.tests, ["# tests 4", "# pass 3", "# fail 1", "# skipped 0"]);
  assert.deepEqual(summary.fixtureSummary, ["NLI tests failed: 3/4 passed (75.0%)"]);
});
