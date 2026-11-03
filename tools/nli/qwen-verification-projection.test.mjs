import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-client.mjs";
import { sha256, verificationInputs } from "./qwen-verification-proof.mjs";

const context = await loadNliContext(fileURLToPath(new URL("../../", import.meta.url)));
const REQUEST_BYTE_CEILINGS = Object.freeze({
  navigation: 18000,
  glossary: 21000,
  "project-summary": 18000,
  "section-explanation": 18000,
  comparison: 18000,
  "out-of-scope": 23000
});
const SYSTEM_PROMPT_BYTE_CEILING = 3500;

test("Qwen runtime prompt stays within the cold-prefill byte budget", () => {
  const settings = createGatewayConfig({}).model;
  const [{ payload }] = verificationInputs(settings, context).matrix;

  assert.ok(Buffer.byteLength(payload.messages[0].content) <= SYSTEM_PROMPT_BYTE_CEILING,
    `system prompt exceeds ${SYSTEM_PROMPT_BYTE_CEILING} bytes`);
  assert.match(context.prompt, /include requested quantities/);
});

test("all 18 verification payloads equal actual runtime projection in both configured modes", () => {
  for (const outputMode of ["json_schema", "plain"]) {
    const settings = { ...createGatewayConfig({}).model, outputMode };
    const inputs = verificationInputs(settings, context);
    assert.equal(inputs.matrix.length, 18);
    for (const { item, repeat, payload } of inputs.matrix) {
      const prepared = prepareGroundedRequest(item.message, {
        ...context, currentTargetId: item.currentTargetId, history: item.history
      });
      const actual = buildDetailedModelPayload(settings, item.message, context, prepared.groundedRequest);
      assert.ok(JSON.stringify(payload) === JSON.stringify(actual), `${outputMode}/${item.id}/${repeat}: exact runtime bytes`);
      assert.equal(Buffer.byteLength(JSON.stringify(payload)), Buffer.byteLength(JSON.stringify(actual)));
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= REQUEST_BYTE_CEILINGS[item.id],
        `${outputMode}/${item.id}/${repeat}: request byte ceiling`);
      assert.equal(payload.messages[1].content, JSON.stringify(item.grounded));
      assert.equal(JSON.parse(payload.messages[1].content).conversation.length, [0, 2, 6][repeat]);
      assert.deepEqual(JSON.parse(payload.messages[1].content).candidateSources, item.candidateSources);
    }
  }
});

test("six verification fixtures retain only intent-authoritative grounding", () => {
  const settings = createGatewayConfig({}).model;
  const byId = new Map(verificationInputs(settings, context).matrix
    .filter(({ repeat }) => repeat === 0).map(({ item }) => [item.id, item]));

  for (const item of byId.values()) {
    const ids = item.candidateSources.map((card) => card.id);
    assert.equal(new Set(ids).size, ids.length, item.id);
    assert.ok(Object.isFrozen(item.prepared.candidateSources), item.id);
    assert.ok(item.candidateSources.every((card) => Object.isFrozen(card) &&
      context.targetById.has(card.id) && item.prepared.obligations.allowedSourceIds.includes(card.id)), item.id);
    assert.equal(item.prepared.coveragePossible, true, item.id);
  }

  const navigation = byId.get("navigation");
  assert.ok(navigation.candidateSources.length > 0);
  assert.equal(navigation.grounded.targets.length, context.routes.targets.length);
  assert.equal(navigation.grounded.terms.length, context.glossary.terms.length);

  const glossary = byId.get("glossary");
  assert.ok(glossary.candidateSources.length > 0);
  assert.equal(glossary.grounded.targets.length, context.routes.targets.length);
  assert.equal(glossary.grounded.terms.length, context.glossary.terms.length);

  const projectSummary = byId.get("project-summary");
  assert.deepEqual(new Set(projectSummary.candidateSources.map((card) => card.id)), new Set([
    "project-catequest", "project-catequest-ai", "project-catequest-n1"
  ]));
  const overviewN1 = projectSummary.candidateSources.find((card) => card.id === "project-catequest-n1");
  assert.ok(overviewN1.evidence.includes("53→1회"));
  assert.ok(overviewN1.evidence.includes("프로젝트 종료 후"));
  const section = byId.get("section-explanation");
  assert.deepEqual(section.candidateSources.map((card) => card.id), ["project-catequest-n1"]);
  assert.ok(section.candidateSources[0].evidence.includes("일기·태그 목록의 N+1 조회 개선"));
  for (const witness of ["DiaryFlatProjection", "LinkedHashMap", "53→1회"])
    assert.ok(section.candidateSources[0].evidence.includes(witness), witness);
  assert.deepEqual(new Set(byId.get("comparison").candidateSources.map((card) => card.id)),
    new Set(["project-catequest-n1", "project-bookking-lock"]));
  const comparisonCards = byId.get("comparison").candidateSources;
  assert.equal(byId.get("comparison").grounded.targets.length, context.routes.targets.length);
  assert.equal(byId.get("comparison").grounded.terms.length, context.glossary.terms.length);
  const comparisonEvidence = comparisonCards.map((card) => card.evidence).join("\n");
  for (const witness of ["53→1회", "79,200", "52,908", "6,852", "로컬"])
    assert.ok(comparisonEvidence.includes(witness), witness);
  assert.ok(comparisonEvidence.includes("프로젝트 종료 후"));

  const weather = byId.get("out-of-scope");
  assert.deepEqual(weather.prepared.obligations.expectedIntents, ["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"]);
  assert.ok(weather.candidateSources.length > 0);
  assert.equal(weather.grounded.targets.length, context.routes.targets.length);
  assert.equal(weather.grounded.terms.length, context.glossary.terms.length);

});

test("full-registry and history-omitting matrices cannot reuse the current receipt binding", () => {
  const settings = createGatewayConfig({}).model;
  const inputs = verificationInputs(settings, context);
  for (const restoreCatalogs of [true, false]) {
    const stale = inputs.matrix.map(({ item, repeat }) => ({ id: item.id, repeat,
      payload: buildDetailedModelPayload(settings, item.message, context, {
        candidateSources: item.candidateSources, currentTargetId: item.grounded.currentTargetId,
        history: restoreCatalogs ? item.grounded.conversation : [],
        targets: restoreCatalogs ? context.routes.targets : item.grounded.targets,
        terms: restoreCatalogs ? context.glossary.terms : item.grounded.terms
      }) }));
    assert.notEqual(inputs.binding.matrixSha256, sha256(stale));
  }
});
