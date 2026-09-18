import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { checkAnswerObligations, quantitiesSupported } from "./answer-obligations.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const prepared = prepareGroundedRequest("CateQuest와 Bookking의 성능 개선을 비교해줘", context);
const selected = ["project-catequest-n1", "project-bookking-https"];
const check = (answer, request = prepared, ids = selected) => checkAnswerObligations(answer, ids, context, request);

test("quantity matching preserves numeric/unit boundaries and normalizes only whitespace/case", () => {
  for (const [claim, evidence, expected] of [
    ["200 MS에서 30 ms", "200ms에서 30ms", true], ["30ms", "130ms", false],
    ["30s", "30ms", false], ["75.7%", "75.7 ms", false], ["54회에서 1회", "54회에서 1회", true],
    ["999ms", "99ms", false], ["1.3B", "1.3b", true], ["30ms", "30 ms", true],
    ["3", "1.3", false], ["P95", "P95", true], ["N+1", "N+1", true],
    ["362.80/s", "362.80/min", false], ["362.80/s", "362.80 / s", true],
    ["30개월", "30개", false], ["30개", "30개월", false],
    ["30퍼센트", "30회", false], ["54회에서 1회로", "54회에서 1회", true]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("project aliases and independently attributed joined clauses are accepted", () => {
  for (const joiner of [". ", "; ", ", ", " and ", " 반면 ", "\n"]) {
    const answer = `카테퀘스트는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다${joiner}북킹은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.`;
    assert.equal(check(answer), null, answer);
  }
});

test("project names alone, substring names and ambiguous shared attribution do not cover projects", () => {
  for (const answer of ["CateQuest. Bookking.", "FakeCateQuest는 DTO Projection을 사용했습니다. Bookking은 HTTPS 구조를 개선했습니다.",
    "CateQuest and Bookking reduced HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다."])
    assert.notEqual(check(answer), null, answer);
});

test("all attributed clauses are checked, not just one valid witness per project", () => {
  const answer = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다. CateQuest는 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
  assert.notEqual(check(answer), null);
});

test("subject groups require aliases and support in their corresponding selected sources", () => {
  const request = prepareGroundedRequest("CateQuest와 Bookking의 N+1과 HTTPS를 비교해줘", context);
  assert.equal(request.coveragePossible, true);
  const complete = "CateQuest는 N+1 쿼리를 DTO Projection과 JPQL 조인으로 해결해 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
  assert.equal(check(complete, request), null);
  assert.notEqual(check(complete.replace("N+1 쿼리를", "DB 조회를"), request), null);
});

test("bounded cards alone support clauses; absent evidence cannot be re-retrieved", () => {
  const bounded = { ...prepared, candidateSources: prepared.candidateSources.map((card) => ({
    ...card, evidence: card.id === selected[0] ? "CateQuest DTO Projection JPQL DB 접근" : card.evidence
  })) };
  assert.notEqual(check("CateQuest는 DTO Projection으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.", bounded), null);
});

test("one bounded source can cover two synthesis subject groups when both have supported clauses", () => {
  const request = prepareGroundedRequest("P95와 RPS를 종합해 설명해줘", context);
  assert.equal(request.obligations.kind, "synthesis");
  const answer = "P95 응답 시간을 47.28ms에서 8.32ms로 줄였습니다. RPS 초당 처리량은 340.95/s에서 362.80/s로 개선했습니다.";
  assert.equal(check(answer, request, ["project-makertion-cache"]), null);
  assert.notEqual(check(answer.split(". ")[0] + ".", request, ["project-makertion-cache"]), null);
});
