import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createGatewayConfig } from "./nli/config.mjs";
import { isOriginAllowed } from "./nli/http.mjs";
import { createModelClient } from "./nli/model-client.mjs";
import { resolveLocally } from "./nli/router.mjs";
import { createNliServer, loadNliContext, resolveNliRequest, validateNliResponse } from "./nli-gateway.mjs";

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

test("grounded model decisions are canonicalized into portfolio data", async () => {
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

test("out-of-scope prompts never call the model or accept a valid-looking intent", async () => {
  let calls = 0;
  const result = await resolveNliRequest("비트코인 전체 요약해줘", context, {
    modelClient: async () => {
      calls += 1;
      return { intent: "summarize_portfolio", confidence: 1 };
    }
  });

  assert.equal(calls, 0);
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

  const wrongContentType = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://portfolio.example" },
    body: "P95가 뭐야?"
  });
  assert.equal(wrongContentType.status, 415);

  const tooLong = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: JSON.stringify({ message: "가".repeat(21) })
  });
  assert.equal(tooLong.status, 413);

  const tooLarge = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://portfolio.example" },
    body: JSON.stringify({ message: "x".repeat(200) })
  });
  assert.equal(tooLarge.status, 413);

  const deniedOrigin = await fetch(`${baseUrl}/api/nli`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ message: "P95가 뭐야?" })
  });
  assert.equal(deniedOrigin.status, 403);

  const options = await fetch(`${baseUrl}/api/nli`, { method: "OPTIONS", headers: { Origin: "https://portfolio.example" } });
  assert.equal(options.status, 204);

  await closeServer(server);
});

test("rate limits ignore spoofed forwarding headers unless trusted proxy mode is enabled", async () => {
  const server = await createNliServer({
    context,
    config: createTestConfig({ rateLimitMax: 2, allowedOrigins: new Set(["*"]) }),
    modelClient: async () => ({ intent: "reject_out_of_scope", confidence: 1 })
  });
  const baseUrl = await listen(server);
  const statuses = [];

  for (const forwardedFor of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    const response = await fetch(`${baseUrl}/api/nli`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify({ message: "P95가 뭐야?" })
    });
    statuses.push(response.status);
  }

  assert.deepEqual(statuses, [200, 200, 429]);
  await closeServer(server);
});

test("browser origins fail closed until an exact origin is configured", () => {
  const defaultConfig = createGatewayConfig({});
  assert.equal(defaultConfig.allowedOrigins.size, 0);
  assert.equal(isOriginAllowed({ headers: { origin: "https://attacker.example" } }, defaultConfig), false);
  assert.equal(isOriginAllowed({ headers: {} }, defaultConfig), true);

  const configured = createGatewayConfig({ NLI_ALLOWED_ORIGINS: "https://portfolio.example" });
  assert.equal(isOriginAllowed({ headers: { origin: "https://portfolio.example" } }, configured), true);
  assert.equal(isOriginAllowed({ headers: { origin: "https://attacker.example" } }, configured), false);
});

test("health identifies the running deployment revision", async () => {
  const server = await createNliServer({
    context,
    config: createTestConfig({ releaseRevision: "9d5621b4cf5b66bb9b3974650fd194129eaaf4ab" })
  });
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/api/nli/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    targets: context.routes.targets.length,
    terms: context.glossary.terms.length,
    revision: "9d5621b4cf5b66bb9b3974650fd194129eaaf4ab",
    processId: process.pid
  });

  await closeServer(server);
});

test("health responses fingerprint the checked-out revision and running process", async () => {
  const checkedOutRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const server = await createNliServer({
    context,
    config: createTestConfig(),
    modelClient: async () => ({ intent: "reject_out_of_scope", confidence: 1 })
  });
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/api/nli/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.targets, context.routes.targets.length);
  assert.equal(body.terms, context.glossary.terms.length);
  assert.equal(body.revision, checkedOutRevision);
  assert.equal(body.processId, process.pid);

  await closeServer(server);
});

test("default rate limit accommodates the deployed functional and adversarial suites", async () => {
  const [functionalFixture, adversarialFixture] = await Promise.all([
    readJson("nli/live-test-cases.json"),
    readJson("nli/adversarial-test-cases.json")
  ]);
  const testCases = [
    ...functionalFixture.cases.filter((testCase) => testCase.kind === "success"),
    ...adversarialFixture.cases
  ];
  assert.equal(testCases.length, 26);

  const server = await createNliServer({
    context,
    config: createTestConfig({ rateLimitMax: 30, allowedOrigins: new Set(["*"]) }),
    modelClient: async (message, nliContext) => toModelDecision(resolveLocally(message, nliContext))
  });
  const baseUrl = await listen(server);

  for (const testCase of testCases) {
    const response = await fetch(`${baseUrl}/api/nli`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: testCase.message, currentTargetId: testCase.currentTargetId })
    });
    assert.equal(response.status, 200, testCase.message);
  }

  await closeServer(server);
});

test("response contracts reject fields that do not belong to the selected intent", () => {
  const result = validateNliResponse(
    { intent: "navigate", confidence: 1, targetId: "projects", message: "이동", answer: "untrusted" },
    context
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /answer is not allowed/);

  const missingRelatedTargets = validateNliResponse(
    { intent: "define_term", confidence: 1, term: "P95", message: "설명", answer: "설명" },
    context
  );
  assert.equal(missingRelatedTargets.ok, false);
  assert.match(missingRelatedTargets.errors.join("\n"), /relatedTargets is required/);

  const oversizedMessage = validateNliResponse(
    { intent: "navigate", confidence: 1, targetId: "projects", message: "x".repeat(501) },
    context
  );
  assert.equal(oversizedMessage.ok, false);
  assert.match(oversizedMessage.errors.join("\n"), /message must be at most 500 characters/);

  const modelExtraField = validateNliResponse(
    { intent: "define_term", confidence: 1, term: "P95", message: "model-controlled" },
    context,
    { modelCandidate: true }
  );
  assert.equal(modelExtraField.ok, false);
  assert.match(modelExtraField.errors.join("\n"), /unknown property: message/);
});

test("intent definitions, schemas, and fixtures remain aligned", async () => {
  const [intentsFile, responseSchemaFile, decisionSchemaFile, adversarialFixture] = await Promise.all([
    readJson("nli/intents.json"),
    readJson("nli/response.schema.json"),
    readJson("nli/model-decision.schema.json"),
    readJson("nli/adversarial-test-cases.json")
  ]);
  const intentNames = intentsFile.intents.map((intent) => intent.name).sort();
  const responseIntentNames = Object.values(responseSchemaFile.$defs)
    .map((definition) => definition?.properties?.intent?.const)
    .filter(Boolean)
    .sort();
  assert.deepEqual(responseIntentNames, intentNames);
  assert.deepEqual([...decisionSchemaFile.properties.intent.enum].sort(), intentNames);
  assert.ok(adversarialFixture.cases.every((testCase) => testCase.kind === "failure"));
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

function listen(server) {
  openServers.push(server);
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  const index = openServers.indexOf(server);
  if (index >= 0) openServers.splice(index, 1);
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

function toModelDecision(response) {
  const decision = { intent: response.intent, confidence: response.confidence };
  if (response.targetId) decision.targetId = response.targetId;
  if (response.term) decision.term = response.term;
  return decision;
}
