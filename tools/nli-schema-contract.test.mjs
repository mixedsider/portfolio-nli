import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { matchesJsonSchema } from "./testing/json-schema.mjs";

import { createGatewayConfig } from "./nli/config.mjs";
import { createNliServer, loadNliContext } from "./nli-gateway.mjs";
import { listenForFetch } from "./test-server.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const context = await loadNliContext();

test("prompt declares exactly the four mutually exclusive model fieldsets", async () => {
  const prompt = await readFile(resolve(root, "nli/system-prompt.md"), "utf8");
  const fieldsets = Object.fromEntries([...prompt.matchAll(/`(\w+)`: `([\w,]+)`/g)]
    .map((match) => [match[1], match[2].split(",").sort()]));
  assert.deepEqual(fieldsets, {
    reject_out_of_scope: ["confidence", "intent"],
    navigate: ["confidence", "intent", "targetId"],
    define_term: ["confidence", "intent", "term"],
    answer_portfolio: ["answer", "confidence", "intent", "sourceIds"]
  });
});

test("prompt routing table prioritizes supported summaries over navigation and refusal", async () => {
  const prompt = await readFile(resolve(root, "nli/system-prompt.md"), "utf8");
  const tables = [...prompt.matchAll(/`(\{"요약\/설명\+candidateSources":.*?\})`/g)]
    .map((match) => JSON.parse(match[1]));
  assert.deepEqual(tables, [{
    "요약/설명+candidateSources": "answer_portfolio",
    "explicit portfolio move+exact targets ID": "navigate",
    "ordinary definition": "define_term",
    "external/no evidence": "reject_out_of_scope"
  }]);
  assert.deepEqual(Object.values(tables[0]), ["answer_portfolio", "navigate", "define_term", "reject_out_of_scope"]);
});

test("scope instruction precedes navigation and forbids invented IDs", async () => {
  const prompt = await readFile(resolve(root, "nli/system-prompt.md"), "utf8");
  const scope = prompt.match(/scope\s+before\s+action/i);
  assert.ok(scope);
  assert.ok(scope.index < prompt.indexOf('"explicit portfolio move+exact targets ID"'));
  assert.match(prompt, /never\s+invent\s+IDs/i);
  assert.match(prompt, /reject\b[^\n]*external\b[^\n]*current weather\b/i);
});

test("overview guidance limits ordinary summaries to one inline label-and-purpose sentence", async () => {
  const prompt = await readFile(resolve(root, "nli/system-prompt.md"), "utf8");
  const overview = prompt.match(/Overview:.*?(?= One-section)/u)?.[0];
  assert.ok(overview);
  assert.match(overview, /ONE short .* sentence ONLY/u);
  assert.match(overview, /`<label>: <copied purpose>\.`/u);
  assert.match(overview, /no heading\/unasked dates\/tech\/implementation\/results/u);
});

test("NLI schemas remain parseable and reserve answer fields for answer_portfolio", async () => {
  const modelDecisionSchema = await readJson("nli/model-decision.schema.json");
  const legacyCandidate = {
    intent: "navigate",
    confidence: 0.91,
    targetId: "projects",
    answer: "This answer must not be accepted for a legacy intent.",
    sourceIds: ["project-catequest"]
  };
  const portfolioCandidate = {
    intent: "answer_portfolio",
    confidence: 0.87,
    answer: "CateQuest에서 확인 가능한 경험을 바탕으로 답변합니다.",
    sourceIds: ["project-catequest"]
  };

  assert.equal(matchesJsonSchema(modelDecisionSchema, legacyCandidate), false);
  assert.equal(matchesJsonSchema(modelDecisionSchema, portfolioCandidate), true);
  assert.equal(matchesJsonSchema(modelDecisionSchema, { ...portfolioCandidate, targetId: "projects" }), false);
  assert.equal(matchesJsonSchema(modelDecisionSchema, {
    intent: "summarize_project",
    confidence: 0.9,
    targetId: "project-catequest"
  }), false);

  for (const relativePath of ["nli/intents.json", "nli/model-decision.schema.json", "nli/response.schema.json"]) {
    const source = await readFile(resolve(root, relativePath), "utf8");
    assert.doesNotThrow(() => JSON.parse(source), relativePath);
  }
});

test("response schema accepts an actual Gateway rejection and rejects malformed error metadata", async () => {
  const responseSchema = await readJson("nli/response.schema.json");
  const server = await createNliServer({
    context,
    config: createGatewayConfig({
      NLI_ALLOWED_ORIGINS: "*",
      NLI_RATE_LIMIT_MAX: "30",
      LM_STUDIO_BASE_URL: "http://127.0.0.1:1/v1"
    }),
    modelClient: async () => {
      throw new Error("schema contract upstream failure");
    }
  });
  const baseUrl = await listenForFetch(server);

  try {
    const response = await fetch(`${baseUrl}/api/nli`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "unhandled-schema-contract-probe" })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(matchesJsonSchema(responseSchema, body), true);
    assert.equal(matchesJsonSchema(responseSchema, { ...body, errorCode: "NOT_A_GATEWAY_CODE" }), false);
    assert.equal(matchesJsonSchema(responseSchema, { ...body, requestId: "not-a-request-id" }), false);
    const { requestId: _requestId, ...missingRequestId } = body;
    assert.equal(matchesJsonSchema(responseSchema, missingRequestId), false);
  } finally {
    await new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
}
