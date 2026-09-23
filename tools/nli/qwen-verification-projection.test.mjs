import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-client.mjs";
import { sha256, verificationInputs } from "./qwen-verification-proof.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const REQUEST_BYTE_CEILINGS = Object.freeze({
  navigation: 9000,
  glossary: 10000,
  "project-summary": 6000,
  "section-explanation": 5900,
  comparison: 5300,
  "out-of-scope": 9000
});
const SYSTEM_PROMPT_BYTE_CEILING = 1800;

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
  assert.deepEqual(navigation.candidateSources, []);
  assert.deepEqual(navigation.grounded.targets,
    [{ id: "project-catequest", label: "CateQuest", type: "project" }]);
  assert.deepEqual(navigation.grounded.terms, []);

  const glossary = byId.get("glossary");
  assert.equal(glossary.candidateSources.length, 1);
  assert.equal(glossary.candidateSources[0].evidence,
    "P95\nP95는 전체 요청 중 95%가 이 시간 안에 응답했다는 뜻입니다. 평균보다 느린 상위 요청 구간의 사용자 경험을 확인할 때 유용합니다.");
  assert.equal(glossary.grounded.terms.length, 1);
  assert.equal(glossary.grounded.terms[0].term, "P95");

  const projectSummary = byId.get("project-summary");
  assert.deepEqual(new Set(projectSummary.candidateSources.map((card) => card.id)), new Set([
    "project-catequest", "project-catequest-ci", "project-catequest-ai", "project-catequest-n1"
  ]));
  const overviewN1 = projectSummary.candidateSources.find((card) => card.id === "project-catequest-n1");
  assert.ok(overviewN1.evidence.includes("54회에서 1회"));
  assert.ok(!overviewN1.evidence.includes("263ms"));
  const section = byId.get("section-explanation");
  assert.deepEqual(section.candidateSources.map((card) => card.id), ["project-catequest-n1"]);
  assert.ok(section.candidateSources[0].evidence.startsWith("N+1 쿼리: DTO Projection, JPQL.\n"));
  for (const witness of ["DTO Projection", "JPQL", "54회에서 1회"])
    assert.ok(section.candidateSources[0].evidence.includes(witness), witness);
  assert.deepEqual(new Set(byId.get("comparison").candidateSources.map((card) => card.id)),
    new Set(["project-catequest-n1", "project-bookking-https"]));
  const comparisonCards = byId.get("comparison").candidateSources;
  assert.deepEqual(byId.get("comparison").grounded.targets, []);
  assert.deepEqual(new Set(comparisonCards.map((card) => card.label)), new Set(["N+1 쿼리", "HTTPS 지연"]));
  assert.ok(comparisonCards.find((card) => card.id === "project-catequest-n1").evidence
    .startsWith("CateQuest\nN+1 쿼리\n54 -> 1\n"));
  assert.ok(comparisonCards.find((card) => card.id === "project-bookking-https").evidence
    .startsWith("Bookking\nHTTPS 지연\n200ms에서 30ms\n"));
  const comparisonEvidence = comparisonCards.map((card) => card.evidence).join("\n");
  for (const witness of ["54회에서 1회", "200ms", "30ms"])
    assert.ok(comparisonEvidence.includes(witness), witness);
  assert.ok(!comparisonEvidence.includes("263ms"));

  const weather = byId.get("out-of-scope");
  assert.deepEqual(weather.prepared.obligations.expectedIntents, ["reject_out_of_scope"]);
  assert.deepEqual(weather.candidateSources, []);
  assert.deepEqual(weather.grounded.targets, []);
  assert.deepEqual(weather.grounded.terms, []);
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
