import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { canonicalizeModelResponse } from "./validation.mjs";
import { resolveLocally } from "./router.mjs";
import { acceptProposal, acceptTransportProposal, isCompatibleLocalFallback } from "./proposal-acceptance.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const comparison = prepareGroundedRequest("CateQuest와 Bookking의 성능 개선을 비교해줘", {
  ...context, currentTargetId: "project-makertion-db"
});
const sourceIds = ["project-catequest-n1", "project-bookking-https"];
const complete = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
const proposal = (answer = complete, confidence = 0.01) => ({ intent: "answer_portfolio", confidence, answer, sourceIds });

test("baseline: union grounding alone admits incomplete comparison and false rejection", () => {
  for (const candidate of [proposal(complete.split(". ")[0] + ".", 0.99), { intent: "reject_out_of_scope", confidence: 1 }]) {
    assert.ok(canonicalizeModelResponse(candidate, context, { candidateSources: comparison.candidateSources }));
  }
});

test("both stage adapters accept complete low-confidence answers without mutating preparation", () => {
  const before = JSON.stringify(comparison);
  for (const endpoint of ["lfm", "qwen"]) {
    const result = acceptTransportProposal({ tag: "success", candidate: proposal(), metadata: {
      endpoint, finishReason: "stop", reasoningPresent: false, reasoningTokens: null
    } }, context, comparison);
    assert.equal(result.accepted, true);
    assert.equal(result.response.confidence, 0.01);
    assert.deepEqual(result.response.sources.map((source) => source.id), sourceIds);
  }
  assert.equal(JSON.stringify(comparison), before);
});

test("union sources cannot rescue missing clauses, swapped numbers or wrong-project facts", () => {
  for (const answer of [
    complete.split(". ")[0] + ".",
    complete.replace("54회에서 1회", "200ms에서 30ms"),
    "CateQuest는 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다. Bookking은 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다.",
    "CateQuest와 Bookking은 DB 접근을 54회에서 1회로 줄였습니다.",
    `${complete} Bookking은 HTTPS 응답 지연을 999ms로 줄였습니다.`
  ]) assert.equal(acceptProposal(proposal(answer, 0.99), context, comparison).accepted, false, answer);
});

test("source AND groups require corresponding selected sources", () => {
  assert.equal(acceptProposal({ ...proposal(), sourceIds: [sourceIds[0]] }, context, comparison).accepted, false);
});

test("false rejection fails for resolvable scope, glossary and ungrouped in-scope facts", () => {
  for (const message of ["CateQuest 요약해줘", "P95가 뭐야?", "이은성 이메일 알려줘", "너는 누구야?"]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.equal(acceptProposal({ intent: "reject_out_of_scope", confidence: 1 }, context, prepared).accepted, false, message);
  }
  const unknown = prepareGroundedRequest("오늘 날씨 알려줘", context);
  assert.equal(acceptProposal({ intent: "reject_out_of_scope", confidence: 0.01 }, context, unknown, "오늘 날씨 알려줘").accepted, true);
});

test("plain glossary uses canonical definition, but contextual why/how cannot", () => {
  const candidate = { intent: "define_term", term: "P95", confidence: 0.01 };
  const result = acceptProposal(candidate, context, prepareGroundedRequest("P95가 뭐야?", context));
  assert.equal(result.accepted, true);
  assert.equal(result.response.answer, context.termByCanonical.get("p95").answer);
  assert.equal(acceptProposal({ ...candidate, term: "N+1 쿼리" }, context,
    prepareGroundedRequest("P95가 뭐야?", context)).accepted, false);
  assert.equal(acceptProposal(candidate, context,
    prepareGroundedRequest("현재 프로젝트에서 P95를 어떻게 개선했어?", { ...context, currentTargetId: "project-makertion-db" })).accepted, false);
});

test("current/named scope, unresolved ambiguity and impossible coverage fail closed", () => {
  const scoped = prepareGroundedRequest("이 프로젝트 요약해줘", { ...context, currentTargetId: "project-catequest-n1" });
  assert.equal(acceptProposal(proposal(), context, scoped).accepted, false);
  const ambiguous = prepareGroundedRequest("소개로 이동", context);
  assert.equal(acceptProposal({ intent: "navigate", targetId: "about", confidence: 1 }, context, ambiguous).accepted, false);
  const impossible = { ...comparison, coveragePossible: false, obligations: { ...comparison.obligations, coveragePossible: false } };
  assert.deepEqual(acceptProposal(proposal(), context, impossible), { accepted: false, reason: "coverage_impossible" });
});

test("strict transport failures are not candidates, even when carrying plausible prose", () => {
  for (const outcome of [null, proposal(), { tag: "failure", kind: "timeout", candidate: proposal() },
    { tag: "success", candidate: proposal() },
    { tag: "success", candidate: proposal(), metadata: { endpoint: "lfm", finishReason: "length" } },
    { tag: "success", candidate: proposal(), metadata: { endpoint: "qwen", finishReason: "stop", reasoningTokens: 1 } }]) {
    assert.deepEqual(acceptTransportProposal(outcome, context, comparison), { accepted: false, reason: "transport_invalid" });
  }
});

test("strict model slots, exclusions, six sources and 4000 characters remain unchanged", () => {
  for (const candidate of [
    { ...proposal(), message: "extra" }, { ...proposal(), sourceIds: ["made-up"] },
    proposal(`<b>${complete}</b>`), proposal(`${complete} https://example.com`),
    proposal("가".repeat(4001)), { ...proposal(), sourceIds: Array(7).fill(sourceIds[0]) }
  ]) assert.equal(acceptProposal(candidate, context, comparison).accepted, false);
});

test("legacy local canonical responses are checked separately; offline resolver stays intact", () => {
  const message = "CateQuest 요약해줘";
  const local = resolveLocally(message, context);
  assert.equal(local.intent, "summarize_project");
  assert.equal(isCompatibleLocalFallback(local, context, prepareGroundedRequest(message, context)), true);
  assert.equal(isCompatibleLocalFallback(local, context, comparison), false);
  const explain = prepareGroundedRequest("CateQuest N+1 해결을 어떻게 했어?", context);
  const navigation = resolveLocally("CateQuest로 이동", context);
  assert.equal(isCompatibleLocalFallback(navigation, context, explain), false);
  assert.equal(isCompatibleLocalFallback(local, context,
    prepareGroundedRequest("Bookking 요약해줘", context)), false);
  assert.equal(isCompatibleLocalFallback({ ...local, answer: "NASA Kubernetes Go leadership" }, context,
    prepareGroundedRequest(message, context)), false);
});

test("canonical local portfolio fallback must meet identical clause obligations", () => {
  const local = canonicalizeModelResponse(proposal(complete.split(". ")[0] + ".", 1), context,
    { candidateSources: comparison.candidateSources });
  assert.equal(isCompatibleLocalFallback(local, context, comparison), false);
  const completeLocal = canonicalizeModelResponse(proposal(), context, { candidateSources: comparison.candidateSources });
  assert.equal(isCompatibleLocalFallback(completeLocal, context, comparison), true);
});
