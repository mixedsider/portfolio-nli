import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createGatewayConfig } from "./nli/config.mjs";
import { createNliServer, loadNliContext, resolveNliRequest } from "./nli-gateway.mjs";
import { listenForFetch } from "./test-server.mjs";

const context = await loadNliContext();
const awsQuestion = "AWS 경험을 설명해줘";
const cloudWatchExperienceQuestion = "CloudWatch를 사용한 모니터링과 관측성 경험을 설명해줘.";
const currentTargetId = "project-makertion-db";

test("gateway sends bounded proposal context to a loopback LM", async () => {
  const history = [
    { role: "user", text: "성능을 최적화한 사례를 보여줘" },
    { role: "assistant", text: "성능 개선 사례를 정리했습니다." }
  ];
  let receivedPayload = null;
  const upstream = createServer(async (request, response) => {
    receivedPayload = JSON.parse(await readRequestBody(request));
    const envelope = JSON.parse(receivedPayload.messages[1].content);
    const source = envelope.candidateSources[0];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              intent: "answer_portfolio",
              confidence: 0.86,
              answer: source ? groundedAnswerFromSource(source) : "",
              sourceIds: source ? [source.id] : []
            })
          }
        }]
      })
    );
  });
  const upstreamUrl = await listenForFetch(upstream);
  const gateway = await createNliServer({
    context,
    config: createTestConfig({ model: { baseUrl: upstreamUrl } })
  });
  const gatewayUrl = await listenForFetch(gateway);

  try {
    const response = await fetch(gatewayUrl + "/api/nli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: awsQuestion, history, currentTargetId })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.intent, "answer_portfolio");
    assert.equal(receivedPayload.messages.length, 3);

    const envelope = JSON.parse(receivedPayload.messages[1].content);
    assert.deepEqual(Object.keys(envelope).sort(), ["candidateSources", "conversation", "currentTargetId", "targets", "terms", "untrustedData"]);
    assert.equal(envelope.untrustedData, true);
    assert.deepEqual(envelope.conversation, history);
    assert.equal(envelope.currentTargetId, currentTargetId);
    assert.ok(envelope.targets.some((target) => target.id === currentTargetId));
    assert.ok(envelope.terms.some((term) => term.term === "P95"));
    assert.ok(envelope.candidateSources.length > 0 && envelope.candidateSources.length <= 8);
    assert.ok(envelope.candidateSources.every((candidate) => candidate.id === candidate.targetId));
    assert.equal(Object.hasOwn(envelope, "projects"), false);
    assert.equal(Object.hasOwn(envelope, "routes"), false);
  } finally {
    await close(upstream);
    await close(gateway);
  }
});

test("broad evidence-backed questions and explicit targets each use one model proposal", async () => {
  let modelCalls = 0;
  const modelClient = async (_message, _nliContext, groundedRequest) => {
    modelCalls += 1;
    assert.ok(groundedRequest.candidateSources.length > 0 && groundedRequest.candidateSources.length <= 8);
    if (_message.startsWith("DB ")) {
      return { intent: "navigate", confidence: 0.9, targetId: currentTargetId };
    }
    return {
      intent: "answer_portfolio",
      confidence: 0.82,
      answer: groundedAnswerFromSource(groundedRequest.candidateSources[0]),
      sourceIds: [groundedRequest.candidateSources[0].id]
    };
  };

  const broad = await resolveNliRequest(awsQuestion, context, { modelClient });
  const direct = await resolveNliRequest("DB 최적화 보여줘", context, { modelClient });

  assert.equal(modelCalls, 2);
  assert.equal(broad.intent, "answer_portfolio");
  assert.equal(direct.intent, "navigate");
  assert.equal(direct.targetId, currentTargetId);
});

test("CloudWatch experience wording uses grounded portfolio answer rather than glossary definition", async () => {
  let modelCalls = 0;
  const modelClient = async (_message, _nliContext, groundedRequest) => {
    modelCalls += 1;
    assert.ok(groundedRequest.candidateSources.some((source) => source.id === "project-makertion-observability"));
    return {
      intent: "answer_portfolio",
      confidence: 0.88,
      answer: "CloudWatch 모니터링 구축으로 API 지표와 오류율, 지연 시간을 운영에서 확인했습니다.",
      sourceIds: ["project-makertion-observability"]
    };
  };

  const result = await resolveNliRequest(cloudWatchExperienceQuestion, context, { modelClient });

  assert.equal(modelCalls, 1);
  assert.equal(result.intent, "answer_portfolio");
  assert.deepEqual(result.sources.map((source) => source.id), ["project-makertion-observability"]);
});

test("explicit CloudWatch monitoring navigation falls back safely after one unavailable proposal", async () => {
  let modelCalls = 0;
  const modelClient = async () => {
    modelCalls += 1;
    return null;
  };

  const result = await resolveNliRequest("CloudWatch 모니터링 보고 싶어", context, { history: [], modelClient });

  assert.equal(modelCalls, 1);
  assert.equal(result.intent, "navigate");
  assert.equal(result.targetId, "project-makertion-observability");
});

test("target-like requests use validated model navigation while broader requests use grounded answers", async () => {
  const modelCalls = [];
  const modelClient = async (message, _nliContext, groundedRequest) => {
    modelCalls.push({ message, candidateCount: groundedRequest.candidateSources.length });
    if (message === "P95" || message === "open P95") {
      return { intent: "navigate", confidence: 0.9, targetId: currentTargetId };
    }
    return {
      intent: "answer_portfolio",
      confidence: 0.82,
      answer: groundedAnswerFromSource(groundedRequest.candidateSources[0]),
      sourceIds: [groundedRequest.candidateSources[0].id]
    };
  };

  const targetOnly = await resolveNliRequest("P95", context, { modelClient });
  assert.equal(targetOnly.intent, "navigate");
  assert.equal(targetOnly.targetId, currentTargetId);
  assert.equal(modelCalls.length, 1);

  const explicitEnglishNavigation = await resolveNliRequest("open P95", context, { modelClient });
  assert.equal(explicitEnglishNavigation.intent, "navigate");
  assert.equal(explicitEnglishNavigation.targetId, currentTargetId);
  assert.equal(modelCalls.length, 2);

  const categoryCapable = await resolveNliRequest("open AWS experience", context, { modelClient });
  assert.equal(categoryCapable.intent, "answer_portfolio");
  assert.equal(modelCalls.length, 3);
  assert.ok(modelCalls[2].candidateCount > 0 && modelCalls[2].candidateCount <= 8);

  const broad = await resolveNliRequest("DB 최적화는 어디에 있나요?", context, { modelClient });
  assert.equal(broad.intent, "answer_portfolio");
  assert.equal(modelCalls.length, 4);
  assert.ok(modelCalls[3].candidateCount > 0 && modelCalls[3].candidateCount <= 8);
});

test("model timeout, invalid JSON, and invalid source IDs fall back to a trusted local answer", async () => {
  for (const modelClient of [
    async () => {
      throw new Error("loopback timeout");
    },
    async () => null,
    async () => ({
      intent: "answer_portfolio",
      confidence: 0.9,
      answer: "잘못된 출처를 가진 답변입니다.",
      sourceIds: ["project-not-a-source"]
    }),
    async () => ({
      intent: "answer_portfolio",
      confidence: 0.9,
      answer: "NASA, Go, Kubernetes leadership claims are the strongest portfolio evidence.",
      sourceIds: ["project-makertion-db"]
    })
  ]) {
    let calls = 0;
    const countedClient = async (...args) => {
      calls += 1;
      return modelClient(...args);
    };
    const result = await resolveNliRequest(awsQuestion, context, { modelClient: countedClient });

    assert.equal(calls, 1);
    assert.equal(result.intent, "list_skill_experience");
    assert.equal(result.term, "AWS");
  }
});

test("joined mixed grounded and hallucinated model answer falls back to local resolution", async () => {
  let calls = 0;
  const modelClient = async (_message, _nliContext, groundedRequest) => {
    calls += 1;
    const source = groundedRequest.candidateSources.find((candidate) => candidate.id === "project-makertion-cache");
    return {
      intent: "answer_portfolio",
      confidence: 0.9,
      answer: "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms and NASA Kubernetes Go leadership is also proven.",
      sourceIds: [source?.id || groundedRequest.candidateSources[0].id]
    };
  };

  const result = await resolveNliRequest(awsQuestion, context, { modelClient });

  assert.equal(calls, 1);
  assert.equal(result.intent, "list_skill_experience");
  assert.equal(result.term, "AWS");
  assert.doesNotMatch(JSON.stringify(result), /NASA|Kubernetes|Go leadership/);
});

function createTestConfig(overrides = {}) {
  const defaults = createGatewayConfig({
    NLI_ALLOWED_ORIGINS: "*",
    NLI_MAX_REQUEST_BYTES: "16384",
    NLI_MAX_MESSAGE_LENGTH: "500",
    NLI_REQUEST_TIMEOUT_MS: "5000",
    NLI_RATE_LIMIT_MAX: "30",
    LM_STUDIO_BASE_URL: "http://127.0.0.1:1/v1",
    LM_STUDIO_TIMEOUT_MS: "1000",
    LM_STUDIO_MAX_RESPONSE_BYTES: "8192",
    LM_STUDIO_MAX_CONCURRENT_REQUESTS: "1"
  });
  return {
    ...defaults,
    ...overrides,
    model: { ...defaults.model, ...overrides.model }
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function groundedAnswerFromSource(source) {
  return String(source?.evidence || "")
    .split(/\n+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}
