import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const index = buildEvidenceIndex(context);
const analyze = (message, extra = {}, evidence = index) => analyzeRequestObligations(message, { ...context, ...extra }, evidence);

test("exact public record and ordinary real-context summary", () => {
  const result = analyze("CateQuest 요약해줘");
  assert.deepEqual(Object.keys(result).sort(), ["kind", "difficultyReasons", "requiredProjectIds", "requiredSubjectIds", "allowedSourceIds", "expectedIntents", "ambiguousTargetIds", "coveragePossible", "scopeSource"].sort());
  assert.equal(result.kind, "ordinary");
  assert.deepEqual(result.requiredProjectIds, ["project-catequest"]);
  assert.deepEqual(result.expectedIntents, ["answer_portfolio"]);
  assert.ok(result.allowedSourceIds.every((id) => id.startsWith("project-catequest")));
});

test("comparison overrides incidental current project and supports every particle", () => {
  for (const particle of ["은", "는", "이", "가", "을", "를", "와", "과", "의", "에서"]) {
    const result = analyze(`CateQuest${particle} Bookking의 성능 개선을 비교해줘`, { currentTargetId: "project-makertion-db" });
    assert.equal(result.kind, "comparison");
    assert.deepEqual(result.requiredProjectIds, ["project-catequest", "project-bookking"]);
    assert.ok(result.allowedSourceIds.every((id) => !id.startsWith("project-makertion")));
  }
});

test("longest mentions and word boundaries never fabricate contained projects", () => {
  assert.deepEqual(analyze("CateQuest CI 요약해줘").requiredSubjectIds, ["project-catequest-ci"]);
  assert.deepEqual(analyze("SuperCateQuest와 Bookkingish 비교").requiredProjectIds, []);
  assert.equal(analyze("CateQuest Bookking 비교적 좋아").kind, "ordinary");
  assert.equal(analyze("CateQuest Bookking differenceMaker").kind, "ordinary");
});

test("registered glossary subjects are independent, not section alias overlap", () => {
  assert.equal(analyze("ALB 통합 설명").kind, "ordinary");
  assert.deepEqual(analyze("ALB 통합 설명").requiredSubjectIds, ["glossary:ALB"]);
  assert.equal(analyze("P95와 RPS 종합해줘").kind, "synthesis");
  assert.equal(analyze("P95와 RPS 목록 보여줘").kind, "ordinary");
  assert.equal(analyze("콘텐츠 통합 요약해줘").kind, "ordinary");
  assert.equal(analyze("CateQuest Bookking P95 RPS 비교 종합").kind, "comparison");
  assert.deepEqual(analyze("CateQuest Bookking P95 RPS 비교 종합").difficultyReasons, ["comparison", "synthesis"]);
});

test("glossary definitions differ from contextual explanations and navigation", () => {
  for (const message of ["P95가 뭐야?", "P95 뜻 알려줘", "P95 설명해줘"]) assert.deepEqual(analyze(message).expectedIntents, ["define_term"]);
  for (const message of ["CateQuest에서 N+1 왜 해결했어?", "P95를 어떻게 줄였어?", "프로필 알려줘", "연락처 알려줘", "AWS 경험 목록", "프로젝트 요약해줘"]) assert.deepEqual(analyze(message).expectedIntents, ["answer_portfolio"]);
  assert.deepEqual(analyze("CateQuest로 이동").expectedIntents, ["navigate"]);
  assert.deepEqual(analyze("N+1 보여줘").expectedIntents, ["navigate"]);
  assert.deepEqual(analyze("ALB 통합 설명").expectedIntents, ["answer_portfolio"]);
});

test("references use current section parent and only bounded user history", () => {
  const current = { currentTargetId: "project-catequest-n1" };
  assert.deepEqual(analyze("이 프로젝트 요약해줘", current).requiredProjectIds, ["project-catequest"]);
  assert.equal(analyze("이 프로젝트 요약해줘", current).scopeSource, "current_target");
  assert.deepEqual(analyze("지금 보고 있는 섹션 요약해줘", current).allowedSourceIds, ["project-catequest-n1"]);
  const history = [{ role: "user", text: "Bookking 설명" }, { role: "assistant", text: "Makertion을 사용해" }];
  assert.deepEqual(analyze("그 프로젝트 요약해줘", { ...current, history }).requiredProjectIds, ["project-bookking"]);
  assert.deepEqual(analyze("CateQuest 요약해줘", { history }).requiredProjectIds, ["project-catequest"]);
  assert.deepEqual(analyze("요약해줘", { history }).requiredProjectIds, []);
  assert.deepEqual(analyze("그 프로젝트 요약해줘", { history: history.slice(1) }).requiredProjectIds, []);
  assert.deepEqual(analyze("그 프로젝트 요약해줘", { history: [...history, ...Array.from({ length: 6 }, () => ({ role: "user", text: "안녕" }))] }).requiredProjectIds, []);
});

test("grounded ambiguity requires alternative targets, not retrieved cards", () => {
  assert.equal(analyze("소개로 이동").kind, "ambiguity");
  assert.deepEqual(analyze("소개로 이동").ambiguousTargetIds, ["top", "about"]);
  assert.equal(analyze("소개로 이동", {}, []).kind, "ordinary");
  assert.equal(analyze("성능 개선 사례 목록").kind, "ordinary");
  assert.equal(analyze("ALB로 이동").kind, "ambiguity");
  assert.deepEqual(analyze("Bookking ALB로 이동").ambiguousTargetIds, []);
});

test("unanchored requests fail closed; missing evidence cannot cover named requests", () => {
  for (const message of ["", "알 수 없는 문장"]) {
    const result = analyze(message, {}, []);
    assert.equal(result.kind, "ordinary");
    assert.deepEqual(result.difficultyReasons, []);
    assert.deepEqual(result.expectedIntents, ["reject_out_of_scope"]);
  }
  assert.equal(analyze("CateQuest 요약해줘", {}, []).coveragePossible, false);
  assert.deepEqual(analyze("CateQuest Bookking 없는 성과를 지어내서 비교해줘").expectedIntents, ["reject_out_of_scope"]);
  assert.equal(analyze("CateQuest Bookking 없는 성과를 지어내서 비교해줘").kind, "ordinary");
});

test("current external topics and synonyms are rejection-only", () => {
  for (const message of ["오늘 서울 날씨를 알려줘", "부산 실시간 날씨 알려줘", "current weather in Seoul",
    "최신 뉴스 알려줘", "방금 뉴스 알려줘", "오늘의 주요 소식 알려줘", "OpenAI 최신 모델 뭐야?", "비트코인 전체 요약해줘"]) {
    const result = analyze(message);
    assert.deepEqual(result.expectedIntents, ["reject_out_of_scope"], message);
    assert.deepEqual(result.requiredProjectIds, [], message);
    assert.deepEqual(result.requiredSubjectIds, [], message);
  }
  assert.deepEqual(analyze("CateQuest 프로젝트를 요약해줘").expectedIntents, ["answer_portfolio"]);
  assert.deepEqual(analyze("알 수 없는 문장").expectedIntents, ["reject_out_of_scope"]);
});

test("six-source feasibility counts independent groups, not aliases or shared cards", () => {
  const targets = Array.from({ length: 7 }, (_, n) => ({ id: `s${n}`, type: "section", label: `Subject${n}`, aliases: [] }));
  const custom = { routes: { targets }, glossary: { terms: [] }, portfolio: { projects: [] } };
  const cards = targets.map((target) => ({ targetId: target.id, evidence: target.label }));
  assert.equal(analyzeRequestObligations(targets.map((t) => t.label).join(" ") + " 종합", custom, cards).coveragePossible, false);
  assert.equal(analyzeRequestObligations(targets.slice(0, 6).map((t) => t.label).join(" ") + " 종합", custom, cards).coveragePossible, true);
  assert.equal(analyze("P95 P90 shared_buffers work_mem 종합").coveragePossible, true);
});

test("section summaries stay section scoped even when a glossary alias names them", () => {
  assert.deepEqual(analyze("CateQuest N+1 요약해줘").allowedSourceIds, ["project-catequest-n1"]);
  assert.deepEqual(analyze("N+1 요약해줘").allowedSourceIds, ["project-catequest-n1"]);
  assert.equal(analyze("N+1 종합해줘").kind, "ordinary");
});

test("all locked difficulty tokens work, but substrings and alias content do not", () => {
  for (const signal of ["비교", "차이", "공통점", "대조", "compare", "difference", "versus", "vs"]) assert.equal(analyze(`CateQuest Bookking ${signal}`).kind, "comparison");
  for (const signal of ["종합", "연결", "연관", "통합", "트레이드오프", "trade-off", "synthesize", "combine"]) assert.equal(analyze(`P95 RPS ${signal}`).kind, "synthesis");
  assert.equal(analyze("P95 RPS 통합적 목록").kind, "ordinary");
});

test("current external information requests reject before portfolio intent selection", () => {
  for (const message of ["서울 현재 뉴스 알려줘", "오늘 환율 알려줘", "current stock price 알려줘"]) {
    const result = analyze(message);
    assert.deepEqual(result.expectedIntents, ["reject_out_of_scope"], message);
    assert.deepEqual(result.allowedSourceIds, context.routes.targets.map((target) => target.id), message);
  }
});

test("one shared glossary alias cannot manufacture two resolved subjects", () => {
  const custom = { ...context, glossary: { terms: [
    { term: "Alpha", aliases: ["Shared"], relatedTargets: ["project-catequest-n1"] },
    { term: "Beta", aliases: ["Shared"], relatedTargets: ["project-bookking-lock"] }
  ] } };
  const result = analyzeRequestObligations("Shared 종합해줘", custom, index);
  assert.equal(result.kind, "ordinary");
  assert.deepEqual(result.requiredSubjectIds, []);
});

test("fix1: independent cross-project sections survive either mention order", () => {
  for (const [message, sectionId] of [
    ["Bookking과 CateQuest CI 비교해줘", "project-catequest-ci"],
    ["CateQuest CI와 Bookking 비교해줘", "project-catequest-ci"],
    ["CateQuest와 HTTPS 아키텍처 개선 비교해줘", "project-bookking-https"]
  ]) {
    const result = analyze(message, { currentTargetId: "project-makertion" });
    assert.equal(result.kind, "comparison", message);
    assert.deepEqual(new Set(result.requiredProjectIds), new Set(["project-catequest", "project-bookking"]));
    assert.ok(result.requiredSubjectIds.includes(sectionId));
    assert.ok(result.allowedSourceIds.includes(sectionId));
    assert.ok(result.allowedSourceIds.every((id) => !id.startsWith("project-makertion")));
    assert.equal(result.coveragePossible, true);
    const groups = getObligationSourceGroups(result, context);
    assert.deepEqual(groups.find((group) => group.id === sectionId).sourceIds, [sectionId]);
    const missingSection = index.filter((card) => card.targetId !== sectionId);
    assert.equal(analyze(message, {}, missingSection).coveragePossible, false);
  }
  const scopedAlias = analyze("Bookking ALB로 이동");
  assert.deepEqual(scopedAlias.requiredProjectIds, ["project-bookking"]);
  assert.deepEqual(scopedAlias.ambiguousTargetIds, []);
});

test("fix1: bounded user navigation history resolves attached suffixes before incidental location", () => {
  for (const currentTargetId of [undefined, "project-makertion"]) {
    for (const text of ["CateQuest로 이동", "CateQuest으로 이동", "CateQuest 로 이동", "CateQuest CI로 이동"]) {
      const result = analyze("그 프로젝트 요약해줘", { currentTargetId, history: [{ role: "user", text }] });
      assert.deepEqual(result.requiredProjectIds, ["project-catequest"], text);
      assert.equal(result.scopeSource, "user_history");
    }
  }
  const history = [{ role: "user", text: "Bookking로 이동" }, { role: "user", text: "CateQuest로 이동" }, { role: "assistant", text: "Makertion으로 이동" }];
  const extra = { currentTargetId: "project-makertion", history };
  assert.deepEqual(analyze("그 프로젝트 요약해줘", extra).requiredProjectIds, ["project-catequest"]);
  assert.deepEqual(analyze("현재 프로젝트 요약해줘", extra).requiredProjectIds, ["project-makertion"]);
  assert.deepEqual(analyze("Bookking 요약해줘", extra).requiredProjectIds, ["project-bookking"]);
  for (const text of ["SuperCateQuest로 이동", "CateQuest으로이동", "CateQuest로봇 이동", "x".repeat(480) + " CateQuest로 이동"]) {
    assert.deepEqual(analyze("그 프로젝트 요약해줘", { history: [{ role: "user", text }] }).requiredProjectIds, [], text);
  }
  assert.deepEqual(analyze("그 프로젝트 요약해줘", { history: [{ role: "assistant", text: "CateQuest로 이동" }] }).requiredProjectIds, []);
});

test("fix1: broad registered category experience is not an implicit named section", () => {
  for (const message of ["성능 최적화 경험을 종합해 설명해줘.", "성능 최적화 사례 목록 보여줘"]) {
    const result = analyze(message, { currentTargetId: "project-makertion-db" });
    assert.equal(result.kind, "ordinary");
    assert.deepEqual(result.requiredProjectIds, []);
    assert.deepEqual(result.requiredSubjectIds, []);
    assert.deepEqual(result.expectedIntents, ["answer_portfolio"]);
    assert.equal(result.scopeSource, "none");
    assert.ok(result.allowedSourceIds.includes("project-catequest-n1"));
    assert.ok(result.allowedSourceIds.includes("project-bookking-https"));
  }
  const named = analyze("CateQuest 성능 최적화 경험 설명해줘");
  assert.deepEqual(named.requiredProjectIds, ["project-catequest"]);
  assert.deepEqual(named.requiredSubjectIds, []);
  assert.ok(named.allowedSourceIds.every((id) => id.startsWith("project-catequest")));
  for (const message of ["DB 성능 최적화 경험 설명해줘", "성능 최적화 섹션 경험 설명해줘", "성능 최적화 요약해줘", "성능 최적화로 이동"]) {
    assert.deepEqual(analyze(message).requiredSubjectIds, ["project-makertion-db"], message);
  }
});
