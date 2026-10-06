import assert from "node:assert/strict";
import test from "node:test";
import { createNliServer } from "../nli-gateway.mjs";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createRequestResolver } from "./request-resolution.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { rejectResponse } from "./responses.mjs";
import { UpstreamUnavailableError } from "./request-deadline.mjs";
import * as decisionSchema from "./decision-schema.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const config = createGatewayConfig({ NLI_QWEN_ENABLED: "false" });
const clarification = rejectResponse("비교하거나 설명할 대상을 더 구체적으로 알려주세요.");
// Characterized using HEAD 230ad7e preparation/resolver from git show and fake
// LFM failures: coverage-impossible cases clarify; incompatible navigation uses
// the existing HTTP 503 / ordinary-resolver canonical rejection distinction.
const cases = [
  { message: "Observability 어떻게 구현했어", coverageImpossible: true },
  { message: "Observability 성능 개선 설명", coverageImpossible: true },
  { message: "CateQuest P95로 이동", coverageImpossible: false },
  { message: "Bookking N+1로 이동", coverageImpossible: false },
  { message: "About NLI로 이동", coverageImpossible: false }
];

function injections() {
  const calls = { lfm: 0, qwen: 0, verify: 0 };
  const events = [];
  const dependencies = { context, observer: (event) => events.push(event),
    lfmClient: async () => { calls.lfm++; return { tag: "failure", kind: "http_error", metadata: { endpoint: "lfm" } }; },
    qwenClient: async () => { calls.qwen++; throw new Error("No Qwen dispatch authorized"); },
    verifier: { verify: async () => { calls.verify++; throw new Error("No metadata authorized"); }, invalidate() {} } };
  return { calls, events, dependencies };
}

async function httpFixture(t, extra = {}) {
  const f = injections();
  const server = await createNliServer({ config, ...f.dependencies, ...extra });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/nli`;
  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ...f, post, url };
}

for (const row of cases) test(`unavailable preparation preserves HEAD resolver semantics without inference: ${row.message}`, async () => {
  const f = injections();
  const resolve = createRequestResolver(config, f.dependencies);
  const result = await resolve(row.message);
  assert.deepEqual(result, row.coverageImpossible ? clarification : rejectResponse());
  if (row.coverageImpossible) assert.deepEqual(await resolve(row.message, context, { reportUpstreamFailure: true }), clarification);
  else await assert.rejects(resolve(row.message, context, { reportUpstreamFailure: true }), UpstreamUnavailableError);
  assert.deepEqual(f.calls, { lfm: 0, qwen: 0, verify: 0 });
  assert.ok(f.events.some((event) => event.type === "complete" &&
    event.stage === (row.coverageImpossible ? "clarification" : "upstream_error")));
  assert.ok(!f.events.some((event) => ["attempt", "transport", "escalation"].includes(event.type)));
});

test("HTTP unavailable preparation is semantic clarification/503, never the regressed INVALID_REQUEST 400", async (t) => {
  const f = await httpFixture(t);
  for (const row of cases) {
    const response = await f.post({ message: row.message });
    assert.equal(response.status, row.coverageImpossible ? 200 : 503, row.message);
    const body = await response.json();
    const { requestId, errorCode, ...canonical } = body;
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(errorCode, row.coverageImpossible ? "OUT_OF_SCOPE" : "UPSTREAM_UNAVAILABLE", row.message);
    assert.deepEqual(canonical, row.coverageImpossible ? clarification :
      rejectResponse("도우미 응답을 일시적으로 가져오지 못했습니다. 잠시 후 다시 시도해주세요."));
    assert.ok(!JSON.stringify(body).includes("No authorized"));
  }
  assert.deepEqual(f.calls, { lfm: 0, qwen: 0, verify: 0 });
});

test("weather rejection and supported normal summary still use the unchanged strict model path", async (t) => {
  let calls = 0;
  const summary = { intent: "answer_portfolio", confidence: 1,
    answer: `CateQuest ${context.projectByTargetId.get("project-catequest").description}`, sourceIds: ["project-catequest"] };
  const f = await httpFixture(t, { lfmClient: async (message, scoped, request) => {
    calls++;
    const schema = decisionSchema.specializeDecisionSchema(decisionSchema.getModelDecisionSchema(), request);
    const candidate = message.includes("날씨") ? { intent: "reject_out_of_scope", confidence: 1 } : summary;
    assert.deepEqual(schema.oneOf.map((branch) => branch.properties.intent.const), [candidate.intent]);
    return { tag: "success", candidate, metadata: { endpoint: "lfm", finishReason: "stop", dispatchCount: 1 } };
  } });
  assert.equal((await f.post({ message: cases[0].message })).status, 200);
  assert.equal(calls, 0, "clarification does not initialize or poison the normal model path");
  for (const [message, intent] of [["오늘 서울 날씨를 알려줘", "reject_out_of_scope"], ["CateQuest 프로젝트 요약해줘", "answer_portfolio"]]) {
    const response = await f.post({ message });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).intent, intent);
  }
  assert.equal(calls, 2);
  assert.equal(f.calls.qwen, 0);
});

test("malformed HTTP requests remain INVALID_REQUEST 400 with zero inference", async (t) => {
  const f = await httpFixture(t);
  for (const body of [{ message: 42 }, { message: "Observability 어떻게 구현했어", history: [{ role: "system", text: "bad" }] }]) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).errorCode, "INVALID_REQUEST");
  }
  const invalidJson = await fetch(f.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).errorCode, "INVALID_REQUEST");
  assert.deepEqual(f.calls, { lfm: 0, qwen: 0, verify: 0 });
});

test("preparation throws a named unavailable error without authorizing broad branches or rejection", () => {
  assert.equal(typeof decisionSchema.PreparedDecisionUnavailableError, "function");
  for (const row of cases) assert.throws(() => prepareGroundedRequest(row.message, context), (error) => {
    assert.ok(error instanceof decisionSchema.PreparedDecisionUnavailableError);
    assert.equal(error.name, "PreparedDecisionUnavailableError");
    assert.equal(error.coverageImpossible, row.coverageImpossible);
    return true;
  });
});

test("unexpected preparation errors, even with the named-error string, are not swallowed", async (t) => {
  const fault = new Error("Programming fault must propagate");
  fault.name = "PreparedDecisionUnavailableError";
  const brokenContext = { ...context, routes: { get targets() { throw fault; } } };
  const f = injections();
  const resolve = createRequestResolver(config, { ...f.dependencies, context: brokenContext });
  await assert.rejects(resolve("Observability 어떻게 구현했어"), (error) => error === fault);
  const http = await httpFixture(t, { context: brokenContext });
  const response = await http.post({ message: "Observability 어떻게 구현했어" });
  assert.equal(response.status, 400, "unexpected errors retain existing HTTP handling");
  assert.equal((await response.json()).errorCode, "INVALID_REQUEST");
  assert.deepEqual(f.calls, { lfm: 0, qwen: 0, verify: 0 });
  assert.deepEqual(http.calls, { lfm: 0, qwen: 0, verify: 0 });
});

test("named unavailable preparation cannot return clarification after caller abort or deadline expiry", async () => {
  for (const aborted of [false, true]) {
    let time = 0;
    const controller = new AbortController();
    const scoped = { ...context, routes: { get targets() {
      if (aborted) controller.abort();
      else time = config.cascade.timeoutMs;
      return context.routes.targets;
    } } };
    const f = injections();
    const resolve = createRequestResolver(config, { ...f.dependencies, context: scoped, now: () => time });
    await assert.rejects(resolve(cases[0].message, scoped, { signal: controller.signal }), UpstreamUnavailableError);
    assert.deepEqual(f.calls, { lfm: 0, qwen: 0, verify: 0 });
    assert.ok(!f.events.some((event) => event.stage === "clarification"));
  }
});
