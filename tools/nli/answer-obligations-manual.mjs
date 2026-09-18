import assert from "node:assert/strict";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal, isCompatibleLocalFallback } from "./proposal-acceptance.mjs";
import { canonicalizeModelResponse } from "./validation.mjs";
import { resolveLocally } from "./router.mjs";

// Repeatable local manual QA: actual portfolio/context, fixture completions, no network.
const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const comparison = "CateQuest와 Bookking의 성능 개선을 비교해줘";
const complete = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
const sourceIds = ["project-catequest-n1", "project-bookking-https"];
const answer = (text, ids = sourceIds, confidence = 0.01) => ({ intent: "answer_portfolio", answer: text, sourceIds: ids, confidence });
const examples = [
  { id: "complete-comparison", message: comparison, candidate: answer(complete), expected: true },
  { id: "high-confidence-partial", message: comparison, candidate: answer(complete.split(". ")[0] + ".", sourceIds, 0.99), expected: false },
  { id: "swapped-quantity", message: comparison, candidate: answer(complete.replace("54회에서 1회", "200ms에서 30ms")), expected: false },
  { id: "wrong-project-facts", message: comparison, candidate: answer("CateQuest는 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다. Bookking은 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다."), expected: false },
  { id: "plain-glossary", message: "P95가 뭐야?", candidate: { intent: "define_term", term: "P95", confidence: 0.01 }, expected: true },
  { id: "contextual-not-definition", message: "현재 프로젝트에서 P95를 어떻게 개선했어?", candidate: { intent: "define_term", term: "P95", confidence: 1 }, expected: false },
  { id: "current-project-cache", message: "현재 프로젝트에서 캐싱을 어떻게 개선했어?", candidate: answer("Main 홈페이지 캐싱은 P95 응답 시간을 47.28ms에서 8.32ms로 줄이고 DB 부하를 낮춘 경험입니다.", ["project-makertion-cache"]), expected: true },
  { id: "false-rejection", message: "CateQuest 요약해줘", candidate: { intent: "reject_out_of_scope", confidence: 1 }, expected: false },
  { id: "email", message: "이은성 이메일 알려줘", candidate: answer("이은성 Email: mixeddev0812@gmail.com", ["about"]), expected: true },
  { id: "out-of-scope", message: "오늘 날씨 알려줘", candidate: { intent: "reject_out_of_scope", confidence: 0.01 }, expected: true }
];
const observations = [];
for (const example of examples) {
  const scoped = { ...context, currentTargetId: "project-makertion-db" };
  const prepared = prepareGroundedRequest(example.message, scoped);
  const serialized = prepared.groundedRequestBlock;
  const baselineAccepted = Boolean(canonicalizeModelResponse(example.candidate, context, { candidateSources: prepared.candidateSources }));
  for (const endpoint of ["lfm", "qwen"]) {
    const inspected = inspectModelCompletion({ model: "task7-offline-fixture", choices: [{
      finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(example.candidate) }
    }] }, endpoint);
    const outcome = { ...inspected, metadata: { ...inspected.metadata, endpoint } };
    const result = acceptTransportProposal(outcome, context, prepared, example.message);
    assert.equal(result.accepted, example.expected, `${endpoint}/${example.id}: ${result.reason}`);
    assert.equal(prepared.groundedRequestBlock, serialized);
    if (example.id === "plain-glossary") assert.equal(result.response.answer, context.termByCanonical.get("p95").answer);
    observations.push({ id: example.id, endpoint, baselineAccepted, accepted: result.accepted,
      reason: result.reason || "accepted", sources: result.response?.sources?.map((source) => source.id) || [] });
  }
}
const local = resolveLocally("CateQuest 요약해줘", context);
assert.equal(local.intent, "summarize_project");
assert.equal(isCompatibleLocalFallback(local, context, prepareGroundedRequest("CateQuest 요약해줘", context), "CateQuest 요약해줘"), true);
assert.equal(isCompatibleLocalFallback(local, context, prepareGroundedRequest(comparison, context), comparison), false);
console.log(JSON.stringify({ mode: "offline-real-context-fixture-completions", assertions: "passed", examples: observations,
  localFallback: { compatibleSummary: true, incompatibleComparison: false, offlineIntent: local.intent },
  cleanup: { networkCalls: 0, listeners: 0, timers: 0, temporaryFiles: 0 } }, null, 2));
