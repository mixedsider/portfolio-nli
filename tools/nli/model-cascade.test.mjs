import assert from "node:assert/strict";
import test from "node:test";
import { createModelCascade } from "./model-cascade.mjs";
import { resolveLocally } from "./router.mjs";
import { config, context, comparison, proposal, partial, inspected, failed, request, harness } from "./model-cascade-fixtures.mjs";

test("low-confidence complete LFM wins ordinary and difficult requests", async () => {
  for (const [message, candidate] of [[comparison, proposal()], ["P95가 뭐야?", { intent: "define_term", term: "P95", confidence: 0.01 }]]) {
    const h = harness({ lfmClient: async () => inspected("lfm", candidate) });
    const result = await createModelCascade(config, h.dependencies).resolve(request(message));
    assert.equal(result.stage, "lfm");
    assert.equal(result.response.confidence, 0.01);
    assert.equal(h.calls.qwen.length + h.calls.verify.length, 0);
  }
});

test("partial high-confidence comparison escalates once with original immutable preparation", async () => {
  const h = harness();
  const input = request();
  const before = JSON.stringify(input.prepared);
  const result = await createModelCascade(config, h.dependencies).resolve(input);
  assert.equal(result.stage, "qwen");
  assert.equal(h.calls.lfm.length, 1);
  assert.equal(h.calls.qwen.length, 1);
  for (const [message, scoped, grounded] of [...h.calls.lfm, ...h.calls.qwen]) {
    assert.equal(message, input.originalMessage);
    assert.equal(scoped, input.scopedContext);
    assert.equal(grounded, input.prepared.groundedRequest);
  }
  assert.equal(JSON.stringify(input.prepared), before);
  for (const event of h.calls.events) assert.deepEqual(Object.keys(event).sort(), ["reason", "stage", "type"]);
  assert.ok(!JSON.stringify(h.calls.events).includes("CateQuest"));
});

test("ordinary failures never verify or escalate; only compatible trusted fallback succeeds", async () => {
  for (const kind of ["timeout", "invalid_json", "http_error", "truncated"]) {
    const h = harness({ lfmClient: async () => failed("lfm", kind) });
    const cascade = createModelCascade(config, h.dependencies);
    const message = "P95가 뭐야?";
    const local = resolveLocally(message, context);
    assert.equal((await cascade.resolve(request(message))).stage, "upstream_error");
    const result = await cascade.resolve(request(message, { localFallback: local }));
    assert.equal(result.stage, "local_fallback");
    assert.equal(result.response, local);
    assert.equal(h.calls.verify.length + h.calls.qwen.length, 0);
  }
});

test("busy and aborted preserve terminal transport reasons, never Qwen or local success", async () => {
  for (const kind of ["busy", "aborted"]) {
    const h = harness({ lfmClient: async () => failed("lfm", kind) });
    const result = await createModelCascade(config, h.dependencies).resolve(request());
    assert.deepEqual(result, { stage: "upstream_error", reason: kind });
    assert.equal(h.calls.verify.length + h.calls.qwen.length, 0);
  }
});

test("disabled or false gate prevents Qwen; verifier busy/abort stays terminal", async () => {
  const disabled = harness();
  const result = await createModelCascade({ ...config, cascade: { ...config.cascade, qwenEnabled: false } }, disabled.dependencies).resolve(request());
  assert.equal(result.reason, "qwen_disabled");
  assert.equal(disabled.calls.verify.length, 0);
  for (const detail of ["mismatch", "busy", "aborted"]) {
    const h = harness({ verifier: { verify: async () => ({ ok: false, reason: "qwen_unverified", detail }), invalidate() {} } });
    const result = await createModelCascade(config, h.dependencies).resolve(request());
    assert.equal(result.reason, ["busy", "aborted"].includes(detail) ? detail : "qwen_unverified");
    assert.equal(h.calls.qwen.length, 0);
  }
});

test("1999 skips and 2000 allows Qwen; reserve subtracted once, metadata consumes original deadline", async () => {
  for (const budget of [1999, 2000, 8000]) {
    const h = harness();
    h.dependencies.verifier.verify = async (options) => {
      h.calls.verify.push(options);
      h.setTime(900);
      return { ok: true, returnedModelId: "fixture-qwen" };
    };
    const result = await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: budget + 1000 }));
    assert.equal(result.stage, budget === 1999 ? "upstream_error" : "qwen");
    if (budget === 1999) {
      assert.equal(result.reason, "insufficient_stage_budget");
      assert.equal(h.calls.verify.length + h.calls.qwen.length, 0);
    } else {
      assert.equal(h.calls.verify[0].deadlineAt, budget);
      assert.equal(h.calls.verify[0].budgetMs, 1000);
      assert.equal(h.calls.qwen[0][3].deadlineAt, budget);
      assert.equal(h.calls.qwen[0][3].budgetMs, budget - 900);
    }
  }
});

test("metadata exhaustion never resets Qwen deadline or permits a second call", async () => {
  const h = harness();
  h.dependencies.verifier.verify = async () => { h.setTime(1001); return { ok: true, returnedModelId: "fixture-qwen" }; };
  const result = await createModelCascade(config, h.dependencies).resolve(request());
  assert.equal(result.reason, "qwen_unverified");
  assert.equal(h.calls.qwen.length, 0);
});

test("model mismatch or nonconforming Qwen invalidates the shared process gate", async () => {
  for (const outcome of [inspected("qwen", proposal(), "changed"), inspected("qwen", proposal(), undefined, { reasoning: "SECRET" }),
    inspected("qwen", partial()), failed("qwen", "truncated")]) {
    const h = harness({ qwenClient: async (...args) => { h.calls.qwen.push(args); return outcome; } });
    const cascade = createModelCascade(config, h.dependencies);
    assert.equal((await cascade.resolve(request())).stage, "upstream_error");
    assert.equal(h.calls.invalidations, 1);
    assert.equal((await cascade.resolve(request())).reason, "qwen_unverified");
    assert.equal(h.calls.qwen.length, 1);
    assert.ok(!JSON.stringify(h.calls.events).includes("SECRET"));
  }
});

test("original message argument four is used by both acceptance and fallback", async () => {
  const h = harness({ lfmClient: async () => inspected("lfm", { intent: "navigate", targetId: "about", confidence: 1 }) });
  const result = await createModelCascade(config, h.dependencies).resolve(request("연락처로 이동", {
    localFallback: resolveLocally("소개로 이동", context)
  }));
  assert.equal(result.stage, "upstream_error");
  const reject = harness({ lfmClient: async () => inspected("lfm", { intent: "reject_out_of_scope", confidence: 1 }) });
  assert.equal((await createModelCascade(config, reject.dependencies).resolve(request("오늘 날씨 알려줘"))).stage, "lfm");
});

test("ambiguous requests clarify; partial comparison fallback never masquerades as success", async () => {
  const h = harness({ lfmClient: async () => failed("lfm"), qwenClient: async () => failed("qwen") });
  const cascade = createModelCascade(config, h.dependencies);
  const result = await cascade.resolve(request("소개로 이동"));
  assert.equal(result.stage, "clarification");
  assert.equal(result.response.message, "비교하거나 설명할 대상을 더 구체적으로 알려주세요.");
  assert.equal((await cascade.resolve(request(comparison, { localFallback: resolveLocally("CateQuest 요약해줘", context) }))).stage, "upstream_error");
});
