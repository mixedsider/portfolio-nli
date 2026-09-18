import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createGatewayConfig } from "./config.mjs";
import { buildGroundedRequestBlock } from "./context.mjs";
import { createDetailedModelClient, buildDetailedModelPayload } from "./model-client.mjs";
import { createModelAdmission } from "./model-admission.mjs";

const context = { prompt: "Return the existing decision JSON object only." };
const candidate = { intent: "reject_out_of_scope", confidence: 1 };
const envelope = { model: "alias", choices: [{ finish_reason: "stop", message: {
  role: "assistant", content: JSON.stringify(candidate)
} }] };
const settings = { ...createGatewayConfig({}).lfm, timeoutMs: 500 };

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}/v1`;
}

test("detailed clients snapshot exact separate settings and schema, no inference at construction", async (t) => {
  const received = [];
  const handler = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, payload: JSON.parse(body) });
    res.end(JSON.stringify(envelope));
  };
  const config = createGatewayConfig({ LFM_BASE_URL: await server(t, handler), LM_STUDIO_BASE_URL: await server(t, handler) });
  const admission = createModelAdmission();
  const lfm = createDetailedModelClient(config.lfm, { endpoint: "lfm", admission });
  const qwen = createDetailedModelClient(config.model, { endpoint: "qwen", admission });
  config.lfm.name = "mutated";
  config.model.chatTemplateKwargs.enable_thinking = true;
  assert.equal(received.length, 0);
  const grounded = { history: [{ role: "user", text: "prior" }], candidateSources: [] };
  const outcomes = await Promise.all([lfm("lfm input", context, grounded), qwen("qwen input", context, grounded)]);
  assert.ok(outcomes.every((outcome) => outcome.tag === "success" && outcome.metadata.dispatchCount === 1));
  assert.equal(admission.active, 0);
  const schema = JSON.parse(await readFile(new URL("../../nli/model-decision.schema.json", import.meta.url), "utf8"));
  for (const { path, payload } of received) {
    assert.equal(path, "/v1/chat/completions");
    assert.deepEqual(payload.response_format.json_schema.schema, schema);
    assert.equal(payload.messages[1].content, buildGroundedRequestBlock(grounded));
    assert.equal(payload.reasoning_effort, "none");
    assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false });
    assert.equal(payload.temperature, 0);
  }
  assert.equal(received[0].payload.model, settings.name);
  assert.equal(received[0].payload.max_tokens, 512);
  assert.equal(received[1].payload.max_tokens, 768);
  assert.ok(Object.isFrozen(lfm.settings));
  assert.ok(Object.isFrozen(qwen.settings.chatTemplateKwargs));
  assert.deepEqual(buildDetailedModelPayload(lfm.settings, "lfm input", context, grounded), received[0].payload);
});

test("four actual upstream operations across endpoints reject fifth before dispatch and recover", async (t) => {
  const pending = [];
  const handler = (req, res) => { req.resume(); pending.push(res); };
  const urls = [await server(t, handler), await server(t, handler)];
  const admission = createModelAdmission();
  const clients = urls.map((baseUrl, i) => createDetailedModelClient({ ...settings, baseUrl, timeoutMs: 2000 }, {
    endpoint: i ? "qwen" : "lfm", admission
  }));
  const operations = Array.from({ length: 4 }, (_, i) => clients[i % 2]("hold", context));
  while (pending.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
  const fifth = await clients[1]("fifth", context);
  assert.equal(fifth.kind, "busy");
  assert.equal(fifth.metadata.dispatchCount, 0);
  assert.equal(pending.length, 4);
  assert.equal(admission.active, 4);
  pending.forEach((res) => res.end(JSON.stringify(envelope)));
  assert.ok((await Promise.all(operations)).every((outcome) => outcome.tag === "success"));
  assert.equal(admission.active, 0);
});

test("real HTTP header/body stalls, parent disconnect and body limit release permits", async (t) => {
  let bodyStarted;
  let notifyBody;
  let upstreamClosed = 0;
  const baseUrl = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.on("close", () => { upstreamClosed += 1; });
    const message = JSON.parse(body).messages.at(-1).content;
    if (message === "headers") return;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (message === "limit") return res.end("x".repeat(200));
    res.write('{"choices":');
    notifyBody?.();
  });
  const admission = createModelAdmission();
  const client = createDetailedModelClient({ ...settings, baseUrl, maxResponseBytes: 100 }, { endpoint: "lfm", admission });
  for (const message of ["headers", "body"]) {
    const outcome = await client(message, context, {}, { budgetMs: 80 });
    assert.equal(outcome.kind, "timeout");
    assert.equal(outcome.metadata.dispatchCount, 1);
    assert.equal(admission.active, 0);
  }
  assert.equal((await client("limit", context)).kind, "body_limit");
  bodyStarted = new Promise((resolve) => { notifyBody = resolve; });
  const controller = new AbortController();
  const operation = client("cancel", context, {}, { signal: controller.signal });
  await bodyStarted;
  controller.abort("client disconnected");
  assert.equal((await operation).kind, "aborted");
  const preAborted = await client("never dispatched", context, {}, { signal: controller.signal });
  assert.equal(preAborted.kind, "aborted");
  assert.equal(preAborted.metadata.dispatchCount, 0);
  assert.equal(admission.active, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(upstreamClosed >= 4);
});

test("HTTP errors, redirects and invalid JSON are finite failures without retries", async (t) => {
  let calls = 0;
  const baseUrl = await server(t, (req, res) => {
    req.resume();
    calls += 1;
    if (calls === 1) { res.writeHead(503); res.end("private error"); }
    else if (calls === 2) { res.writeHead(302, { Location: "/redirected" }); res.end(); }
    else res.end("not JSON");
  });
  const client = createDetailedModelClient({ ...settings, baseUrl }, { endpoint: "lfm" });
  for (const kind of ["http_error", "http_error", "invalid_json"]) {
    const result = await client("input", context);
    assert.equal(result.kind, kind);
    assert.equal(result.metadata.dispatchCount, 1);
    assert.equal(JSON.stringify(result).includes("private error"), false);
  }
  assert.equal(calls, 3);
});

test("injected clock enforces budgets, rejects late results and cancels noncooperative reads", async () => {
  let time = 100;
  let timer;
  let cancelled = false;
  const admission = createModelAdmission();
  const client = createDetailedModelClient(settings, {
    endpoint: "lfm", admission, now: () => time,
    setTimer: (callback) => { timer = callback; return 1; }, clearTimer: () => {},
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))
  });
  const expired = await client("expired", context, {}, { deadlineAt: 100 });
  assert.equal(expired.kind, "timeout");
  assert.equal(expired.metadata.dispatchCount, 0);
  const operation = client("stalled", context, {}, { budgetMs: 200, deadlineAt: 150 });
  await new Promise((resolve) => setImmediate(resolve));
  time = 150;
  timer();
  const result = await operation;
  assert.equal(result.kind, "timeout");
  assert.equal(result.metadata.budgetMs, 50);
  assert.equal(result.metadata.readCount, 1);
  assert.equal(cancelled, true);
  assert.equal(admission.active, 0);
  const late = createDetailedModelClient(settings, { endpoint: "lfm", now: () => time,
    fetchImpl: async () => { time += 501; return new Response(JSON.stringify(envelope)); }
  });
  assert.equal((await late("late", context)).kind, "timeout");
});

test("invalid configuration never dispatches or silently changes configured mode", () => {
  assert.throws(() => createDetailedModelClient(settings, {}));
  for (const patch of [{ outputMode: "auto" }, { timeoutMs: Infinity }, { maxTokens: 0 },
    { baseUrl: "file:///tmp/model" }, { baseUrl: "http://user:pass@localhost/v1" },
    { baseUrl: "http://localhost/v1?secret=1" }]) {
    assert.throws(() => createDetailedModelClient({ ...settings, ...patch }, { endpoint: "lfm" }));
  }
});

test("explicit plain mode omits only response_format and dispatches once per endpoint", async (t) => {
  const received = [];
  const baseUrl = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.end(JSON.stringify(envelope));
  });
  const config = createGatewayConfig({ LFM_BASE_URL: baseUrl, LM_STUDIO_BASE_URL: baseUrl });
  for (const [endpoint, record] of [["lfm", config.lfm], ["qwen", config.model]]) {
    assert.equal(record.outputMode, "json_schema");
    const client = createDetailedModelClient({ ...record, outputMode: "plain" }, { endpoint });
    const { response_format, ...expected } = buildDetailedModelPayload(record, "input", context);
    assert.equal(response_format.type, "json_schema");
    const outcome = await client("input", context);
    assert.equal(outcome.tag, "success");
    assert.equal(outcome.metadata.dispatchCount, 1);
    assert.deepEqual(received.at(-1), expected);
    assert.equal(Object.hasOwn(received.at(-1), "response_format"), false);
    assert.equal(received.at(-1).reasoning_effort, "none");
    assert.deepEqual(received.at(-1).chat_template_kwargs, { enable_thinking: false });
  }
  assert.equal(received.length, 2);
});

test("plain and schema modes enforce identical failures without retry or fallback", async () => {
  const cases = [
    [{ choices: [] }, "invalid_envelope"],
    [{ choices: [{ ...envelope.choices[0], finish_reason: "length" }] }, "truncated"],
    [{ choices: [{ ...envelope.choices[0], message: { role: "user", content: "{}" } }] }, "invalid_envelope"],
    [{ choices: [{ ...envelope.choices[0], message: { role: "assistant", content: "```json\n{}\n```" } }] }, "invalid_json"],
    [{ choices: [{ ...envelope.choices[0], message: { role: "assistant", content: "{}", tool_calls: [{}] } }] }, "invalid_envelope"],
    [{ ...envelope, usage: { reasoning_tokens: 1 } }, "reasoning_violation"]
  ];
  for (const outputMode of ["json_schema", "plain"]) {
    let calls = 0;
    for (const [reply, kind] of cases) {
      const client = createDetailedModelClient({ ...settings, outputMode }, { endpoint: "qwen", fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(Object.hasOwn(JSON.parse(options.body), "response_format"), outputMode === "json_schema");
        return new Response(JSON.stringify(reply));
      } });
      const outcome = await client("input", context);
      assert.equal(outcome.kind, kind);
      assert.equal(outcome.metadata.dispatchCount, 1);
      assert.equal(Object.hasOwn(outcome, "candidate"), false);
    }
    assert.equal(calls, cases.length);
  }
});
