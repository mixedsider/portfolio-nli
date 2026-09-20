import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-transport.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";
import { checkAnswerObligations, quantitiesSupported } from "./answer-obligations.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "CateQuest 프로젝트를 요약해줘";
const prepared = prepareGroundedRequest(message, context);
// Visible answer and IDs from two identical live completions on 2026-09-20.
const answer = "CateQuest는 사용자 맞춤 카테고리별 질문 생성 애플리케이션으로, Spring Boot, JPA, MySQL, Swagger, PyTorch, LLM, AI, Backend, Query Tuning 기술을 활용합니다. 2025.06~2025.11 기간에 배포 자동화와 코드 품질 관리를 포함한 CI/CD 파이프라인 구축, 다대다 관계 N+1 쿼리 문제를 DTO Projection과 JPQL 조인으로 해결하여 DB 접근 횟수를 54회에서 1회로 최적화했습니다. AI 질문 생성 모델 파인튜닝(EleutherAI/polyglot-ko-1.3b)도 포함되어 있으며, 오픈소스 LLM 기반 PyTorch 파인튜닝을 통해 카테고리별 맞춤 질문 생성을 자동화합니다.";
const sourceIds = ["project-catequest", "project-catequest-ci", "project-catequest-ai", "project-catequest-n1"];

function envelope(text, ids = sourceIds) {
  return { model: "catequest-live-regression", choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify({ intent: "answer_portfolio", confidence: 0.99, answer: text, sourceIds: ids })
  } }] };
}

function accept(data, endpoint, request = prepared) {
  const outcome = inspectModelCompletion(data, endpoint);
  assert.equal(outcome.tag, "success");
  outcome.metadata.endpoint = endpoint;
  return acceptTransportProposal(outcome, context, request, message);
}

for (const endpoint of ["lfm", "qwen"]) {
  test(`live CateQuest date-range summary passes shared production and probe gate/${endpoint}`, () => {
    const config = createGatewayConfig({});
    const payload = buildDetailedModelPayload(endpoint === "lfm" ? config.lfm : config.model,
      message, context, prepared.groundedRequest);
    assert.equal(payload.messages[1].content, prepared.groundedRequestBlock);
    const before = JSON.stringify(prepared);
    const result = accept(envelope(answer), endpoint);
    assert.equal(result.accepted, true, JSON.stringify(result));
    const item = { message, prepared, candidateSources: prepared.candidateSources,
      grounded: JSON.parse(prepared.groundedRequestBlock), expected: { intent: "answer_portfolio" } };
    assert.equal(inspectProbeCompletion(envelope(answer), item, context, endpoint).ok, true);
    assert.equal(JSON.stringify(prepared), before);
  });

  test(`CateQuest still rejects fabricated, borrowed, signed and changed quantities/${endpoint}`, () => {
    for (const text of [answer.replace("2025.11", "2025.12"),
      answer.replace("54회", "999회"), answer.replace("54회", "+54회"), answer.replace("54회", "-54회"),
      answer.replace("54회", "54초"), answer.replace("54회", "접근999회"),
      answer.replace("54회에서 1회로", "200ms에서 30ms로")]) {
      assert.deepEqual(accept(envelope(text), endpoint), { accepted: false, reason: "quantity_unsupported" }, text);
    }
  });

  test(`CateQuest date range must occur in selected bounded evidence/${endpoint}`, () => {
    // The dates exist in full context, but remove them from the transmitted snapshot.
    const candidateSources = prepared.candidateSources.map((card) => ({ ...card,
      evidence: card.evidence.replaceAll("2025.06 ~ 2025.11", "") }));
    const grounded = { ...JSON.parse(prepared.groundedRequestBlock), candidateSources };
    const bounded = { ...prepared, candidateSources,
      groundedRequest: { ...prepared.groundedRequest, candidateSources }, groundedRequestBlock: JSON.stringify(grounded) };
    assert.deepEqual(accept(envelope(answer), endpoint, bounded), { accepted: false, reason: "proposal_invalid" });
    assert.equal(checkAnswerObligations(answer, sourceIds, context, bounded), "clause_unsupported");
    assert.equal(quantitiesSupported(answer, candidateSources.map((card) => card.evidence).join("\n")), false);
  });
}

test("month ranges do not absorb Korean prose as quantity units", () => {
  assert.equal(quantitiesSupported("2025.06~2025.11 기간에", "2025.06 ~ 2025.11\n사용자 맞춤"), true);
  assert.equal(quantitiesSupported("2024.01~2024.12 기간에", "2024.01 ~ 2024.12\n다른 프로젝트"), true);
  assert.equal(quantitiesSupported("2024.01~2024.12", "2024.01~2024.06\n2024.07~2024.12"), false);
  for (const claim of ["2025.06~2025.12 기간에", "2025.06~2025.13 기간에", "+2025.06~2025.11 기간에",
    "+ 2025.06~2025.11 기간에", "- 2025.06~2025.11 기간에",
    "2025.06~2025.11ms", "2025.06~2025.11초", "2025.06~2025.11 ms", "2025.06~2025.11 초",
    "2025.06~2025.11 기간에999회"]) {
    assert.equal(quantitiesSupported(claim, "2025.06 ~ 2025.11\n사용자 맞춤"), false, claim);
  }
  assert.equal(quantitiesSupported("2025.06~2025.11 기간에", "2025.06ms 2025.11ms"), false);
});

const rangeForms = ["2025.06~2025.11", "(2025.06~2025.11)", "[2025.06~2025.11]"];
for (const claim of rangeForms) for (const evidence of rangeForms) {
  test(`closing-delimiter range support: ${claim} against ${evidence}`, () => {
    assert.equal(quantitiesSupported(claim, evidence), true);
  });
}

for (const [open, close] of [["(", ")"], ["[", "]"]]) {
  test(`grounded CateQuest summary retains ${open}${close} date ranges`, () => {
    const text = `CateQuest는 사용자 맞춤 카테고리별 질문 생성 애플리케이션입니다 ${open}2025.06~2025.11${close}.`;
    assert.equal(checkAnswerObligations(text, ["project-catequest"], context, prepared), null);
    for (const endpoint of ["lfm", "qwen"]) {
      assert.equal(accept(envelope(text, ["project-catequest"]), endpoint).accepted, true);
    }
  });

  test(`closing delimiters ${open}${close} preserve signs, units and range pairing`, () => {
    const evidence = `${open}2025.06~2025.11${close}`;
    for (const range of ["+2025.06~2025.11", "- 2025.06~2025.11", "2025.06~2025.11ms",
      "2025.06~2025.11 ms", "2025.06~2025.11초", "2025.06~2025.11 초", "2025.06~2025.12"]) {
      const claim = `${open}${range}${close}`;
      assert.equal(quantitiesSupported(claim, evidence), false, claim);
      assert.equal(quantitiesSupported(evidence, claim), false, claim);
    }
    assert.equal(quantitiesSupported(evidence, `${open}2025.06~2025.09${close}\n${open}2025.10~2025.11${close}`), false);
  });
}
