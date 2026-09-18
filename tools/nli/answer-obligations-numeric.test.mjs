import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { quantitiesSupported } from "./answer-obligations.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "CateQuest와 Bookking의 성능 개선을 비교해줘";
const prepared = prepareGroundedRequest(message, { ...context, currentTargetId: "project-makertion-db" });
const full = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
function inspect(answer, endpoint) {
  const candidate = { intent: "answer_portfolio", confidence: 0.99, answer,
    sourceIds: ["project-catequest-n1", "project-bookking-https"] };
  const result = inspectModelCompletion({ model: "numeric-regression-fixture", choices: [{
    finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) }
  }] }, endpoint);
  assert.equal(result.tag, "success");
  return { ...result, metadata: { ...result.metadata, endpoint } };
}

// All seven failures from the retained independent suite, now product regressions.
for (const [name, answer] of [["plus-prefixed-fabrication", full.replace("30ms", "+999ms")],
  ["negative-latency", full.replace("30ms", "-30ms")],
  ["korean-adjacent-fabrication", full.replace("200ms에서 30ms", "응답시간999ms")]]) {
  for (const endpoint of ["lfm", "qwen"]) test(`REGRESSION:${name}/${endpoint}`, () => {
    const before = JSON.stringify(prepared);
    assert.ok(Object.isFrozen(prepared));
    assert.strictEqual(prepared.candidateSources, prepared.groundedRequest.candidateSources);
    assert.deepEqual(prepared.candidateSources, JSON.parse(prepared.groundedRequestBlock).candidateSources);
    assert.deepEqual(acceptTransportProposal(inspect(answer, endpoint), context, prepared, message),
      { accepted: false, reason: "quantity_unsupported" });
    assert.equal(JSON.stringify(prepared), before);
  });
}
test("REGRESSION: quantity primitive does not silently omit signed or adjacent numerals", () => {
  assert.deepEqual(["999ms", "+999ms", "-30ms", "응답시간999ms"].map((claim) =>
    quantitiesSupported(claim, "200ms에서 30ms")), [false, false, false, false]);
});

test("explicit signs must be present in evidence, never stripped or converted", () => {
  for (const [claim, evidence, expected] of [
    ["+30ms", "+30ms", true], ["-30ms", "-30ms", true], ["−30ms", "−30ms", true],
    ["+ 30 MS", "+30ms", true], ["- 30ms", "-30ms", true],
    ["+30ms", "30ms", false], ["-30ms", "30ms", false], ["30ms", "-30ms", false],
    ["+30ms", "-30ms", false], ["−30ms", "30ms", false], ["−30ms", "-30ms", false],
    ["-0.30ms", "+0.30ms", false], ["+0.30ms", "+0.30ms", true],
    ["+999ms", "+30ms", false], ["+6.4%", "약 +6.4% 처리량 증가", true]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("Korean quantity prefixes and suffixes cannot hide positive or negative numerals", () => {
  for (const [claim, evidence, expected] of [
    ["응답시간30ms로", "응답시간 30ms", true], ["응답시간999ms로", "30ms", false],
    ["응답시간-30ms로", "30ms", false], ["응답시간+30ms로", "+30ms", true],
    ["접근54회에서1회로", "54회에서 1회로", true], ["접근999회에서1회로", "54회에서 1회", false],
    ["최대+0.30ms까지", "+0.30ms", true], ["개선율−6.4%", "6.4%", false]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("decimal, percent and rate boundaries preserve whole quantities without conversion", () => {
  for (const [claim, evidence, expected] of [
    [".30ms", ".30ms", true], [".30ms", "0.30ms", false], ["30ms", "130ms", false],
    ["-30.5ms", "30.5ms", false], ["−30.5%", "−30.5%", true],
    ["30٪", "30%", false], ["30٪", "30٪", true], ["30‰", "30%", false],
    ["+362.80/s", "+362.80 / s", true], ["−362.80/s", "362.80/s", false],
    ["362.80/s", "362.80/min", false], ["30ms/s", "30ms/min", false],
    ["3,648회", "3,648회", true], ["3648회", "3,648회", false]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("malformed numeric tokens fail closed rather than disappearing or matching substrings", () => {
  for (const claim of ["++30ms", "--30ms", "+-30ms", "−-30ms", "30..5ms", "30,00ms", "30%%", "30/s/min", "1e3ms",
    "30 ms%%", "30 / s / min", "30 /"]) {
    assert.equal(quantitiesSupported(claim, `${claim} 30ms 5ms 3ms 1회`), false, claim);
  }
});

test("spacing cannot drop an unsupported unit or silently convert unit names", () => {
  for (const [claim, evidence, expected] of [["30 milliseconds", "30ms", false],
    ["30 milliseconds", "30milliseconds", true], ["30 msfoo", "30ms", false],
    ["30 s", "30ms", false], ["30 ms / min", "30ms/min", true]]) {
    assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
  }
});

for (const endpoint of ["lfm", "qwen"]) test(`actual bounded positive signed rate improvement/${endpoint}`, () => {
  const request = "현재 프로젝트에서 캐싱을 어떻게 개선했어?";
  const preparation = prepareGroundedRequest(request, { ...context, currentTargetId: "project-makertion-db" });
  const sourceId = "project-makertion-cache";
  assert.ok(preparation.candidateSources.find((card) => card.id === sourceId).evidence.includes("+6.4%"));
  const answer = "Main 홈페이지 캐싱은 RPS 초당 처리량을 약 +6.4% 개선했습니다.";
  const outcome = inspect(answer, endpoint);
  outcome.candidate.sourceIds = [sourceId];
  assert.equal(acceptTransportProposal(outcome, context, preparation, request).accepted, true);
  outcome.candidate.answer = answer.replace("+6.4%", "-6.4%");
  assert.equal(acceptTransportProposal(outcome, context, preparation, request).accepted, false);
});

test("identifier exclusions are explicit and cannot conceal attached quantity extensions", () => {
  for (const claim of ["P95", "P95는", "N+1", "N+1을", "1+N 쿼리"]) {
    assert.equal(quantitiesSupported(claim, ""), true, claim);
  }
  for (const claim of ["P95 +999ms", "N+1 응답시간999ms", "N+1999ms", "P95.999ms", "N+1-999ms"]) {
    assert.equal(quantitiesSupported(claim, "P95 N+1 30ms"), false, claim);
  }
});

test("Qwen adapter rejects invalid as well as positive reasoning accounting", () => {
  const valid = inspect(full, "qwen");
  for (const reasoningAccounting of ["invalid", "positive"]) {
    assert.deepEqual(acceptTransportProposal({ ...valid, metadata: { ...valid.metadata, reasoningAccounting } },
      context, prepared, message), { accepted: false, reason: "transport_invalid" });
  }
});
