import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadNliContext } from "../nli-gateway.mjs";
import { expectationFor, loadTestCases, validateFixture } from "./test-fixtures.mjs";
import { runTestCase } from "./test-runner.mjs";
import { validateResult } from "./test-expectations.mjs";
import { createStageObserver } from "./test-observer.mjs";

const context = await loadNliContext();
const live = await loadTestCases("nli/live-test-cases.json");
const cascade = await loadTestCases("nli/cascade-test-cases.json");

test("all original 40 messages, order, scope and full local expectations survive migration", () => {
  const original = live.map(({ kind, message, currentTargetId, history, ...item }) => ({ kind, message, currentTargetId, history,
    expect: expectationFor(item, "local") }));
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"),
    "887ed679ee15c327bca0901fa7f00cc91bdebe3a77b3e01ad1cba45797dcb527");
  assert.equal(live.filter((item) => item.kind === "success").length, 26);
  for (const item of live) {
    for (const key of ["answerIncludes", "answerExcludes", "messageIncludes", "messageExcludes", "responseExcludes"]) {
      assert.deepEqual(item.expect[key], expectationFor(item, "local")[key], `${item.message}: ${key}`);
    }
    assert.deepEqual(expectationFor(item, "fake"), expectationFor(item, "live"));
  }
});

test("all live success proposals are accepted by actual cascade, never a legacy/local fallback", async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", () => { networkCalls += 1; throw new Error("network forbidden"); });
  for (const item of live.filter((entry) => entry.kind === "success")) {
    const fake = await runTestCase(item, context, { mode: "fake" });
    assert.deepEqual(fake.errors, [], item.message);
    assert.ok(["lfm", "fast_path", "security"].includes(fake.observations.stage), item.message);
    assert.equal(fake.observations.qwenCalls, 0, item.message);
    assert.equal(fake.observations.lfmCalls, fake.observations.stage === "lfm" ? 1 : 0, item.message);
    const local = await runTestCase(item, context, { mode: "local" });
    assert.deepEqual(local.errors, [], item.message);
  }
  assert.equal(networkCalls, 0);
});

test("actual fake counters agree independently with correlated transport observations", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("network forbidden"); });
  for (const item of cascade) {
    const run = await runTestCase(item, context, { mode: "fake" });
    assert.deepEqual(run.errors, [], item.id);
    const observer = createStageObserver();
    for (const event of run.events) observer.observer(event);
    assert.equal(observer.requestIds().length, 1);
    assert.deepEqual(observer.snapshot(observer.requestIds()[0]), run.observations, item.id);
    const bad = { ...item.expect, lfmCalls: run.observations.lfmCalls + 1 };
    assert.match(validateResult(run.result, bad, context, run.observations).join(), /lfmCalls/);
  }
});

test("exact IDs/order, source groups, allowed sources and exclusion checks are independent", async () => {
  const item = cascade.find((entry) => entry.id === "difficult-partial-escalation");
  const run = await runTestCase(item, context, { mode: "fake" });
  const check = (expect) => validateResult(run.result, expect, context, run.observations).join();
  assert.match(check({ ...item.expect, sourceIds: [...item.expect.sourceIds].reverse() }), /sourceIds/);
  assert.equal(check({ ...item.expect, sourceIds: undefined, sourceGroups: [["project-bookking-https"], ["project-catequest-n1"]] }), "");
  assert.match(check({ ...item.expect, sourceGroups: [["about"]] }), /sourceGroups/);
  assert.match(check({ ...item.expect, allowedSourceIds: ["project-catequest-n1"] }), /not allowed/);
  assert.match(check({ ...item.expect, answerExcludes: "Bookking" }), /should not include/);
  assert.match(check({ ...item.expect, responseExcludes: "project-bookking-https" }), /response should not include/);
});

test("fake model fixture shape and mutually exclusive legacy counters fail closed", () => {
  const item = cascade[0];
  for (const models of [{}, { ...item.models, other: {} }, { lfm: { failure: "typo" }, qwen: item.models.qwen },
    { lfm: { failure: "timeout", response: {} }, qwen: item.models.qwen }]) {
    assert.throws(() => validateFixture({ cases: [{ ...item, models }] }));
  }
  assert.throws(() => validateFixture({ cases: [{ ...item, model: {} }] }));
  assert.throws(() => validateFixture({ cases: [{ ...item, expect: { ...item.expect, modelCalls: 0 } }] }));
  assert.throws(() => validateFixture({ cases: [{ ...item, verification: true }] }));
});

test("same summary fixture has old local behavior and model-enabled fake/live behavior", async () => {
  const item = live.find((entry) => entry.message === "CateQuest 요약해줘");
  assert.equal((await runTestCase(item, context, { mode: "local" })).result.intent, "summarize_project");
  const fake = await runTestCase(item, context, { mode: "fake" });
  const observed = await runTestCase(item, context, { mode: "live" }, "http://unused.invalid", {
    fetch: async () => ({ ok: true, json: async () => fake.result }), observeCase: async () => fake.observations
  });
  assert.deepEqual(observed.errors, []);
  assert.equal(observed.result.intent, "answer_portfolio");
});

test("legacy modelCalls remains an actual invocation assertion, not a supplied expected count", async () => {
  const item = (await loadTestCases("nli/grounded-category-test-cases.json"))[0];
  const run = await runTestCase(item, context, { mode: "fake" });
  assert.deepEqual(run.errors, []);
  const changed = { ...item, expect: { ...item.expect, modelCalls: run.observations.modelCalls + 1 } };
  assert.match((await runTestCase(changed, context, { mode: "fake" })).errors.join(), /modelCalls expected/);
});
