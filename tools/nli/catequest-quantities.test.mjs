import { fileURLToPath } from "node:url";
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

const context = await loadNliContext(fileURLToPath(new URL("../../", import.meta.url)));
const message = "CateQuest 프로젝트를 요약해줘";
const prepared = prepareGroundedRequest(message, context);
// Current portfolio summary, retaining the selected bounded date and SQL evidence.
const answer = "CateQuest는 카테고리별 질문을 제공하고 사용자가 생각을 기록하는 앱 프로젝트입니다. 2025.06~2025.11 기간의 프로젝트입니다. 프로젝트 종료 후 로컬 PostgreSQL 17에서 일기 50건을 방식별 15회 교차 측정해 SQL 실행 수를 53회에서 1회로 줄였습니다.";
const sourceIds = ["project-catequest", "project-catequest-n1"];

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

test("short root-only CateQuest overview passes production and probe acceptance", () => {
  const text = "CateQuest는 카테고리별 질문을 제공하고 사용자가 생각을 기록하는 앱 프로젝트입니다.";
  const ids = ["project-catequest"];
  const item = { id: "project-summary", message, prepared, candidateSources: prepared.candidateSources,
    grounded: JSON.parse(prepared.groundedRequestBlock), expected: {
      intent: "answer_portfolio", groups: [{ sourceId: "project-catequest", label: "CateQuest" }]
    } };
  for (const endpoint of ["lfm", "qwen"]) {
    const data = envelope(text, ids);
    assert.equal(accept(data, endpoint).accepted, true);
    assert.equal(inspectProbeCompletion(data, item, context, endpoint).ok, true);
  }
});

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
      answer.replace("53회", "999회"), answer.replace("53회", "+53회"), answer.replace("53회", "-53회"),
      answer.replace("53회", "53초"), answer.replace("53회", "접근999회"),
      answer.replace("53회에서 1회로", "100ms에서 250ms로")]) {
      assert.deepEqual(accept(envelope(text), endpoint), { accepted: false, reason: "quantity_unsupported" }, text);
    }
  });

  test(`CateQuest date range must occur in selected bounded evidence/${endpoint}`, () => {
    // The dates exist in full context, but remove them from the transmitted snapshot.
    const candidateSources = prepared.candidateSources.map((card) => ({ ...card,
      evidence: card.evidence.replaceAll("2025.06–2025.11", "") }));
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
