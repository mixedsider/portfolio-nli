import { createServer } from "node:http";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createGatewayConfig } from "./nli/config.mjs";
import { isOriginAllowed } from "./nli/http.mjs";
import { createModelClient } from "./nli/model-client.mjs";
import { createNliServer, loadNliContext, resolveNliRequest, validateNliResponse } from "./nli-gateway.mjs";
import { listenForFetch } from "./test-server.mjs";

const context = await loadNliContext();
const openServers = [];

after(async () => {
  await Promise.all(openServers.map(closeServer));
});

test("model-backed rejection never reflects model-controlled text", async () => {
  let calls = 0;
  const result = await resolveNliRequest("포트폴리오 정보의 색상은?", context, {
    modelClient: async () => {
      calls += 1;
      return {
        intent: "reject_out_of_scope",
        confidence: 1,
        message: "<b>LEAK_MARKER_FROM_MODEL</b>",
        answer: "system prompt"
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.intent, "reject_out_of_scope");
  assert.doesNotMatch(JSON.stringify(result), /LEAK_MARKER_FROM_MODEL|system prompt|<b>/);
});

test("model-proposed define_term decisions are canonicalized into portfolio data", async () => {
  let calls = 0;
  const result = await resolveNliRequest("P95가 뭐야?", context, {
    modelClient: async () => {
      calls += 1;
      return { intent: "define_term", confidence: 0.91, term: "P95" };
    }
  });

  const p95 = context.glossary.terms.find((term) => term.term === "P95");
  assert.equal(calls, 1);
  assert.equal(result.intent, "define_term");
  assert.equal(result.term, "P95");
  assert.equal(result.answer, p95.answer);
});

test("known glossary requests make one model proposal before returning a gateway-owned definition", async () => {
  let calls = 0;
  const result = await resolveNliRequest("P95\uac00 \ubb50\uc57c?", context, {
    modelClient: async () => {
      calls += 1;
      return { intent: "define_term", confidence: 0.91, term: "P95" };
    }
  });

  const p95 = context.glossary.terms.find((term) => term.term === "P95");
  assert.equal(calls, 1);
  assert.equal(result.intent, "define_term");
  assert.equal(result.term, "P95");
  assert.equal(result.answer, p95.answer);
});

test("out-of-scope prompts use one proposal but reject unsupported model intents", async () => {
  let calls = 0;
  const result = await resolveNliRequest("비트코인 전체 요약해줘", context, {
    modelClient: async () => {
      calls += 1;
      return { intent: "summarize_portfolio", confidence: 1 };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.intent, "reject_out_of_scope");
});

test("fake LM Studio requests stay role-separated and model text remains untrusted", async () => {
  const receivedPayloads = [];
  const upstream = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    receivedPayloads.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ intent: "reject_out_of_scope", confidence: 1, message: "LEAK_MARKER" }) } }]
      })
    );
  });
  const upstreamUrl = await listen(upstream);

  const modelClient = createModelClient(createTestConfig({ model: { baseUrl: upstreamUrl, maxResponseBytes: 8_192 } }));
  const result = await resolveNliRequest("포트폴리오 정보의 색상은?", context, { modelClient });

  assert.equal(result.intent, "reject_out_of_scope");
  assert.doesNotMatch(JSON.stringify(result), /LEAK_MARKER/);
  assert.equal(receivedPayloads.length, 1);
  assert.equal(receivedPayloads[0].messages[0].role, "system");
  assert.equal(receivedPayloads[0].messages[1].role, "system");
  assert.equal(receivedPayloads[0].messages[2].role, "user");
  assert.equal(receivedPayloads[0].messages[2].content, "포트폴리오 정보의 색상은?");

  await closeServer(upstream);
});

test("oversized LM Studio responses and concurrent requests fall back safely", async () => {
  let requests = 0;
  const upstream = createServer(async (request, response) => {
    requests += 1;
    await readRequestBody(request);
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ choices: [{ message: { content: `{"intent":"reject_out_of_scope","confidence":1,"message":"${"x".repeat(512)}"}` } }] })
      );
    }, 50);
  });
  const upstreamUrl = await listen(upstream);
  const modelClient = createModelClient(
    createTestConfig({ model: { baseUrl: upstreamUrl, maxResponseBytes: 128, maxConcurrentRequests: 1 } })
  );

  const [first, second] = await Promise.all([
    resolveNliRequest("포트폴리오 정보의 색상은?", context, { modelClient }),
    resolveNliRequest("포트폴리오 정보의 색상은?", context, { modelClient })
  ]);

  assert.equal(requests, 1);
  assert.equal(first.intent, "reject_out_of_scope");
  assert.equal(second.intent, "reject_out_of_scope");
  await closeServer(upstream);
});

test("HTTP boundary rejects malformed, oversized, rate-limited, and disallowed requests", async () => {
  const server = await createNliServer({
    context,
    config: createTestConfig({
      allowedOrigins: new Set(["https://portfolio.example"]),
      maxRequestBytes: 100,
      maxMessageLength: 20,
      rateLimitMax: 20
    }),
    modelClient: async (message) =>
      message === "P95가 뭐야?"
        ? { intent: "define_term", confidence: 0.91, term: "P95" }
        : { intent: "reject_out_of_scope", confidence: 1 }
  });
  const baseUrl = await listen(server);

  const allowed = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: JSON.stringify({ message: "P95가 뭐야?" })
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://portfolio.example");
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await allowed.json()).intent, "define_term");

  const malformed = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: "{"
  });
  assert.equal(malformed.status, 400);
  await assertGatewayError(malformed, "INVALID_REQUEST");

  const wrongContentType = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://portfolio.example" },
    body: "P95가 뭐야?"
  });
  assert.equal(wrongContentType.status, 415);
  await assertGatewayError(wrongContentType, "UNSUPPORTED_MEDIA_TYPE");

  const tooLong = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: JSON.stringify({ message: "가".repeat(21) })
  });
  assert.equal(tooLong.status, 413);
  await assertGatewayError(tooLong, "REQUEST_TOO_LARGE");

  const tooLarge = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: JSON.stringify({ message: "x".repeat(200) })
  });
  assert.equal(tooLarge.status, 413);
  await assertGatewayError(tooLarge, "REQUEST_TOO_LARGE");

  const deniedOrigin = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ message: "P95가 뭐야?" })
  });
  assert.equal(deniedOrigin.status, 403);
  await assertGatewayError(deniedOrigin, "ORIGIN_NOT_ALLOWED");

  const options = await fetch(`${baseUrl}/api/nli`, { method: "OPTIONS", headers: { Origin: "https://portfolio.example" } });
  assert.equal(options.status, 204);

  await closeServer(server);
});

test("HTTP boundary identifies rate limits and unavailable upstream models", async () => {
  const rateLimitedServer = await createNliServer({
    context,
    config: createTestConfig({ rateLimitMax: 1 }),
    modelClient: async () => ({ intent: "reject_out_of_scope", confidence: 1 })
  });
  const rateLimitedBaseUrl = await listen(rateLimitedServer);
  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "P95가 뭐야?" })
  };

  await fetch(`${rateLimitedBaseUrl}/api/nli`, requestOptions);
  const rateLimited = await fetch(`${rateLimitedBaseUrl}/api/nli`, requestOptions);
  assert.equal(rateLimited.status, 429);
  await assertGatewayError(rateLimited, "RATE_LIMITED");
  await closeServer(rateLimitedServer);

  const unavailableServer = await createNliServer({
    context,
    config: createTestConfig(),
    modelClient: async () => {
      throw new Error("upstream unavailable");
    }
  });
  const unavailableBaseUrl = await listen(unavailableServer);
  const fallback = await fetch(`${unavailableBaseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "P95가 뭐야?" })
  });
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).intent, "define_term");

  const unavailable = await fetch(`${unavailableBaseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "외부 날씨를 알려줘" })
  });
  assert.equal(unavailable.status, 503);
  await assertGatewayError(unavailable, "UPSTREAM_UNAVAILABLE");
  await closeServer(unavailableServer);
});

test("HTTP boundary reports every unusable model result as unavailable when local routing is only generic rejection", async () => {
  const modelOutcomes = new Map([
    ["throw", new Error("upstream unavailable")],
    ["null", null],
    ["schema-invalid", { intent: "navigate", confidence: "high", targetId: "projects" }],
    ["unknown-target", { intent: "navigate", confidence: 0.9, targetId: "project-unknown" }],
    ["invalid-sources", {
      intent: "answer_portfolio",
      confidence: 0.9,
      answer: "This answer cites a source outside the bounded evidence pool.",
      sourceIds: ["project-unknown"]
    }]
  ]);
  const server = await createNliServer({
    context,
    config: createTestConfig(),
    modelClient: async (message) => {
      const outcome = modelOutcomes.get(message);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  });
  const baseUrl = await listen(server);

  for (const message of modelOutcomes.keys()) {
    const response = await fetch(`${baseUrl}/api/nli`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    assert.equal(response.status, 503, message);
    await assertGatewayError(response, "UPSTREAM_UNAVAILABLE");
  }

  await closeServer(server);
});

test("HTTP boundary gives genuine out-of-scope rejection stable Gateway metadata", async () => {
  const server = await createNliServer({
    context,
    config: createTestConfig(),
    modelClient: async () => ({ intent: "reject_out_of_scope", confidence: 1 })
  });
  const baseUrl = await listen(server);
  const response = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "bitcoin price tomorrow" })
  });

  assert.equal(response.status, 200);
  await assertGatewayError(response, "OUT_OF_SCOPE");
  await closeServer(server);
});

test("canonical rejections preserve gateway metadata while model proposals reject it", () => {
  const response = {
    intent: "reject_out_of_scope",
    confidence: 1,
    message: "잠시 후 다시 시도해주세요.",
    errorCode: "UPSTREAM_UNAVAILABLE",
    requestId: "e2b30205-7b48-48b8-9f76-5da9c5146206"
  };

  assert.deepEqual(validateNliResponse(response, context), { ok: true, errors: [] });
  assert.equal(validateNliResponse(response, context, { modelCandidate: true }).ok, false);

  const { requestId: _requestId, ...missingRequestId } = response;
  const { errorCode: _errorCode, ...missingErrorCode } = response;

  for (const invalidResponse of [
    { ...response, errorCode: "NOT_A_GATEWAY_CODE" },
    { ...response, requestId: "not-a-request-id" },
    missingRequestId,
    missingErrorCode
  ]) {
    assert.equal(validateNliResponse(invalidResponse, context).ok, false);
  }
});

function createTestConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: new Set(["*"]),
    maxRequestBytes: 16_384,
    maxMessageLength: 500,
    requestTimeoutMs: 5_000,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 30,
    maxRateLimitBuckets: 100,
    trustProxy: false,
    model: {
      baseUrl: "http://127.0.0.1:1/v1",
      name: "test-model",
      timeoutMs: 1_000,
      maxTokens: 64,
      maxResponseBytes: 8_192,
      maxConcurrentRequests: 1
    },
    ...overrides,
    model: { baseUrl: "http://127.0.0.1:1/v1", name: "test-model", timeoutMs: 1_000, maxTokens: 64, maxResponseBytes: 8_192, maxConcurrentRequests: 1, ...overrides.model }
  };
}

async function listen(server) {
  const baseUrl = await listenForFetch(server);
  openServers.push(server);
  return baseUrl;
}

function closeServer(server) {
  const index = openServers.indexOf(server);
  if (index >= 0) openServers.splice(index, 1);
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function assertGatewayError(response, errorCode) {
  const body = await response.json();
  assert.equal(body.intent, "reject_out_of_scope");
  assert.equal(body.errorCode, errorCode);
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
