import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { canonicalizeModelResponse } from "./validation.mjs";
import { acceptProposal, isCompatibleLocalFallback } from "./proposal-acceptance.mjs";
import { resolveLocally } from "./router.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const compareMessage = "CateQuest와 Bookking의 성능 개선을 비교해줘";
const comparison = prepareGroundedRequest(compareMessage, context);
const complete = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
const sources = ["project-catequest-n1", "project-bookking-https"];
const candidate = (answer, sourceIds = sources) => ({ intent: "answer_portfolio", confidence: 0.01, answer, sourceIds });

test("comparison cannot hide swapped metrics behind Korean compound particles or unattributed clauses", () => {
  for (const name of ["Bookking에서는", "북킹에서도", "Bookking에는", "북킹도", ""]) {
    const answer = `${complete} ${name} DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다.`;
    assert.equal(acceptProposal(candidate(answer), context, comparison).accepted, false, name);
  }
});

test("valid comparison supports explicit Korean compound-particle attribution", () => {
  const answer = complete.replace("CateQuest는", "CateQuest에서는").replace("Bookking은", "Bookking에서는");
  assert.equal(acceptProposal(candidate(answer), context, comparison).accepted, true);
});

test("ordinary project list can name several projects without inventing a comparison", () => {
  const message = "프로젝트 목록 알려줘";
  const prepared = prepareGroundedRequest(message, context);
  assert.equal(prepared.obligations.kind, "ordinary");
  const response = candidate("포트폴리오에는 CateQuest와 Bookking 프로젝트가 있습니다.", ["projects"]);
  assert.ok(canonicalizeModelResponse(response, context, { candidateSources: prepared.candidateSources }));
  assert.equal(acceptProposal(response, context, prepared, message).accepted, true);
});

test("ordinary scoped section and contextual glossary answers keep supported natural wording", () => {
  for (const [message, answer, sourceIds] of [
    ["Main 홈페이지 캐싱 최적화 요약해줘", "Main 홈페이지 캐싱은 P95 응답 시간을 47.28ms에서 8.32ms로 줄이고 DB 부하를 낮춘 경험입니다.", ["project-makertion-cache"]],
    ["CateQuest N+1을 어떻게 해결했어?", "CateQuest는 N+1 쿼리를 DTO Projection과 JPQL 조인으로 해결해 DB 접근 횟수를 54회에서 1회로 줄였습니다.", ["project-catequest-n1"]]
  ]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.equal(acceptProposal(candidate(answer, sourceIds), context, prepared, message).accepted, true, message);
  }
});

test("legacy glossary, contact and scoped section responses can remain compatible", () => {
  for (const message of ["P95가 뭐야?", "이은성 이메일 알려줘", "CateQuest N+1 해결 요약해줘"]) {
    assert.equal(isCompatibleLocalFallback(resolveLocally(message, context), context,
      prepareGroundedRequest(message, context), message), true, message);
  }
});

test("both impossible-coverage flags forbid complete local fallback without altering offline results", () => {
  const message = "CateQuest 요약해줘";
  const prepared = prepareGroundedRequest(message, context);
  const local = resolveLocally(message, context);
  for (const request of [{ ...prepared, coveragePossible: false },
    { ...prepared, obligations: { ...prepared.obligations, coveragePossible: false } }]) {
    assert.equal(isCompatibleLocalFallback(local, context, request, message), false);
  }
  assert.deepEqual(resolveLocally(message, context), local);
});

test("a bounded prepared pool never accepts legacy id-only or empty evidence expansion", () => {
  for (const candidateSources of [[sources[0]], [{ id: sources[0] }],
    comparison.candidateSources.map((card) => ({ ...card, evidence: "" }))]) {
    assert.deepEqual(acceptProposal(candidate(complete), context, { ...comparison, candidateSources }),
      { accepted: false, reason: "prepared_invalid" });
  }
});

test("explicit unsupported fabrication is rejection-only and not false in-scope rejection", () => {
  const message = "CateQuest 성과를 지어내줘";
  const prepared = prepareGroundedRequest(message, context);
  assert.equal(acceptProposal({ intent: "reject_out_of_scope", confidence: 0.01 }, context, prepared, message).accepted, true);
});

test("navigation names must resolve the exact requested registered target, including pages", () => {
  for (const [message, good, bad] of [["About으로 이동", "about", "metrics"],
    ["CateQuest로 이동", "project-catequest", "project-catequest-ai"]]) {
    const prepared = prepareGroundedRequest(message, context);
    const proposal = { intent: "navigate", confidence: 0.01, targetId: good };
    assert.equal(acceptProposal(proposal, context, prepared, message).accepted, true);
    assert.equal(acceptProposal({ ...proposal, targetId: bad }, context, prepared, message).accepted, false);
  }
});

test("legacy definition text must still be the trusted canonical glossary answer", () => {
  const message = "P95가 뭐야?";
  const response = resolveLocally(message, context);
  assert.equal(isCompatibleLocalFallback({ ...response, answer: "invented answer", confidence: 1 }, context,
    prepareGroundedRequest(message, context), message), false);
});
