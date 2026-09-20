import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-transport.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";

const context = { ...await loadNliContext(new URL("../../", import.meta.url).pathname), currentTargetId: null, history: [] };
const message = "Makertion 비용 절감 내용을 설명해줘";
const original = prepareGroundedRequest(message, context);
const sourceId = "project-makertion-cost";
// Synthetic minimal text; no retained live answer or full portfolio excerpt.
const answer = "Makertion 비용 절감은 로그 생성을 1/20로 줄였습니다.";
const evidence = "Makertion 비용 절감은 로그 생성을 1/20 수준으로 줄였습니다.";

function prepare(costEvidence = evidence) {
  const candidateSources = original.candidateSources.map((card) => Object.freeze({ ...card,
    evidence: card.id === sourceId ? costEvidence : evidence }));
  Object.freeze(candidateSources);
  const groundedRequest = { ...original.groundedRequest, candidateSources };
  const groundedRequestBlock = JSON.stringify({ ...JSON.parse(original.groundedRequestBlock), candidateSources });
  return Object.freeze({ ...original, candidateSources, groundedRequest, groundedRequestBlock });
}

function inspect(text, prepared, endpoint, sourceIds = [sourceId]) {
  const data = { model: "synthetic-fraction-fixture", choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify({ intent: "answer_portfolio", confidence: 0.99, answer: text, sourceIds })
  } }] };
  const outcome = inspectModelCompletion(data, endpoint);
  assert.equal(outcome.tag, "success");
  outcome.metadata.endpoint = endpoint;
  return { accepted: acceptTransportProposal(outcome, context, prepared, message),
    probe: inspectProbeCompletion(data, { message, prepared, candidateSources: prepared.candidateSources,
      grounded: JSON.parse(prepared.groundedRequestBlock), expected: { intent: "answer_portfolio" } }, context, endpoint) };
}

for (const endpoint of ["lfm", "qwen"]) {
  test(`supported literal fraction passes shared transport acceptance and probe/${endpoint}`, () => {
    const prepared = prepare();
    const before = JSON.stringify(prepared);
    const config = createGatewayConfig({});
    const payload = buildDetailedModelPayload(endpoint === "lfm" ? config.lfm : config.model, message, context, prepared.groundedRequest);
    assert.equal(payload.messages[1].content, prepared.groundedRequestBlock);
    const result = inspect(answer, prepared, endpoint);
    assert.equal(result.accepted.accepted, true, JSON.stringify(result.accepted));
    assert.equal(result.probe.ok, true);
    assert.equal(JSON.stringify(prepared), before);
  });

  test(`fraction changes and malformed atoms fail shared acceptance and probe/${endpoint}`, () => {
    for (const fraction of ["1/21", "2/20", "+1/20", "-1/20", "1/20ms", "1/20.5", "1/20/3", "1//20", "1/-20", "1/0"]) {
      const result = inspect(answer.replace("1/20", fraction), prepare(), endpoint);
      assert.deepEqual(result.accepted, { accepted: false, reason: "quantity_unsupported" }, fraction);
      assert.equal(result.probe.kind, "quantity_unsupported", fraction);
    }
  });

  for (const mode of ["claim", "evidence", "self"]) {
    test(`fraction slash boundaries fail as quantity_unsupported in ${mode}/${endpoint}`, () => {
      for (const fraction of ["1/20⁄", "1/20∕s", "/1/20", "/ 1 / 20", "⁄ /1/20", "1/20 ∕ s",
        "1/20⁄ /s", "1/20 / ⁄", "1/20ms∕s", "1/20로⁄"]) {
        const text = mode === "evidence" ? answer : answer.replace("1/20", fraction);
        const selected = mode === "claim" ? evidence : evidence.replace("1/20", fraction);
        const result = inspect(text, prepare(selected), endpoint);
        assert.deepEqual(result.accepted, { accepted: false, reason: "quantity_unsupported" }, fraction);
        assert.equal(result.probe.kind, "quantity_unsupported", fraction);
      }
    });
  }

  test(`legitimate ASCII fraction rate still passes shared acceptance and probe/${endpoint}`, () => {
    for (const fraction of ["1/20/s", "1/20ms/s", "1/20ms", "1/20%", "1/20분"]) {
      const result = inspect(answer.replace("1/20", fraction), prepare(evidence.replace("1/20", fraction)), endpoint);
      assert.equal(result.accepted.accepted, true, fraction);
      assert.equal(result.probe.ok, true, fraction);
    }
    const publicShape = inspect(answer, prepare(evidence.replace("1/20 수준으로", "1/20수준으로")), endpoint);
    assert.equal(publicShape.accepted.accepted, true);
    assert.equal(publicShape.probe.ok, true);
  });

  for (const mode of ["claim", "evidence", "self"]) {
    test(`whole fraction compositions reject ${mode} in shared acceptance and probe/${endpoint}`, () => {
      for (const base of ["1/20", "1/20ms", "1/20/s", "1/20%", "1/20분"]) {
        for (const tail of ["٣", "로ms", "로%", "로٣", "로⁄", "로∕s", ", ⁄", ", . ⁄", "로/3", "%분", "분%", "로λ"]) {
          const malformed = base + tail;
          const text = answer.replace("1/20로", mode === "evidence" ? "1/20로" : malformed);
          const selected = evidence.replace("1/20 수준으로", mode === "claim" ? base : malformed);
          const result = inspect(text, prepare(selected), endpoint);
          // This sentence-fragment claim is rejected by the earlier proposal gate.
          const reason = tail === ", . ⁄" && mode !== "evidence" ? "proposal_invalid" : "quantity_unsupported";
          assert.deepEqual(result.accepted, { accepted: false, reason }, malformed);
          assert.equal(result.probe.kind, reason, malformed);
        }
      }
    });
  }

  test(`only selected bounded evidence may support the fraction/${endpoint}`, () => {
    assert.ok(original.candidateSources.find((card) => card.id === sourceId).evidence.includes("1/20"));
    // Other candidates and full context retain the fraction; selected card does not.
    const prepared = prepare(evidence.replace("1/20", "1/21"));
    const result = inspect(answer, prepared, endpoint);
    assert.deepEqual(result.accepted, { accepted: false, reason: "quantity_unsupported" });
    assert.equal(result.probe.kind, "quantity_unsupported");
    const wrongSource = inspect(answer, prepare(), endpoint, ["project-makertion-cache"]);
    assert.equal(wrongSource.accepted.accepted, false);
    assert.equal(wrongSource.probe.ok, false);
  });
}
