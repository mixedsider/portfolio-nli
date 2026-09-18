import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "./context.mjs";
import { createDetailedModelClient, createModelClient, getModelDecisionSchema } from "./model-client.mjs";
import { createModelAdmission } from "./model-admission.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const context = await loadNliContext(root);

test("model client disables reasoning, ignores reasoning_content, and accepts only visible strict JSON", async () => {
  const receivedPayloads = [];
  const upstream = createServer(async (request, response) => {
    const payload = JSON.parse(await readRequestBody(request));
    receivedPayloads.push(payload);
    const message = payload.messages.at(-1).content;
    const content =
      message === "visible JSON" ? JSON.stringify({ intent: "reject_out_of_scope", confidence: 1 }) : message === "empty" ? "" : "<think>reasoning only</think>";

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content, reasoning_content: "hidden chain-of-thought must be ignored" } }]
      })
    );
  });
  const baseUrl = await listen(upstream);
  const config = createGatewayConfig({
    LM_STUDIO_BASE_URL: baseUrl,
    LM_STUDIO_MODEL: "local-test-model",
    LM_STUDIO_TIMEOUT_MS: "1000",
    LM_STUDIO_MAX_TOKENS: "64",
    LM_STUDIO_MAX_RESPONSE_BYTES: "8192",
    LM_STUDIO_MAX_CONCURRENT_REQUESTS: "1"
  });
  const askModel = createModelClient(config);

  try {
    assert.deepEqual(await askModel("visible JSON", context), { intent: "reject_out_of_scope", confidence: 1 });
    assert.equal(await askModel("empty", context), null);
    await assert.rejects(askModel("reasoning-only", context), SyntaxError);
    assert.deepEqual(receivedPayloads.map((payload) => payload.reasoning_effort), ["none", "none", "none"]);
    assert.deepEqual(
      receivedPayloads.map((payload) => payload.chat_template_kwargs),
      [{ enable_thinking: false }, { enable_thinking: false }, { enable_thinking: false }]
    );
    assert.equal(receivedPayloads[0].messages[0].content, context.prompt);
  } finally {
    await close(upstream);
  }
});

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fake LM Studio server did not expose a TCP port"));
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("detailed adapters require real strict envelopes and recover after every failure", async () => {
  const admission = createModelAdmission();
  const settings = createGatewayConfig({}).model;
  let reply;
  let calls = 0;
  const client = createDetailedModelClient(settings, { endpoint: "qwen", admission, fetchImpl: async () => {
    calls += 1;
    if (reply === "throw") throw new Error("private upstream internals");
    return new Response(JSON.stringify(reply));
  } });
  const valid = { model: "test", choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: '{"intent":"reject_out_of_scope","confidence":1}'
  } }] };
  for (const [value, kind] of [
    [{ intent: "reject_out_of_scope", confidence: 1 }, "invalid_envelope"],
    [{ tag: "success", candidate: {} }, "invalid_envelope"],
    [{ choices: [{ message: { content: "{}" } }] }, "invalid_envelope"],
    [{ choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] }, "truncated"],
    [{ ...valid, usage: { reasoning_tokens: 1 } }, "reasoning_violation"],
    ["throw", "http_error"]
  ]) {
    reply = value;
    const failed = await client("test", context);
    assert.equal(failed.kind, kind);
    assert.equal(failed.metadata.dispatchCount, 1);
    assert.equal(Object.hasOwn(failed, "candidate"), false);
    assert.equal(JSON.stringify(failed).includes("private upstream"), false);
    assert.equal(admission.active, 0);
    reply = valid;
    assert.equal((await client("recovered", context)).tag, "success");
  }
  assert.equal(calls, 12);
  assert.equal(getModelDecisionSchema(), getModelDecisionSchema());
  assert.ok(Object.isFrozen(getModelDecisionSchema().properties));
});

test("parent cancellation settles even a fetch that ignores its signal; late body is cancelled", async () => {
  let resolveFetch;
  let cancelled = false;
  let fetchSignal;
  const admission = createModelAdmission();
  const client = createDetailedModelClient(createGatewayConfig({}).lfm, { endpoint: "lfm", admission,
    fetchImpl: (_url, options) => {
      fetchSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    }
  });
  const parent = new AbortController();
  const operation = client("cancel while waiting for headers", context, {}, { signal: parent.signal });
  parent.abort();
  assert.equal((await operation).kind, "aborted");
  assert.equal(fetchSignal.aborted, true);
  assert.equal(admission.active, 0);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
