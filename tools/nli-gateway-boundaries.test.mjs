import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createGatewayConfig } from "./nli/config.mjs";
import { isOriginAllowed } from "./nli/http.mjs";
import { resolveLocally } from "./nli/router.mjs";
import { createNliServer, loadNliContext, validateNliResponse } from "./nli-gateway.mjs";
import { listenForFetch } from "./test-server.mjs";

const context = await loadNliContext();
const openServers = [];

after(async () => {
  await Promise.all(openServers.map(closeServer));
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

test("health responses tolerate an unavailable source revision and identify the running process", async () => {
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
  assert.ok(body.revision === null || /^[0-9a-f]{40}$/i.test(body.revision));
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

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

function toModelDecision(response) {
  const decision = { intent: response.intent, confidence: response.confidence };
  if (response.targetId) decision.targetId = response.targetId;
  if (response.term) decision.term = response.term;
  return decision;
}
