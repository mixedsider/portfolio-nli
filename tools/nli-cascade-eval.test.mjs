import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, parseEvalArgs } from "./nli-cascade-eval.mjs";
import { assessSuite, distribution, readyVerdict } from "./nli/eval-report.mjs";

test("CLI requires an exclusive output and rejects unknown/duplicate arguments", async () => {
  for (const args of [[], ["--output"], ["--output", "x", "--output", "y"], ["--relax", "1"]]) {
    assert.throws(() => parseEvalArgs(args));
  }
  const directory = await mkdtemp(join(tmpdir(), "eval-cli-"));
  const output = join(directory, "report.json");
  let calls = 0;
  try {
    assert.equal(await main(["--output", output], { evaluate: async () => { calls++; return { ready: false }; } }), 1);
    await assert.rejects(main(["--output", output], { evaluate: async () => { calls++; } }));
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(output, "utf8")).ready, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("empty, unobserved, HTTP/subprocess and cleanup failures cannot pass", () => {
  const row = { stage: "lfm", reason: "accepted", lfmCalls: 1, qwenCalls: 0 };
  const child = { code: 0, stdout: "NLI tests passed: 1/1 passed (100.0%)", stderr: "" };
  assert.equal(assessSuite(child, [row], 1).ok, true);
  for (const [result, rows, count] of [[child, [], 0], [child, [{}], 1], [{ ...child, code: 1 }, [row], 1],
    [{ ...child, stdout: "" }, [row], 1], [{ ...child, stdout: "NLI tests failed: 0/1 passed (0.0%)" }, [row], 1]]) {
    assert.equal(assessSuite(result, rows, count).ok, false);
  }
  assert.equal(readyVerdict({}).ready, false);
  assert.equal(readyVerdict({ cleanup: false }).ready, false);
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null });
  assert.deepEqual(distribution([4, 1, 3, 2]), { count: 4, p50: 2, p95: 4 });
});

test("evaluator exceptions persist a non-ready report, never an empty success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-error-"));
  const output = join(directory, "report.json");
  try {
    assert.equal(await main(["--output", output], { evaluate: async () => { throw new Error("cleanup failed"); } }), 1);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.ready, false);
    assert.equal(report.status, "activation-blocked");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a bare ready flag without complete gates cannot create a successful report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-empty-"));
  try {
    assert.equal(await main(["--output", join(directory, "report.json")], {
      evaluate: async () => ({ ready: true, results: [] })
    }), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
