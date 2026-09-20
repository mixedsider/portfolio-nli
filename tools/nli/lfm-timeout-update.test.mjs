import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createNliServer } from "../nli-gateway.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createRequestDeadline, UpstreamUnavailableError } from "./request-deadline.mjs";
import { createModelCascade } from "./model-cascade.mjs";
import { createDetailedModelClient } from "./model-transport.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { PROBE_ENDPOINTS } from "./probe-request.mjs";
import { context, comparison, envelope, proposal, partial, inspected, request, harness } from "./model-cascade-fixtures.mjs";

test("issue 6 defaults and probe preserve tokens, reasoning OFF and receive timeout", () => {
  const config = createGatewayConfig({});
  assert.deepEqual([config.lfm.timeoutMs, config.model.timeoutMs, config.cascade.timeoutMs, config.requestTimeoutMs],
    [6500, 16000, 23500, 15000]);
  assert.deepEqual([PROBE_ENDPOINTS.lfm.timeoutMs, PROBE_ENDPOINTS.qwen.timeoutMs], [6500, 16000]);
  assert.deepEqual([config.lfm.maxTokens, config.model.maxTokens, config.cascade.maxConcurrentRequests], [512, 768, 4]);
  assert.equal(config.model.reasoningEffort, "none");
  assert.deepEqual(config.model.chatTemplateKwargs, { enable_thinking: false });
});

test("application clock stays open beyond 23s, rejects exactly 23.5s, and preserves smaller overrides", () => {
  for (const [configured, expected] of [[undefined, 23500], [99000, 23500], [23000, 23000], [7000, 7000]]) {
    let time = 0;
    const deadline = createRequestDeadline({ cascade: { timeoutMs: configured } }, { now: () => time });
    try {
      assert.equal(deadline.deadlineAt, expected);
      if (expected === 23500) { time = 23250; deadline.check(); }
      time = expected - 1;
      deadline.check();
      time++;
      assert.throws(deadline.check, UpstreamUnavailableError);
    } finally { deadline.dispose(); }
  }
});

test("cascade LFM caps at 6.5s and honors smaller explicit overrides", async () => {
  for (const [configured, expected] of [[99000, 6500], [6000, 6000], [1234, 1234]]) {
    const h = harness();
    h.dependencies.lfmClient = async (...args) => {
      assert.equal(args[3].budgetMs, expected);
      h.setTime(expected - 1);
      return inspected("lfm", proposal());
    };
    const config = createGatewayConfig({ LFM_TIMEOUT_MS: String(configured) });
    assert.equal((await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: 99000 }))).stage, "lfm");
    assert.equal(h.calls.qwen.length + h.calls.verify.length, 0);
  }
});

test("LFM accepts 6250ms but rejects exactly 6500ms and retains an explicit 6000ms bound", async () => {
  for (const [env, completedAt, accepted] of [[{}, 6250, true], [{}, 6500, false],
    [{ LFM_TIMEOUT_MS: "6000" }, 6000, false]]) {
    const h = harness();
    h.dependencies.lfmClient = async () => { h.setTime(completedAt); return inspected("lfm", proposal()); };
    const result = await createModelCascade(createGatewayConfig({ ...env, NLI_QWEN_ENABLED: "false" }), h.dependencies)
      .resolve(request(comparison, { deadlineAt: 99000 }));
    assert.equal(result.stage === "lfm", accepted, `completion at ${completedAt}ms`);
    assert.equal(h.calls.qwen.length + h.calls.verify.length, 0);
  }
});

test("Qwen includes metadata in its 16s cap after 5.5s LFM and rejects late responses", async () => {
  for (const [modelMs, totalMs, expectedDeadline] of [[99000, 99000, 21500], [6000, 23000, 11500], [16000, 10000, 9000]]) {
    for (const late of [false, true]) {
      const h = harness();
      h.dependencies.lfmClient = async () => { h.setTime(5500); return inspected("lfm", partial()); };
      h.dependencies.verifier.verify = async (options) => {
        assert.equal(options.deadlineAt, expectedDeadline);
        assert.equal(options.budgetMs, 1000);
        h.setTime(6400);
        return { ok: true, returnedModelId: "fixture-qwen" };
      };
      h.dependencies.qwenClient = async (...args) => {
        assert.equal(args[3].deadlineAt, expectedDeadline);
        assert.equal(args[3].budgetMs, expectedDeadline - 6400);
        h.setTime(expectedDeadline - (late ? 0 : 1));
        return inspected("qwen", proposal());
      };
      const config = createGatewayConfig({ LM_STUDIO_TIMEOUT_MS: String(modelMs), NLI_CASCADE_TIMEOUT_MS: String(totalMs) });
      const result = await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: 99000 }));
      assert.equal(result.stage === "qwen", !late);
    }
  }
});

test("application work stops exactly at 22500ms to retain the 1000ms response reserve", async () => {
  for (const completedAt of [22499, 22500]) {
    const h = harness();
    h.dependencies.lfmClient = async () => { h.setTime(6500); return inspected("lfm", partial()); };
    h.dependencies.verifier.verify = async () => ({ ok: true, returnedModelId: "fixture-qwen" });
    h.dependencies.qwenClient = async (...args) => {
      assert.equal(args[3].deadlineAt, 22500);
      assert.equal(args[3].budgetMs, 16000);
      h.setTime(completedAt);
      return inspected("qwen", proposal());
    };
    const result = await createModelCascade(createGatewayConfig({}), h.dependencies)
      .resolve(request(comparison, { deadlineAt: 23500 }));
    assert.equal(result.stage, completedAt === 22499 ? "qwen" : "upstream_error");
    if (completedAt === 22500) assert.equal(result.reason, "deadline_exhausted");
  }
});

test("transport caps, cancellation and ignored late fetch release all permits", async () => {
  for (const [endpoint, field, cap] of [["lfm", "lfm", 6500], ["qwen", "model", 16000]]) {
    for (const configured of [99000, 6000, 1234]) {
      for (const cancelled of [false, true]) {
        let time = 0;
        let timer;
        let timerMs;
        let resolveFetch;
        let bodyCancelled = false;
        const admission = createModelAdmission();
        const controller = new AbortController();
        const client = createDetailedModelClient({ ...createGatewayConfig({})[field], timeoutMs: configured }, {
          endpoint, admission, now: () => time,
          setTimer: (callback, ms) => { timer = callback; timerMs = ms; return 1; },
          clearTimer() {}, fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; })
        });
        const pending = client(comparison, context, {}, { signal: controller.signal });
        assert.equal(admission.active, 1);
        time = Math.min(configured, cap);
        if (cancelled) controller.abort(); else timer();
        const result = await pending;
        assert.equal(timerMs, Math.min(configured, cap));
        assert.equal(result.kind, cancelled ? "aborted" : "timeout");
        assert.equal(result.metadata.budgetMs, Math.min(configured, cap));
        assert.equal(admission.active, 0);
        resolveFetch(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(bodyCancelled, true);
        assert.equal(admission.active, 0);
      }
    }
  }
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, message) {
  return fetch(`${url}/api/nli`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }), signal: AbortSignal.timeout(30000) });
}

test("real Gateway HTTP adopts a 6.2s delayed LFM within its stage budget, without Qwen", async (t) => {
  let calls = 0;
  const upstream = await listen(t, createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the test request. */ }
    calls++;
    await delay(6200);
    if (!res.destroyed) res.end(JSON.stringify(envelope({ intent: "define_term", confidence: 1, term: "P95" }, "fixture-lfm")));
  }));
  const events = [];
  const config = createGatewayConfig({ LFM_BASE_URL: `${upstream}/v1`, NLI_QWEN_ENABLED: "false" });
  const gateway = await createNliServer({ config, context, observer: (event) => events.push(event) });
  const url = await listen(t, gateway);
  const started = performance.now();
  const response = await post(url, "P95가 뭐야?");
  const body = await response.json();
  const elapsedMs = performance.now() - started;
  assert.equal(response.status, 200);
  assert.equal(body.intent, "define_term");
  assert.ok(events.some((event) => event.type === "complete" && event.stage === "lfm" && event.reason === "accepted"));
  assert.equal(events.filter((event) => event.type === "attempt").length, 1);
  assert.equal(calls, 1);
  // Adoption enforces the 6.5s stage cap; HTTP round-trip time also includes Gateway preparation.
  assert.ok(elapsedMs > 6000, `real elapsed ${elapsedMs}ms`);
  assert.equal(gateway.requestTimeout, 15000);
  assert.equal(gateway.headersTimeout, 15000);
  t.diagnostic(JSON.stringify({ realElapsedMs: Math.round(elapsedMs), adopted: "lfm", inferenceCalls: calls }));
});

test("Gateway fake clock accepts Qwen before the reserve and rejects at reserve/application boundaries", async (t) => {
  for (const completedAt of [22300, 22500, 23250, 23500, 23501]) {
    let time = 0;
    const calls = [];
    const events = [];
    const gateway = await createNliServer({ config: createGatewayConfig({}), context, now: () => time,
      observer: (event) => events.push(event),
      lfmClient: async () => { calls.push("lfm"); time = 6400; return inspected("lfm", partial()); },
      verifier: { verify: async (options) => {
        calls.push("metadata"); assert.equal(options.deadlineAt, 22400); time = 7300;
        return { ok: true, returnedModelId: "fixture-qwen" };
      }, invalidate() {} },
      qwenClient: async (...args) => {
        calls.push("qwen"); assert.equal(args[3].budgetMs, 15100); time = completedAt;
        return inspected("qwen", proposal());
      }
    });
    const response = await post(await listen(t, gateway), comparison);
    await response.json();
    assert.equal(response.status, completedAt === 22300 ? 200 : 503);
    assert.deepEqual(calls, ["lfm", "metadata", "qwen"]);
    assert.equal(events.some((event) => event.type === "complete" && event.stage === "qwen"), completedAt === 22300);
    t.diagnostic(JSON.stringify({ fakeElapsedMs: time, httpStatus: response.status }));
  }
});
