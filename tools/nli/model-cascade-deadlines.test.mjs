import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModelCascade } from "./model-cascade.mjs";
import { config, comparison, proposal, inspected, request, harness } from "./model-cascade-fixtures.mjs";

test("already expired or disconnected request performs zero calls", async () => {
  const h = harness();
  const cascade = createModelCascade(config, h.dependencies);
  for (const extras of [{ deadlineAt: 0 }, { deadlineAt: 1000 }, { signal: AbortSignal.abort() }]) {
    assert.equal((await cascade.resolve(request(comparison, extras))).stage, "upstream_error");
  }
  assert.equal(h.calls.lfm.length + h.calls.qwen.length + h.calls.verify.length, 0);
});

test("clock advancing past parent deadline discards accepted LFM, precludes Qwen", async () => {
  const h = harness();
  h.dependencies.lfmClient = async () => { h.setTime(13000); return inspected("lfm", proposal()); };
  const result = await createModelCascade(config, h.dependencies).resolve(request());
  assert.deepEqual(result, { stage: "upstream_error", reason: "deadline_exhausted" });
  assert.equal(h.calls.qwen.length + h.calls.verify.length, 0);
});

test("signal-ignoring late accepted injected client cannot escape cancellation", async () => {
  let finish;
  let stageSignal;
  const h = harness({ now: () => performance.now(), lfmClient: (...args) => {
    stageSignal = args[3].signal;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const controller = new AbortController();
  const pending = createModelCascade(config, h.dependencies).resolve(request(comparison, {
    signal: controller.signal, deadlineAt: performance.now() + 13000
  }));
  await delay(0);
  controller.abort();
  assert.deepEqual(await pending, { stage: "upstream_error", reason: "aborted" });
  assert.equal(stageSignal.aborted, true);
  finish(inspected("lfm", proposal()));
  await delay(0);
  assert.equal(h.calls.qwen.length + h.calls.verify.length, 0);
  assert.ok(!h.calls.events.some((event) => event.reason === "accepted"));
});

test("real stage timer bounds an injected never-settling client", async () => {
  let signal;
  const h = harness({ now: () => performance.now(), lfmClient: (...args) => {
    signal = args[3].signal;
    return new Promise(() => {});
  } });
  const start = performance.now();
  const result = await createModelCascade({ ...config, lfm: { ...config.lfm, timeoutMs: 25 } }, h.dependencies)
    .resolve(request("P95가 뭐야?", { deadlineAt: start + 13000 }));
  assert.equal(result.stage, "upstream_error");
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - start < 1500);
});

test("Qwen late acceptance and aborting metadata cannot dispatch or accept afterward", async () => {
  const h = harness();
  h.dependencies.qwenClient = async () => { h.setTime(16001); return inspected("qwen", proposal()); };
  assert.equal((await createModelCascade(config, h.dependencies).resolve(request())).stage, "upstream_error");
  const controller = new AbortController();
  h.setTime(0);
  h.dependencies.verifier.verify = async () => { controller.abort(); return { ok: true, returnedModelId: "fixture-qwen" }; };
  assert.equal((await createModelCascade(config, h.dependencies).resolve(request(comparison, { signal: controller.signal }))).reason, "aborted");
});

test("observer exceptions cannot change a decision; bare candidates are not successes", async () => {
  const h = harness({ observer() { throw new Error("do not reflect"); }, lfmClient: async () => proposal() });
  const result = await createModelCascade(config, h.dependencies).resolve(request());
  assert.equal(result.stage, "qwen");
  assert.equal(h.calls.qwen.length, 1);
});

test("LFM elapsed time and metadata consume total once, Qwen keeps its 16s cap", async () => {
  const h = harness();
  h.dependencies.lfmClient = async () => { h.setTime(3999); return inspected("lfm", { intent: "reject_out_of_scope", confidence: 1 }); };
  h.dependencies.verifier.verify = async (options) => {
    h.calls.verify.push(options);
    h.setTime(4899);
    return { ok: true, returnedModelId: "fixture-qwen" };
  };
  const result = await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: 21000 }));
  assert.equal(result.stage, "qwen");
  assert.equal(h.calls.verify[0].deadlineAt, 19999);
  assert.equal(h.calls.qwen[0][3].deadlineAt, 19999);
  assert.equal(h.calls.qwen[0][3].budgetMs, 15100);
});

test("capacity filled after LFM prevents even verification without acquiring an outer lease", async () => {
  const releases = [];
  // Fill at acceptance observation, after the real LFM adapter has settled.
  const blocked = harness({ observer(event) {
    if (event.type === "acceptance") for (let n = 0; n < 4; n += 1) releases.push(cascade2.admission.acquire("held"));
  } });
  const cascade2 = createModelCascade(config, blocked.dependencies);
  assert.equal((await cascade2.resolve(request())).reason, "busy");
  assert.equal(blocked.calls.verify.length + blocked.calls.qwen.length, 0);
  releases.forEach((release) => release());
  assert.equal(cascade2.admission.active, 0);
});

test("impossible coverage clarifies without Qwen and mutable preparation is a caller error", async () => {
  const h = harness();
  const cascade = createModelCascade(config, h.dependencies);
  const input = request();
  const impossible = Object.freeze({ ...input.prepared, coveragePossible: false,
    obligations: Object.freeze({ ...input.prepared.obligations, coveragePossible: false }) });
  assert.equal((await cascade.resolve({ ...input, prepared: impossible })).stage, "clarification");
  assert.equal(h.calls.verify.length + h.calls.qwen.length, 0);
  await assert.rejects(cascade.resolve({ ...input, prepared: { ...input.prepared } }), TypeError);
  await assert.rejects(cascade.resolve({ ...input, deadlineAt: undefined }), TypeError);
});

test("in-flight verification cannot reopen a process invalidated by another request", async () => {
  const h = harness();
  let releaseGate;
  let verificationCalls = 0;
  h.dependencies.verifier.verify = async () => {
    verificationCalls += 1;
    if (verificationCalls === 1) return new Promise((resolve) => { releaseGate = resolve; });
    return { ok: true, returnedModelId: "fixture-qwen" };
  };
  h.dependencies.qwenClient = async (...args) => {
    h.calls.qwen.push(args);
    return inspected("qwen", proposal(), "changed");
  };
  const cascade = createModelCascade(config, h.dependencies);
  const pending = cascade.resolve(request());
  await delay(0);
  assert.equal((await cascade.resolve(request())).reason, "model_mismatch");
  releaseGate({ ok: true, returnedModelId: "fixture-qwen" });
  assert.equal((await pending).reason, "qwen_unverified");
  assert.equal(h.calls.qwen.length, 1);
  assert.equal(h.calls.invalidations, 1);
});

test("total expiry in metadata prevents Qwen even if an injected gate claims success", async () => {
  const h = harness();
  h.dependencies.verifier.verify = async () => { h.setTime(13000); return { ok: true, returnedModelId: "fixture-qwen" }; };
  const result = await createModelCascade(config, h.dependencies).resolve(request());
  assert.deepEqual(result, { stage: "upstream_error", reason: "deadline_exhausted" });
  assert.equal(h.calls.qwen.length, 0);
});
