import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createNliServer } from "../nli-gateway.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createRequestDeadline, UpstreamUnavailableError } from "./request-deadline.mjs";
import { createModelCascade } from "./model-cascade.mjs";
import { PROBE_ENDPOINTS } from "./probe-request.mjs";
import { runFixtureSuite } from "./eval-suites.mjs";
import { context, comparison, proposal, partial, inspected, request, harness } from "./model-cascade-fixtures.mjs";

test("amended defaults preserve body timeout, tokens, concurrency and explicit Qwen OFF", () => {
  const config = createGatewayConfig({ NLI_QWEN_ENABLED: "false" });
  assert.deepEqual([config.lfm.timeoutMs, config.model.timeoutMs, config.cascade.timeoutMs, config.requestTimeoutMs],
    [4000, 16000, 21000, 15000]);
  assert.deepEqual([config.lfm.maxTokens, config.model.maxTokens, config.cascade.maxConcurrentRequests], [512, 768, 4]);
  assert.equal(config.cascade.qwenEnabled, false);
  assert.equal(PROBE_ENDPOINTS.qwen.timeoutMs, 16000);
});

test("application absolute deadline caps at 21s and honors smaller configuration", () => {
  for (const [configured, expected] of [[undefined, 21000], [99000, 21000], [7000, 7000]]) {
    let time = 100;
    const deadline = createRequestDeadline({ cascade: { timeoutMs: configured } }, { now: () => time });
    try {
      assert.equal(deadline.deadlineAt, 100 + expected);
      time += expected - 1;
      deadline.check();
      time += 1;
      assert.throws(deadline.check, UpstreamUnavailableError);
    } finally { deadline.dispose(); }
  }
});

test("evaluation suite budgets every HTTP caller at 25s plus process cleanup margin", async () => {
  let captured;
  await runFixtureSuite(createGatewayConfig({}), context, Array.from({ length: 26 }, (_, id) => ({ id, message: "도움말" })),
    "nli/live-test-cases.json", "success", {
      createSession: async () => ({ url: "http://127.0.0.1:1", settle: async () => {}, rows: () => [],
        faults: [], http: [], close: async () => ({ ok: true }) }),
      runChild: async (args, options) => { captured = { args, options }; return { code: 1, stdout: "", stderr: "" }; }
    });
  assert.equal(captured.args[captured.args.indexOf("--timeout-ms") + 1], "25000");
  assert.equal(captured.options.timeout, 680000);
});

test("verification and generation share one 16s deadline, smaller stage budgets remain binding", async () => {
  for (const [modelMs, totalMs, expectedDeadline] of [[99000, 99000, 19500], [6000, 21000, 9500], [16000, 10000, 9000]]) {
    const config = createGatewayConfig({ LM_STUDIO_TIMEOUT_MS: String(modelMs), NLI_CASCADE_TIMEOUT_MS: String(totalMs) });
    for (const late of [false, true]) {
      const h = harness();
      h.dependencies.lfmClient = async () => { h.setTime(3500); return inspected("lfm", partial()); };
      h.dependencies.verifier.verify = async (options) => {
        assert.equal(options.deadlineAt, expectedDeadline);
        assert.equal(options.budgetMs, 1000);
        h.setTime(4400);
        return { ok: true, returnedModelId: "fixture-qwen" };
      };
      h.dependencies.qwenClient = async (...args) => {
        assert.equal(args[3].deadlineAt, expectedDeadline);
        assert.equal(args[3].budgetMs, expectedDeadline - 4400);
        h.setTime(expectedDeadline - (late ? 0 : 1));
        return inspected("qwen", proposal());
      };
      const result = await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: 99000 }));
      assert.equal(result.stage === "qwen", !late);
    }
  }
});

test("cascade hard total cap reserves 1s even when configured and caller deadlines are larger", async () => {
  const config = createGatewayConfig({ NLI_CASCADE_TIMEOUT_MS: "99000" });
  const h = harness();
  h.dependencies.lfmClient = async () => { h.setTime(18500); return inspected("lfm", partial()); };
  const result = await createModelCascade(config, h.dependencies).resolve(request(comparison, { deadlineAt: 99000 }));
  assert.equal(result.reason, "insufficient_stage_budget");
  assert.equal(h.calls.verify.length + h.calls.qwen.length, 0);
});

test("loopback HTTP accepts LFM 3500ms plus Qwen generation 15000ms with 900ms metadata", async (t) => {
  const config = createGatewayConfig({ NLI_HOST: "127.0.0.1", NLI_PORT: "0" });
  let time = 0;
  const calls = { lfm: 0, qwen: 0, verify: 0 };
  const events = [];
  const server = await createNliServer({ config, context, now: () => time, observer: (event) => events.push(event),
    lfmClient: async () => { calls.lfm++; time += 3500; return inspected("lfm", partial()); },
    verifier: { verify: async (options) => {
      calls.verify++;
      assert.equal(options.deadlineAt, 19500);
      time += 900;
      return { ok: true, returnedModelId: "fixture-qwen" };
    }, invalidate() {} },
    qwenClient: async (...args) => {
      calls.qwen++;
      assert.equal(args[3].deadlineAt, 19500);
      time += 15000;
      return inspected("qwen", proposal());
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/nli`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: comparison })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).intent, "answer_portfolio");
    assert.deepEqual(calls, { lfm: 1, qwen: 1, verify: 1 });
    assert.ok(events.some((event) => event.type === "complete" && event.stage === "qwen" && event.reason === "accepted"));
    t.diagnostic(JSON.stringify({ httpStatus: response.status, fakeElapsedMs: time, calls, applicationCapMs: 21000 }));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
  }
});
