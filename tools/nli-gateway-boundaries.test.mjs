import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { createGatewayConfig } from "./nli/config.mjs";
import { isOriginAllowed } from "./nli/http.mjs";
import { resolveLocally } from "./nli/router.mjs";
import { createNliServer, loadNliContext, resolveNliRequest, validateNliResponse } from "./nli-gateway.mjs";
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

test("single-target show requests use one model proposal before gateway-owned navigation", async () => {
  const modelCalls = [];
  const modelClient = async (message) => {
    modelCalls.push(message);
    return {
      intent: "navigate",
      confidence: 0.9,
      targetId: message.includes("CloudWatch") ? "project-makertion-observability" : "project-makertion-db"
    };
  };

  for (const [message, targetId] of [
    ["DB 최적화 보여줘", "project-makertion-db"],
    ["CloudWatch 모니터링 보여줘", "project-makertion-observability"]
  ]) {
    const result = await resolveNliRequest(message, context, { modelClient });

    assert.equal(result.intent, "navigate");
    assert.equal(result.targetId, targetId);
  }

  assert.equal(modelCalls.length, 2);
});

test("known project aliases resolve to their deterministic project response", async () => {
  for (const [message, intent, targetId] of [
    ["Cate Quest 프로젝트를 요약해줘", "summarize_project", "project-catequest"],
    ["카테 퀘스트 프로젝트를 요약해줘", "summarize_project", "project-catequest"],
    ["카테 퀘 스트 프로젝트로 이동해줘", "navigate", "project-catequest"],
    ["북 킹 프로젝트를 요약해줘", "summarize_project", "project-bookking"],
    ["오늘의OTT 프로젝트를 요약해줘", "summarize_project", "project-ott"],
    ["오늘의 오티티 프로젝트로 이동해줘", "navigate", "project-ott"],
    ["오티티 프로젝트로 이동해줘", "navigate", "project-ott"],
    ["메이커션 프로젝트 설명해줘", "summarize_project", "project-makertion"]
  ]) {
    const result = await resolveNliRequest(message, context, { useModel: false });

    assert.equal(result.intent, intent, message);
    assert.equal(result.targetId, targetId, message);
  }
});

test("local project summaries do not consult a model", async () => {
  const result = await resolveNliRequest("Cate Quest 프로젝트를 요약해줘", context, {
    modelClient: async () => { throw new Error("local project summaries must not call the model"); }
  });

  assert.equal(result.intent, "summarize_project");
  assert.equal(result.targetId, "project-catequest");
});

test("a conflicting model proposal cannot override a known local navigation target", async () => {
  const result = await resolveNliRequest("CateQuest 프로젝트로 이동해줘", context, {
    modelClient: async () => ({ intent: "navigate", confidence: 0.99, targetId: "projects" })
  });

  assert.equal(result.targetId, "project-catequest");
});

test("category examples with show wording use grounded synthesis", async () => {
  const responses = new Map([
    [
      "성능을 최적화한 사례를 보여줘",
      {
        intent: "answer_portfolio",
        confidence: 0.92,
        answer: "DB 파라미터 튜닝과 부하 테스트로 평균 응답과 P95 지연을 줄인 사례입니다. 메인 페이지 읽기 API에 캐싱을 적용해 P95와 DB 부하를 줄인 사례입니다. DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄인 사례입니다. Cloudflare 경유 구조를 AWS Native 구조로 전환해 응답 지연을 줄인 사례입니다.",
        sourceIds: ["project-makertion-db", "project-makertion-cache", "project-catequest-n1", "project-bookking-https"]
      }
    ],
    [
      "AWS 경험을 보여줘",
      {
        intent: "answer_portfolio",
        confidence: 0.9,
        answer: "AWS 기반 CloudWatch 모니터링과 AWS Native HTTPS 아키텍처를 운영했습니다.",
        sourceIds: ["project-makertion-db", "project-bookking-https"]
      }
    ]
  ]);
  const modelCalls = [];
  const modelClient = async (message, _nliContext, groundedRequest) => {
    modelCalls.push(message);
    const response = responses.get(message);

    assert.ok(response);
    assert.ok(response.sourceIds.every((sourceId) => groundedRequest.candidateSources.some((source) => source.id === sourceId)));
    return response;
  };

  for (const [message, expected] of responses) {
    const result = await resolveNliRequest(message, context, { modelClient });

    assert.equal(result.intent, "answer_portfolio");
    assert.deepEqual(result.sources.map((source) => source.id), expected.sourceIds);
  }

  assert.deepEqual(modelCalls, [...responses.keys()]);
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
  assert.equal(testCases.length, 40);

  const server = await createNliServer({
    context,
    config: createTestConfig({ rateLimitMax: testCases.length + 1, allowedOrigins: new Set(["*"]) }),
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
  assert.deepEqual([...decisionSchemaFile.properties.intent.enum].sort(), [
    "answer_portfolio",
    "define_term",
    "navigate",
    "reject_out_of_scope"
  ]);
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
