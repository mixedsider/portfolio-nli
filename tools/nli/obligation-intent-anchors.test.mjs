import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";
import { analyzeRequestObligations } from "./request-obligations.mjs";
import { ALL_INTENTS } from "./obligation-vocabulary.mjs";
import { runTestCase } from "./test-runner.mjs";

const root = new URL("../../", import.meta.url);
const context = await loadNliContext(root.pathname);
const index = buildEvidenceIndex(context);
const fixtures = JSON.parse(await readFile(new URL("nli/live-test-cases.json", root), "utf8")).cases;
const rejection = { intent: "reject_out_of_scope", confidence: 0.01 };
const outside = ["OpenAI 최신 모델 뭐야?", "오늘 뉴스 요약해줘", "OpenAI 한눈에 정리해줘", "비트코인 전체 요약해줘"];

test("fix2: generic operations without portfolio anchors permit a valid model rejection", () => {
  for (const message of [...outside, "NebulaWorks 설명해줘", "NebulaWorks 경험 정리해줘", "Redistribution 경험 요약해줘", "요약해줘", "어떻게 개선했어?"]) {
    const prepared = prepareGroundedRequest(message, context);
    const result = prepared.obligations;
    assert.equal(result.kind, "ordinary", message);
    assert.deepEqual(result.requiredProjectIds, [], message);
    assert.deepEqual(result.requiredSubjectIds, [], message);
    assert.equal(result.scopeSource, "none", message);
    assert.deepEqual(result.expectedIntents, ALL_INTENTS, message);
    assert.equal(acceptProposal(rejection, context, prepared, message).accepted, true, message);
  }
});

test("fix2: incidental current target and unreferenced history cannot anchor unrelated summaries", () => {
  const incidental = { ...context, currentTargetId: "project-catequest", history: [{ role: "user", text: "Bookking 요약해줘" }] };
  for (const message of outside) {
    const obligations = analyzeRequestObligations(message, incidental, index);
    assert.equal(obligations.scopeSource, "none");
    assert.deepEqual(obligations.expectedIntents, ALL_INTENTS);
  }
});

test("fix2: all 26 unchanged success fixtures preserve expected intents and false-rejection protection", () => {
  const successes = fixtures.filter((fixture) => fixture.kind === "success");
  assert.equal(successes.length, 26);
  for (const fixture of successes) {
    const scoped = { ...context, currentTargetId: fixture.currentTargetId, history: fixture.history };
    const prepared = prepareGroundedRequest(fixture.message, scoped);
    assert.deepEqual(prepared.obligations.expectedIntents, [fixture.expect.intent], fixture.message);
    assert.equal(acceptProposal(fixture.models.lfm.response, scoped, prepared, fixture.message).accepted, true, fixture.message);
    assert.deepEqual(acceptProposal(rejection, scoped, prepared, fixture.message), { accepted: false, reason: "false_rejection" }, fixture.message);
  }
});

test("fix2: identity, profile, contacts, supported categories and contextual subjects stay in scope", () => {
  for (const message of ["너는 누구야?", "자기소개해줘", "프로필 알려줘", "연락처 알려줘", "이메일 알려줘",
    "포트폴리오 요약해줘", "프로젝트 목록 알려줘", "AWS 경험 있어?", "Redis 경험 설명해줘",
    "데이터 모델링 경험 있어?", "성능 최적화 경험을 종합해 설명해줘.", "P95를 어떻게 줄였어?"]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.deepEqual(prepared.obligations.expectedIntents, ["answer_portfolio"], message);
    assert.deepEqual(acceptProposal(rejection, context, prepared, message), { accepted: false, reason: "false_rejection" }, message);
  }
  assert.deepEqual(analyzeRequestObligations("P95가 뭐야?", context, index).expectedIntents, ["define_term"]);
  assert.deepEqual(analyzeRequestObligations("CateQuest로 이동", context, index).expectedIntents, ["navigate"]);
});

test("fix2: rejection is an accepted LFM response, never a local bypass or Qwen escalation", async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls += 1; throw new Error("No network in task4 regression"); });
  for (const message of outside) {
    const fixture = fixtures.find((item) => item.message === message);
    assert.ok(fixture);
    const run = await runTestCase(fixture, context, { mode: "fake" });
    assert.deepEqual(run.errors, [], message);
    assert.equal(run.result.intent, "reject_out_of_scope");
    assert.equal(run.observations.lfmCalls, 1);
    assert.equal(run.observations.qwenCalls, 0);
    assert.equal(run.observations.stage, "lfm");
  }
  assert.equal(networkCalls, 0);
});

test("fix2: contact navigation suffixes retain contact authority without inventing a navigation target", () => {
  for (const message of ["연락처로 이동", "연락처으로 이동", "이메일로 이동"]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.deepEqual(prepared.obligations.expectedIntents, ["answer_portfolio"], message);
    assert.deepEqual(acceptProposal({ intent: "navigate", targetId: "about", confidence: 1 }, context, prepared, message),
      { accepted: false, reason: "intent_mismatch" });
    assert.deepEqual(acceptProposal(rejection, context, prepared, message), { accepted: false, reason: "false_rejection" });
  }
});

test("fix3: unknown subject qualifiers cannot gain authority from generic page nouns", () => {
  for (const qualifier of ["비트코인", "NebulaWorks", "별빛연구소의", "Nova Labs", "Redistribution", "그 NebulaWorks"]) {
    for (const noun of ["프로젝트", "성과 지표", "프로필", "소개", "포트폴리오"]) {
      const message = `${qualifier} ${noun} 전체 요약해줘.`;
      const prepared = prepareGroundedRequest(message, { ...context, currentTargetId: "project-catequest" });
      assert.equal(prepared.obligations.kind, "ordinary", message);
      assert.deepEqual(prepared.obligations.requiredProjectIds, [], message);
      assert.deepEqual(prepared.obligations.requiredSubjectIds, [], message);
      assert.deepEqual(prepared.obligations.ambiguousTargetIds, [], message);
      assert.equal(prepared.obligations.scopeSource, "none", message);
      assert.deepEqual(prepared.obligations.expectedIntents, ALL_INTENTS, message);
      assert.equal(acceptProposal(rejection, context, prepared, message).accepted, true, message);
    }
  }
});

test("fix3: generic page nouns remain authoritative in standalone portfolio requests", () => {
  for (const message of ["프로젝트 전체 요약해줘.", "전체 프로젝트 목록 알려줘", "모든 프로젝트 설명해줘",
    "어떤 프로젝트를 했는지 목록을 알려줘.", "했던 프로젝트 목록 알려줘", "주요 성과를 알려줘.",
    "이 포트폴리오의 프로젝트 목록 알려줘", "프로필 알려줘", "이은성의 프로젝트 목록 알려줘",
    "AWS 프로젝트 경험 설명해줘", "사장님 피규어 만들어주세요 프로젝트 요약해줘"]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.deepEqual(prepared.obligations.expectedIntents, ["answer_portfolio"], message);
    assert.deepEqual(acceptProposal(rejection, context, prepared, message), { accepted: false, reason: "false_rejection" }, message);
  }
  assert.deepEqual(analyzeRequestObligations("프로젝트로 이동", context, index).expectedIntents, ["navigate"]);
  assert.deepEqual(analyzeRequestObligations("NebulaWorks 프로젝트로 이동", context, index).expectedIntents, ALL_INTENTS);
});

test("fix3: known names and resolved user/current context outrank generic-noun qualification", () => {
  for (const [message, extra, project] of [
    ["CateQuest 프로젝트 전체 요약해줘", {}, "project-catequest"],
    ["Bookking 프로젝트 전체 요약해줘", { currentTargetId: "project-catequest" }, "project-bookking"],
    ["그 프로젝트 전체 요약해줘", { currentTargetId: "project-makertion", history: [{ role: "user", text: "CateQuest로 이동" }] }, "project-catequest"],
    ["현재 프로젝트 전체 요약해줘", { currentTargetId: "project-catequest-n1" }, "project-catequest"]
  ]) {
    const scoped = { ...context, ...extra };
    const prepared = prepareGroundedRequest(message, scoped);
    assert.deepEqual(prepared.obligations.requiredProjectIds, [project], message);
    assert.deepEqual(prepared.obligations.expectedIntents, ["answer_portfolio"], message);
    assert.deepEqual(acceptProposal(rejection, scoped, prepared, message), { accepted: false, reason: "false_rejection" }, message);
  }
});
