import assert from "node:assert/strict";
import test from "node:test";
import { createModelCascade } from "./model-cascade.mjs";
import { comparison, context, request } from "./model-cascade-fixtures.mjs";
import { loopbackFixture, until } from "./model-cascade-loopback.mjs";

const liveRequest = (message = comparison, extras = {}) => request(message, { deadlineAt: performance.now() + 13000, ...extras });

test("two real endpoints and real metadata gate: original payload, 19 calls, no double acquisition", async (t) => {
  const f = await loopbackFixture({ maxConcurrentRequests: 1 });
  t.after(f.close);
  const events = [];
  const cascade = createModelCascade(f.config, { context, observer: (event) => events.push(event) });
  const input = liveRequest();
  assert.equal((await cascade.resolve(input)).stage, "qwen");
  assert.equal(f.calls("lfm").length, 1);
  assert.equal(f.calls("qwen").length, 1);
  assert.equal(f.calls("qwen", "/props").length, 1);
  assert.equal(f.calls("qwen", "/apply-template").length, 18);
  const lfm = f.calls("lfm")[0].payload;
  const qwen = f.calls("qwen")[0].payload;
  assert.deepEqual(lfm.messages, qwen.messages);
  assert.equal(qwen.messages[2].content, comparison);
  assert.equal(qwen.messages[1].content, input.prepared.groundedRequestBlock);
  assert.equal(lfm.max_tokens, 512);
  assert.equal(qwen.max_tokens, 768);
  assert.equal(qwen.reasoning_effort, "none");
  assert.deepEqual(qwen.chat_template_kwargs, { enable_thinking: false });
  assert.equal(cascade.admission.active, 0);
  assert.equal(f.state.maxActive, 1);
  assert.ok(!JSON.stringify(events).includes("CateQuest"));
});

test("shared active4 includes real verifier metadata; fifth fails with no Qwen and all leases recover", async (t) => {
  const f = await loopbackFixture();
  t.after(f.close);
  const cascade = createModelCascade(f.config, { context });
  let releaseProps;
  let releaseLfm;
  f.state.propsHold = new Promise((resolve) => { releaseProps = resolve; });
  const comparisonPending = cascade.resolve(liveRequest());
  await until(() => f.calls("qwen", "/props").length === 1);
  f.state.lfmHold = new Promise((resolve) => { releaseLfm = resolve; });
  const ordinary = Array.from({ length: 3 }, () => cascade.resolve(liveRequest("P95가 뭐야?")));
  await until(() => f.calls("lfm").length === 4);
  assert.equal(cascade.admission.active, 4);
  const rejected = await cascade.resolve(liveRequest());
  assert.deepEqual(rejected, { stage: "upstream_error", reason: "busy" });
  assert.equal(f.calls("lfm").length, 4);
  assert.equal(f.calls("qwen").length, 0);
  releaseLfm();
  releaseProps();
  assert.ok((await Promise.all(ordinary)).every((result) => result.stage === "lfm"));
  assert.equal((await comparisonPending).stage, "qwen");
  assert.equal(cascade.admission.active, 0);
  assert.equal(f.state.maxActive, 4);
});

test("real changed model permanently invalidates factory verifier without metadata on next request", async (t) => {
  const f = await loopbackFixture();
  t.after(f.close);
  const cascade = createModelCascade(f.config, { context });
  f.state.model = "changed-model";
  assert.equal((await cascade.resolve(liveRequest())).reason, "model_mismatch");
  f.state.model = "fixture-qwen";
  assert.equal((await cascade.resolve(liveRequest())).reason, "qwen_unverified");
  assert.equal(f.calls("qwen").length, 1);
  assert.equal(f.calls("qwen", "/props").length, 1);
  assert.equal(cascade.admission.active, 0);
});

test("real disconnect aborts held LFM and releases admission with zero metadata/Qwen", async (t) => {
  const f = await loopbackFixture();
  t.after(f.close);
  const cascade = createModelCascade(f.config, { context });
  let release;
  f.state.lfmHold = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const pending = cascade.resolve(liveRequest(comparison, { signal: controller.signal }));
  await until(() => f.calls("lfm").length === 1);
  controller.abort();
  assert.equal((await pending).reason, "aborted");
  await until(() => cascade.admission.active === 0);
  release();
  assert.equal(f.calls("qwen").length + f.calls("qwen", "/props").length, 0);
});

test("real LFM timeout releases the sole permit before metadata and Qwen dispatch", async (t) => {
  const f = await loopbackFixture({ maxConcurrentRequests: 1 });
  t.after(f.close);
  let release;
  f.state.lfmHold = new Promise((resolve) => { release = resolve; });
  const cascade = createModelCascade({ ...f.config, lfm: { ...f.config.lfm, timeoutMs: 80 } }, { context });
  try {
    assert.equal((await cascade.resolve(liveRequest())).stage, "qwen");
    assert.equal(f.calls("lfm").length, 1);
    assert.equal(f.calls("qwen").length, 1);
    assert.equal(cascade.admission.active, 0);
  } finally {
    release();
  }
});
