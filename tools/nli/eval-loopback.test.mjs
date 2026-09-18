import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evalFixture } from "./eval-fixture.mjs";
import { runChild, runFixtureSuite } from "./eval-suites.mjs";
import { ordinaryCases, runWorkload } from "./eval-workloads.mjs";
import { createEvalSession } from "./eval-session.mjs";
import { requestLiveNli } from "./test-runner.mjs";
import { comparison } from "./model-cascade-fixtures.mjs";

test("spawned evaluator CLI uses real detailed HTTP clients and fails closed without verify reports", async () => {
  const f = await evalFixture();
  try {
    const output = join(f.directory, "evaluation.json");
    const child = await runChild(["tools/nli-cascade-eval.mjs", "--output", output], {
      timeout: 60000, env: { ...process.env, ...f.env }
    });
    assert.equal(child.code, 1);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.ready, false);
    assert.equal(report.success.ok, true);
    assert.equal(report.success.rows.length, 26);
    assert.equal(report.adversarial.ok, true, "task4 fix3 restores correct unsupported-project rejection");
    assert.match(report.adversarial.child.stdout, /10\/10 passed/);
    assert.equal(report.adversarial.rows[3].stage, "lfm");
    assert.equal(report.adversarial.rows[3].reason, "accepted");
    assert.equal(report.adversarial.rows[3].lfmCalls, 1);
    assert.equal(report.adversarial.rows[3].qwenCalls, 0);
    assert.equal(report.warm.ok, true);
    assert.equal(report.gates.ordinary, false, "one diagnostic repeat cannot pass three-repeat gate");
    assert.equal(report.gates.cleanup, true);
    assert.ok(report.success.rows.every((row) => row.stage === "lfm" && row.lfmCalls === 1 && row.qwenCalls === 0));
    assert.ok(report.success.rows.every((row) => row.transports[0].dispatchCount === 1 && row.transports[0].requestBytes > 100));
    assert.ok(f.state.calls.filter((call) => call.runtime && call.endpoint === "lfm").length >= 26);
    const duplicate = await runChild(["tools/nli-cascade-eval.mjs", "--output", output], { env: { ...process.env, ...f.env } });
    assert.equal(duplicate.code, 1);
    assert.ok(!JSON.stringify(report).includes("NEVER_PERSIST_HIDDEN"));
  } finally { await f.close(); }
  await assert.rejects(access(f.directory));
});

test("three warm repeats, concurrent UUID correlation and real-verifier injected escalation", async () => {
  const f = await evalFixture();
  try {
    f.state.delayMs = 25;
    const ordinary = ordinaryCases(f.cases);
    const warm = await runWorkload(f.config, f.context, ordinary, { repeats: 3, concurrency: 4 });
    assert.equal(warm.ok, true);
    assert.equal(warm.results.length, 18);
    assert.equal(new Set(warm.results.map((row) => row.requestId)).size, 18);
    assert.equal(warm.maxActive, 4);
    assert.equal(warm.cleanup.active, 0);
    const item = { id: "comparison", kind: "success", message: comparison, expect: { intent: "answer_portfolio" } };
    const injected = await runWorkload(f.config, f.context, [item], { repeats: 1, injectLfm: true });
    assert.equal(injected.ok, true);
    assert.deepEqual([injected.results[0].lfmCalls, injected.results[0].qwenCalls], [1, 1]);
    assert.match(injected.results[0].injection, /synthetic-first-stage/);
    assert.equal(injected.gateChecks[0].metadataCalls, 19);
    const complete = await runWorkload(f.config, f.context, [item], { repeats: 1 });
    assert.equal(complete.ok, true);
    assert.equal(complete.results[0].qwenCalls, 0);
  } finally { await f.close(); }
});

test("HTTP failure, real no-thinking invalidation and cleanup cannot masquerade as success", async () => {
  const f = await evalFixture();
  try {
    f.state.status = 503;
    const failed = await runWorkload(f.config, f.context, ordinaryCases(f.cases), { repeats: 1 });
    assert.equal(failed.ok, false);
    assert.ok(failed.results.every((row) => row.transports[0].status === 503 && row.lfmCalls === 1));
    f.state.status = 200;
    f.state.reasoning = true;
    const item = { id: "comparison", kind: "success", message: comparison, expect: { intent: "answer_portfolio" } };
    const session = await createEvalSession(f.config, f.context, [item], { injectLfm: true });
    try {
      await assert.rejects(requestLiveNli(item, `${session.url}/api/nli`), /HTTP 503/);
      await session.settle();
      assert.equal(session.rows()[0].qwenCalls, 1);
      await assert.rejects(requestLiveNli(item, `${session.url}/api/nli`), /HTTP 503/);
      await session.settle();
      assert.equal(session.rows()[1].qwenCalls, 0);
      assert.equal(session.rows()[1].reason, "qwen_unverified");
      assert.equal(session.gateChecks.length, 1, "cascade closes eligibility before second verification");
      assert.ok(!JSON.stringify(session.rows()).includes("NEVER_PERSIST_HIDDEN"));
    } finally { assert.equal((await session.close()).ok, true); }
    const rows = [{ stage: "lfm", lfmCalls: 1, qwenCalls: 0 }];
    await assert.rejects(runFixtureSuite(f.config, f.context, [item], "unused", null, {
      createSession: async () => ({ url: "http://127.0.0.1:1", settle: async () => {}, rows: () => rows,
        faults: [], http: [{ status: 200 }], close: async () => { throw new Error("cleanup failed"); } }),
      runChild: async () => ({ code: 0, stdout: "NLI tests passed: 1/1 passed (100.0%)", stderr: "" })
    }), /cleanup failed/);
  } finally { await f.close(); }
});
