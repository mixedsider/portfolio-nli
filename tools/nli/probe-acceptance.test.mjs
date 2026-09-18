import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { prepareProbeCases } from "./probe-request.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { createGatewayConfig } from "./config.mjs";
import { runProbe } from "./probe-runner.mjs";
import { runQwenVerification } from "./probe-verification.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const fixtures = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));
const item = prepareProbeCases(fixtures, context).find((row) => row.id === "comparison");
const scopedContext = { ...context, currentTargetId: item.currentTargetId, history: item.history };
const prepared = prepareGroundedRequest(item.message, scopedContext);
const formerFalseProof = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";

for (const endpoint of ["lfm", "qwen"]) for (const correct of [false, true]) {
  test(`${endpoint}: probe equals production for ${correct ? "low-confidence complete comparison" : "former false comparison proof"}`, () => {
    const candidate = { intent: "answer_portfolio", confidence: 0.01, sourceIds: item.sourceIds,
      answer: correct ? formerFalseProof.replace("DB 접근을", "N+1 DB 접근을") : formerFalseProof };
    const data = { model: "fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) } }] };
    const outcome = inspectModelCompletion(data, endpoint);
    outcome.metadata.endpoint = endpoint;
    const accepted = acceptTransportProposal(outcome, scopedContext, prepared, item.message);
    assert.equal(accepted.accepted, correct, JSON.stringify(accepted));
    if (!correct) assert.equal(accepted.reason, "subject_clause_missing");
    assert.equal(inspectProbeCompletion(data, item, context, endpoint).ok, accepted.accepted);
  });
}

test("probe exposes the actual frozen preparation, without changing serialized projection", () => {
  assert.ok(item.prepared && Object.isFrozen(item.prepared));
  assert.deepEqual(item.prepared, prepared);
  assert.equal(item.prepared.candidateSources, item.candidateSources);
  assert.equal(item.prepared.groundedRequestBlock, JSON.stringify(item.grounded));
});

function fixtureEnvelope(payload, correct) {
  const fixture = fixtures.find((row) => row.message === payload.messages[2].content);
  assert.ok(fixture);
  const expected = fixture.expected;
  let candidate = { intent: expected.intent, confidence: 0.01 };
  if (expected.targetId) candidate.targetId = expected.targetId;
  if (expected.term) candidate.term = expected.term;
  if (expected.intent === "answer_portfolio") {
    const available = JSON.parse(payload.messages[1].content).candidateSources;
    assert.ok(fixture.sourceIds.every((id) => available.some((card) => card.id === id)));
    const answer = fixture.id === "comparison" ? (correct ? formerFalseProof.replace("DB 접근을", "N+1 DB 접근을") : formerFalseProof) :
      fixture.id === "project-summary" ? `CateQuest ${context.projectByTargetId.get("project-catequest").description}` :
        `CateQuest N+1 ${context.sectionById.get("project-catequest-n1").result}`;
    candidate = { ...candidate, sourceIds: fixture.sourceIds, answer };
  }
  return { model: "fixture", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) } }] };
}

for (const endpoint of ["lfm", "qwen"]) for (const correct of [false, true]) {
  test(`${endpoint} issuance requires shared comparison acceptance, correct=${correct}`, async (t) => {
    const config = createGatewayConfig({ LFM_BASE_URL: "http://127.0.0.1:1/v1", LM_STUDIO_BASE_URL: "http://127.0.0.1:1/v1" });
    const directory = await mkdtemp(join(tmpdir(), "shared-proof-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const receipt = join(directory, "receipt.json");
    const dataFor = (url, payload) => {
      if (url.endsWith("/api/v0/models")) return { data: [{ id: config.lfm.name, state: "loaded" }] };
      if (url.endsWith("/props")) return { model_alias: "fixture", model_path: "/fixture", build_info: "fixture", chat_template: "fixture" };
      if (url.endsWith("/apply-template")) return { prompt: JSON.stringify(payload.messages) + "<|im_start|>assistant\n<think>\n</think>\n" };
      return fixtureEnvelope(payload, correct);
    };
    const report = endpoint === "qwen" ? await runQwenVerification({ settings: config.model, context, receipt }, {
      fetchImpl: async (url, options) => Response.json(dataFor(url, options.body ? JSON.parse(options.body) : undefined))
    }) : await runProbe({ endpoint, mode: "verify", settings: config.lfm, context,
      schema: JSON.parse(await readFile(new URL("../../nli/model-decision.schema.json", import.meta.url), "utf8")),
      cases: prepareProbeCases(fixtures, context) }, {
      request: async (url, options) => ({ ok: true, data: dataFor(url, options.payload) }),
      inspect: () => ({ ok: true }) // An obsolete inspection injection cannot bypass acceptance.
    });
    assert.equal(report.verified, correct);
    assert.equal(report.verificationPolicy, VERIFICATION_POLICY);
    if (endpoint === "qwen" && correct) {
      const proof = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(proof.verificationPolicy, VERIFICATION_POLICY);
      assert.equal(proof.probeCount, 18);
      assert.equal(report.results.length, 18);
    } else await assert.rejects(readFile(receipt));
    if (endpoint === "lfm") assert.equal(report.results.length, 12);
  });
}
