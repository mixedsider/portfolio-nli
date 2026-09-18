import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createNliServer, loadNliContext } from "../nli-gateway.mjs";
import { loadTestCases } from "./test-fixtures.mjs";
import { createFakeResolver, requestLiveNli, runTestCase } from "./test-runner.mjs";
import { createStageObserver } from "./test-observer.mjs";
import { UpstreamUnavailableError } from "./request-deadline.mjs";

const context = await loadNliContext();
const fixtures = await loadTestCases("nli/cascade-test-cases.json");
const comparison = fixtures.find((item) => item.id === "difficult-partial-escalation");

test("HTTP non-2xx stays an error, not a successful rejection fixture", async () => {
  for (const failure of ["busy", "invalid_json", "timeout", "reasoning_violation"]) {
    const fixture = { ...comparison, models: { lfm: { failure }, qwen: { failure } } };
    const fake = createFakeResolver(fixture, context);
    const server = await createNliServer({ config: fake.config, ...fake.dependencies });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/nli`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: fixture.message })
      });
      assert.equal(response.status, 503, failure);
      const body = await response.json();
      assert.equal(body.errorCode, "UPSTREAM_UNAVAILABLE");
      assert.equal(body.intent, "reject_out_of_scope");
      assert.equal(body.sources, undefined);
      assert.deepEqual(fake.counts, failure === "busy" ? { lfmCalls: 0, qwenCalls: 0 } : { lfmCalls: 1, qwenCalls: 1 });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    }
  }
});

test("deadline boundaries and no-thinking gate retain independent actual counters", async () => {
  for (const [elapsedMs, expectedCalls] of [[18000, 1], [18001, 0]]) {
    const item = { ...fixtures.find((entry) => entry.id === "ambiguous-unverified-clarification"), verification: "verified",
      models: { lfm: { failure: "timeout", elapsedMs }, qwen: { failure: "invalid_json" } } };
    const fake = createFakeResolver(item, context);
    await fake.resolve(item.message, context, { reportUpstreamFailure: true });
    assert.deepEqual(fake.counts, { lfmCalls: 1, qwenCalls: expectedCalls });
    assert.ok(fake.events.some((event) => event.type === "escalation" && event.reason ===
      (expectedCalls ? "eligible" : "insufficient_stage_budget")));
  }
  for (const verification of ["unverified", "disabled"]) {
    const fake = createFakeResolver({ ...comparison, verification }, context);
    await assert.rejects(fake.resolve(comparison.message, context, { reportUpstreamFailure: true }), UpstreamUnavailableError);
    assert.deepEqual(fake.counts, { lfmCalls: 1, qwenCalls: 0 });
  }
});

test("parseable truncation and visible Qwen reasoning cannot be accepted", async () => {
  const completion = { model: "fixture-qwen", choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify(comparison.models.qwen.response), reasoning_content: "hidden fixture thought"
  } }] };
  const fake = createFakeResolver({ ...comparison, models: { ...comparison.models, qwen: { completion } } }, context);
  await assert.rejects(fake.resolve(comparison.message, context, { reportUpstreamFailure: true }));
  assert.deepEqual(fake.counts, { lfmCalls: 1, qwenCalls: 1 });
  assert.ok(fake.events.some((event) => event.type === "complete" && event.reason === "reasoning_violation"));
  const ordinary = fixtures.find((item) => item.id === "ordinary-summary-low-confidence");
  const truncated = { ...ordinary, models: { ...ordinary.models, lfm: { completion: {
    model: "fixture-lfm", choices: [{ finish_reason: "length", message: { role: "assistant", content: JSON.stringify(ordinary.models.lfm.response) } }]
  } } } };
  const result = await runTestCase(truncated, context, { mode: "fake" });
  assert.match(result.errors.join(), /intent expected/);
  assert.equal(result.observations.stage, "local_fallback");
});

test("observer never turns absent dispatch metadata or unsettled attempts into zero", () => {
  const sink = createStageObserver();
  const emit = (event) => sink.observer({ requestId: "trusted", ...event });
  emit({ type: "request" });
  assert.equal(sink.snapshot("trusted").lfmCalls, undefined);
  emit({ type: "attempt", stage: "lfm" });
  emit({ type: "complete", stage: "upstream_error", reason: "aborted" });
  assert.equal(sink.snapshot("trusted").lfmCalls, undefined);
  emit({ type: "transport", stage: "lfm", dispatchCount: 1 });
  assert.deepEqual(sink.snapshot("trusted"), { stage: "upstream_error", reason: "aborted", lfmCalls: 1, qwenCalls: 0 });
  assert.throws(() => emit({ type: "transport", stage: "qwen", dispatchCount: null }));
  assert.throws(() => sink.snapshot("unknown"));
  sink.clear();
  assert.deepEqual(sink.requestIds(), []);
});

test("live counters require a separate trusted observer and ignore forged browser fields", async () => {
  const fixture = fixtures[0];
  const fake = await runTestCase(fixture, context, { mode: "fake" });
  const fetchImpl = async () => ({ ok: true, json: async () => fake.result });
  const absent = await runTestCase(fixture, context, { mode: "live" }, "http://unused.invalid", { fetch: fetchImpl });
  assert.match(absent.errors.join(), /lfmCalls is unobserved/);
  const forged = await runTestCase(fixture, context, { mode: "live" }, "http://unused.invalid", {
    fetch: async () => ({ ok: true, json: async () => ({ ...fake.result, ...fake.observations }) })
  });
  assert.match(forged.errors.join(), /lfmCalls is unobserved/);
  const present = await runTestCase(fixture, context, { mode: "live" }, "http://unused.invalid", {
    fetch: fetchImpl, observeCase: async () => fake.observations
  });
  assert.deepEqual(present.errors, []);
  const failed = await runTestCase(fixture, context, { mode: "live" }, "http://unused.invalid", {
    fetch: async () => ({ ok: false, status: 503 })
  });
  assert.deepEqual(failed.errors, ["request failed: HTTP 503"]);
});

test("live request keeps payload boundary, default 25000ms and explicit timeout", async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { delays.push(ms); return originalSetTimeout(fn, ms); });
  for (const timeout of [undefined, 123]) {
    await requestLiveNli({ message: "test", currentTargetId: "about", history: [], models: {}, lfmCalls: 99 }, "http://unused.invalid", timeout,
      async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { message: "test", currentTargetId: "about", history: [] });
        return { ok: true, json: async () => ({}) };
      });
  }
  assert.deepEqual(delays, [25000, 123]);
});
