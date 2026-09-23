import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadNliContext, buildGroundedRequestBlock } from "./context.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { prepareGroundedRequest, selectEvidenceCandidates } from "./evidence-selection.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { listCapabilitiesResponse, assistantIdentityResponse } from "./responses.mjs";
import { validatePortfolioAnswerCandidateShape } from "./portfolio-answer-validation.mjs";
import { isAnswerSupportedBySelectedEvidence } from "./answer-evidence-support.mjs";
import { retrieveEvidenceCandidates } from "./evidence-ranking.mjs";
import { assistantIdentityWords } from "./routing-vocabulary.mjs";
import { resolveLocalFastPath } from "./local-fast-path.mjs";
import { MAX_GROUNDED_CARD_EVIDENCE_BYTES } from "./grounded-bounds.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const prepare = (message, extra = {}) => prepareGroundedRequest(message, { ...context, ...extra });
const ids = (prepared) => prepared.candidateSources.map((card) => card.id);

test("shared assistant identity wording retains bounded top evidence without unrelated projects or a local fast path", () => {
  const messages = [...assistantIdentityWords, "너는 누구야?", "넌 누구야?", "정체를 알려줘",
    "포트폴리오 도우미 소개해줘", "NLI 소개해줘", "ＮＬＩ는 누구야?"];
  for (const message of messages) {
    for (const extra of [{}, { currentTargetId: "project-ott", history: [
      { role: "user", text: "CateQuest로 이동" }, { role: "assistant", text: "Bookking 설명해줘" }
    ] }]) {
      const prepared = prepare(message, extra);
      assert.equal(resolveLocalFastPath(message, { ...context, ...extra }), null, message);
      const top = prepared.candidateSources.find((card) => card.id === "top");
      assert.ok(top?.evidence.includes(assistantIdentityResponse().answer), message);
      assert.ok(prepared.candidateSources.every((card) => card.type === "page"), message);
      const groups = getObligationSourceGroups(prepared.obligations, context);
      if (!groups.length) assert.deepEqual(ids(prepared), ["top"], message);
      for (const group of groups) assert.ok(group.sourceIds.some((id) => ids(prepared).includes(id)), message);
      assert.ok(Buffer.byteLength(top.evidence) <= MAX_GROUNDED_CARD_EVIDENCE_BYTES);
      assert.deepEqual(JSON.parse(prepared.groundedRequestBlock).candidateSources, prepared.candidateSources);
      assert.equal(buildGroundedRequestBlock(prepared.groundedRequest), prepared.groundedRequestBlock);
    }
  }
});

test("identity relevance cannot fabricate missing or truncated facts or override project scope", () => {
  const message = "너는 누구야?";
  const index = buildEvidenceIndex(context);
  const obligations = analyzeRequestObligations(message, context, index);
  for (const cards of [index.filter((card) => card.id !== "top"), index.map((card) => card.id === "top"
    ? { ...card, evidence: "한".repeat(1000) + assistantIdentityResponse().answer } : card)]) {
    assert.deepEqual(selectEvidenceCandidates(cards, { message }, obligations, context).candidateSources, []);
  }
  const scoped = prepare("Bookking 정체를 설명해줘");
  assert.ok(ids(scoped).length > 0);
  assert.ok(ids(scoped).every((id) => id.startsWith("project-bookking")));
  assert.deepEqual(prepare("unrelated-zzqv").candidateSources, []);
});

test("specific section topics outrank page outlines in legacy retrieval", () => {
  const candidates = retrieveEvidenceCandidates(buildEvidenceIndex(context), {
    message: "포트폴리오에서 동시성 제어 경험을 근거와 함께 설명해줘"
  });
  assert.equal(candidates[0].id, "project-bookking-lock");
});

test("authoritative page evidence uses display facts, shared text and registered outline", () => {
  const cards = new Map(buildEvidenceIndex(context).map((card) => [card.id, card.evidence]));
  for (const contact of context.portfolio.profile.contacts) assert.ok(cards.get("about").includes(contact.value));
  assert.ok(cards.get("top").includes(listCapabilitiesResponse().answer));
  assert.ok(cards.get("top").includes(assistantIdentityResponse().answer));
  for (const project of context.portfolio.projects) {
    assert.ok(cards.get("projects").includes(project.title));
    for (const section of project.sections) assert.ok(cards.get("projects").includes(section.title));
  }
  assert.ok(![...cards.values()].join("\n").includes("mailto:"));
  assert.ok(!cards.get("about").includes("https://github.com"));
});

test("email and project summary use exact bounded prompt candidates despite unrelated location", () => {
  for (const message of ["이은성 이메일 알려줘", "CateQuest 요약해줘"]) {
    const prepared = prepare(message, { currentTargetId: "project-ott" });
    assert.deepEqual(JSON.parse(prepared.groundedRequestBlock).candidateSources, prepared.candidateSources);
    assert.equal(buildGroundedRequestBlock(prepared.groundedRequest), prepared.groundedRequestBlock);
    assert.ok(prepared.candidateSources.every((card) => Buffer.byteLength(card.evidence) <= MAX_GROUNDED_CARD_EVIDENCE_BYTES));
    if (message.includes("이메일")) assert.ok(prepared.candidateSources.some((card) => card.id === "about" && card.evidence.includes("mixeddev0812@gmail.com")));
    else assert.ok(ids(prepared).every((id) => id.startsWith("project-catequest")));
  }
});

test("comparison reserves both named groups before cap and excludes incidental third project", () => {
  const prepared = prepare("CateQuest와 Bookking의 성능 개선을 비교해줘", { currentTargetId: "project-makertion-db" });
  assert.equal(prepared.obligations.kind, "comparison");
  assert.equal(prepared.coveragePossible, true);
  assert.ok(ids(prepared).some((id) => id.startsWith("project-catequest")));
  assert.ok(ids(prepared).some((id) => id.startsWith("project-bookking")));
  assert.ok(ids(prepared).every((id) => /project-(catequest|bookking)/u.test(id)));
  assert.ok(prepared.reservedSourceIds.length <= 6);
  assert.deepEqual(prepared, prepare("CateQuest와 Bookking의 성능 개선을 비교해줘", { currentTargetId: "project-makertion-db" }));
});

test("current project resolves section parent while section summary stays exact", () => {
  const extra = { currentTargetId: "project-makertion-cost" };
  assert.ok(ids(prepare("현재 프로젝트 요약해줘", extra)).every((id) => id.startsWith("project-makertion")));
  assert.deepEqual(ids(prepare("현재 보고 있는 섹션 요약해줘", extra)), ["project-makertion-cost"]);
  assert.deepEqual(ids(prepare("CateQuest N+1 해결 요약해줘", extra)), ["project-catequest-n1"]);
});

test("English project alias summaries retain section results, not only the alias root", () => {
  const prepared = prepare("Makertion 프로젝트 설명해줘", { currentTargetId: "project-catequest" });
  assert.ok(ids(prepared).includes("project-makertion-db"));
  assert.ok(prepared.candidateSources.some((card) => card.evidence.includes("120.45ms")));
  assert.ok(ids(prepared).every((id) => id.startsWith("project-makertion")));
});

test("consumer rejects fake contacts, fake sources and facts removed from bounded evidence", () => {
  const prepared = prepare("이은성 이메일 알려줘");
  for (const proposal of [
    { answer: "Email: impostor999@example.test", sourceIds: ["about"] },
    { answer: "Email: mixeddev0812@gmail.com", sourceIds: ["fake-contact"] }
  ]) {
    const errors = [];
    validatePortfolioAnswerCandidateShape(proposal, context, prepared.candidateSources, errors);
    assert.ok(errors.length > 0);
  }
  const errors = [];
  validatePortfolioAnswerCandidateShape({ answer: "Email: mixeddev0812@gmail.com", sourceIds: ["about"] }, context, prepared.candidateSources, errors);
  assert.deepEqual(errors, []);
  const longContext = { ...context, portfolio: { ...context.portfolio,
    profile: { ...context.portfolio.profile, summary: "한".repeat(1500) + " Tailmarker987 99991ms" } } };
  const bounded = prepareGroundedRequest("자기소개해줘", longContext).candidateSources.find((card) => card.id === "about");
  const full = buildEvidenceIndex(longContext).find((card) => card.id === "about");
  assert.equal(isAnswerSupportedBySelectedEvidence("Tailmarker987 99991ms", full.evidence), true);
  assert.equal(isAnswerSupportedBySelectedEvidence("Tailmarker987 99991ms", bounded.evidence), false);
});

test("missing groups and stale fake cards never become unrelated substitutes", () => {
  const index = buildEvidenceIndex(context).filter((card) => !card.id.startsWith("project-bookking"));
  index.push({ id: "fake-contact", targetId: "fake-contact", evidence: "Bookking email fake@example.test" });
  const obligations = analyzeRequestObligations("CateQuest와 Bookking 비교해줘", context, index);
  const result = selectEvidenceCandidates(index, { message: "CateQuest와 Bookking 비교해줘" }, obligations, context);
  assert.equal(result.coveragePossible, false);
  assert.ok(result.missingGroupIds.includes("project-bookking"));
  assert.ok(result.candidateSources.every((card) => context.targetById.has(card.id)));
});

test("reservation solves AND groups with OR alternatives within six sources, before eight cap", () => {
  const targets = Array.from({ length: 12 }, (_, i) => ({ id: `source-${i}`, type: "section", label: `Source ${i}` }));
  const terms = Array.from({ length: 7 }, (_, i) => ({ term: `term${i}`, relatedTargets: [`source-${i}`, "source-11"] }));
  const fixture = { routes: { targets }, glossary: { terms }, portfolio: { projects: [] } };
  const index = targets.map((target, i) => ({ ...target, targetId: target.id, evidence: `topic ${"topic ".repeat(12 - i)}` }));
  const obligations = { requiredProjectIds: [], requiredSubjectIds: terms.map((term) => `glossary:${term.term}`), allowedSourceIds: targets.map((target) => target.id), ambiguousTargetIds: [], coveragePossible: true };
  const selected = selectEvidenceCandidates(index, { message: "topic" }, obligations, fixture);
  assert.equal(selected.coveragePossible, true);
  assert.ok(selected.reservedSourceIds.length <= 6);
  assert.ok(selected.candidateSources.length <= 8);
  assert.ok(selected.candidateSources.some((card) => card.id === "source-11"));
  for (const group of getObligationSourceGroups(obligations, fixture)) assert.ok(group.sourceIds.some((id) => selected.reservedSourceIds.includes(id)));
  fixture.glossary.terms.forEach((term, i) => { term.relatedTargets = [`source-${i}`]; });
  assert.equal(selectEvidenceCandidates(index, { message: "topic" }, obligations, fixture).coveragePossible, false);
});

test("removed text cannot establish retrieval relevance or acceptance candidates", () => {
  const fixture = { routes: { targets: [{ id: "about", type: "page", label: "About" }] }, glossary: { terms: [] }, portfolio: { projects: [] } };
  const index = [{ targetId: "about", evidence: "한".repeat(1000) + " tailcontact@example.test" }];
  const obligations = analyzeRequestObligations("tailcontact", fixture, index);
  const selected = selectEvidenceCandidates(index, { message: "tailcontact" }, obligations, fixture);
  assert.deepEqual(selected.candidateSources, []);
});

test("prepared obligations fail closed when a required subject survives only in a removed tail", () => {
  const fixture = { ...context, portfolio: { ...context.portfolio,
    profile: { ...context.portfolio.profile, summary: "한".repeat(2000) } },
    glossary: { terms: [{ term: "Tailmarker987", aliases: [], relatedTargets: ["about"], answer: "Tailmarker987 99991ms" }] } };
  const prepared = prepareGroundedRequest("Tailmarker987 뭐야?", fixture);
  assert.equal(prepared.coveragePossible, false);
  assert.equal(prepared.obligations.coveragePossible, false);
  assert.deepEqual(prepared.missingGroupIds, ["glossary:Tailmarker987"]);
});

test("bounded history is identical for transport; only user referents establish scope", () => {
  const history = [{ role: "user", text: "CateQuest 요약해줘" }, { role: "assistant", text: "Bookking 요약해줘" }];
  const prepared = prepare("그 프로젝트 요약해줘", { history, currentTargetId: "project-ott" });
  assert.ok(ids(prepared).every((id) => id.startsWith("project-catequest")));
  assert.deepEqual(prepared.groundedRequest.history, JSON.parse(prepared.groundedRequestBlock).conversation);
  assert.strictEqual(prepared.candidateSources, prepared.groundedRequest.candidateSources);
  assert.throws(() => { prepared.candidateSources[0].evidence = "fake"; }, TypeError);
  assert.deepEqual(prepare("이은성 이메일 알려줘", { history }).candidateSources, prepare("이은성 이메일 알려줘").candidateSources);
});

test("migrated live fixtures retain requested facts within the actual prompt budget", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../nli/live-test-cases.json", import.meta.url), "utf8"));
  const intents = new Set(["introduce_profile", "summarize_portfolio", "list_toc", "list_contacts", "list_achievements", "list_skill_experience", "summarize_project", "summarize_section", "list_capabilities", "list_projects"]);
  for (const fixture of fixtures.cases.filter((item) => intents.has(item.expect.intent))) {
    const prepared = prepare(fixture.message, { currentTargetId: fixture.currentTargetId });
    const text = prepared.candidateSources.map((card) => card.evidence).join("\n");
    assert.ok(prepared.candidateSources.length > 0, fixture.message);
    if (fixture.expect.answerIncludes) assert.ok(text.includes(fixture.expect.answerIncludes), fixture.message);
    if (fixture.expect.answerExcludes) assert.ok(!text.includes(fixture.expect.answerExcludes), fixture.message);
    assert.equal(prepared.coveragePossible, true, fixture.message);
  }
});

test("compact section cards retain quantitative, implementation and project-summary witnesses", () => {
  const cache = prepare("현재 프로젝트에서 캐싱을 어떻게 개선했어?", { currentTargetId: "project-makertion-db" })
    .candidateSources.find((card) => card.id === "project-makertion-cache");
  assert.ok(cache.evidence.includes("+6.4%"));
  assert.ok(cache.evidence.includes("340.95/s"));
  assert.ok(cache.evidence.includes("362.80/s"));

  const cost = prepare("Makertion 비용 절감 내용을 설명해줘")
    .candidateSources.find((card) => card.id === "project-makertion-cost");
  assert.ok(cost.evidence.includes("1/20"));
  assert.ok(cost.evidence.includes("NAT Gateway를 제거"));

  const catequest = prepare("CateQuest 프로젝트를 요약해줘");
  const summaryEvidence = catequest.candidateSources.map((card) => card.evidence).join("\n");
  for (const witness of ["2025.06 ~ 2025.11", "Spring Boot", "Query Tuning", "EleutherAI/polyglot-ko-1.3b"])
    assert.ok(summaryEvidence.includes(witness), witness);
  assert.ok(catequest.candidateSources.every((card) => Buffer.byteLength(card.evidence) <= 600));

  const currentMessage = "이 프로젝트에서 비용은 어떻게 줄였어?";
  const current = prepare(currentMessage, { currentTargetId: "project-makertion" });
  const response = { intent: "answer_portfolio", confidence: 0.01,
    answer: "NAT Gateway를 제거하고 EC2 인스턴스 네트워크를 Public IP 기반으로 변경했습니다. CloudWatch 로그 수집 정책을 수정해 일일 서버 비용을 약 31% 절감했습니다.",
    sourceIds: ["project-makertion-cost"] };
  assert.equal(acceptProposal(response, context, current, currentMessage).accepted, true);
});
