import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext, buildGroundedRequestBlock } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";
import { MAX_GROUNDED_CARD_EVIDENCE_BYTES } from "./grounded-bounds.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const full = JSON.parse(buildGroundedRequestBlock({ targets: context.routes.targets, terms: context.glossary.terms }));
const prepare = (message, extra = {}) => prepareGroundedRequest(message, { ...context, ...extra });

test("profile answer removes unused registry payload rather than shipping 6247 bytes of target/term catalogs", () => {
  const prepared = prepare("자기소개해줘");
  assert.deepEqual(prepared.obligations.expectedIntents, ["answer_portfolio"]);
  assert.deepEqual(prepared.groundedRequest.targets.map((target) => target.id), ["about"]);
  assert.deepEqual(prepared.groundedRequest.terms, []);
  assert.ok(Buffer.byteLength(prepared.groundedRequestBlock) < 1500);
  assert.ok(prepared.candidateSources[0].evidence.includes(context.portfolio.profile.summary));
});

test("known answer requests project only candidate and required registered IDs without changing evidence or obligations", () => {
  for (const message of ["이은성 이메일 알려줘", "CateQuest 요약해줘", "AWS 경험 있어?",
    "이 프로젝트에서 비용은 어떻게 줄였어?", "이 포트폴리오에서 뭘 할 수 있어?",
    "CateQuest N+1 해결과 Bookking HTTPS 성능 개선을 비교해줘"]) {
    const scoped = { ...context, currentTargetId: "project-makertion" };
    const prepared = prepareGroundedRequest(message, scoped);
    const original = analyzeRequestObligations(message, scoped, buildEvidenceIndex(scoped));
    assert.deepEqual(prepared.obligations, original, message);
    assert.deepEqual(original.expectedIntents, ["answer_portfolio"], message);
    const ids = new Set(prepared.candidateSources.map((card) => card.id));
    const expectedTargetIds = ["comparison", "synthesis"].includes(original.kind) ? [] :
      context.routes.targets.filter((target) => ids.has(target.id)).map((target) => target.id);
    assert.deepEqual(prepared.groundedRequest.targets.map((target) => target.id),
      expectedTargetIds, message);
    assert.ok(prepared.groundedRequest.targets.every((target) => !Object.hasOwn(target, "aliases")));
    assert.deepEqual(prepared.groundedRequest.terms.map((term) => term.term),
      context.glossary.terms.filter((term) => original.requiredSubjectIds.includes(`glossary:${term.term}`)).map((term) => term.term));
    for (const group of getObligationSourceGroups(original, scoped))
      assert.ok(group.sourceIds.some((id) => prepared.reservedSourceIds.includes(id)));
    const block = JSON.parse(prepared.groundedRequestBlock);
    assert.deepEqual(block.candidateSources, prepared.candidateSources);
    assert.strictEqual(prepared.candidateSources, prepared.groundedRequest.candidateSources);
    assert.equal(buildGroundedRequestBlock(prepared.groundedRequest), prepared.groundedRequestBlock);
    assert.ok(Object.isFrozen(prepared.groundedRequest.targets));
    assert.ok(prepared.candidateSources.length <= 8);
    assert.ok(prepared.candidateSources.every((card) => Buffer.byteLength(card.evidence) <= MAX_GROUNDED_CARD_EVIDENCE_BYTES));
  }
});

test("registered definitions and contextual glossary requests retain only required canonical terms", () => {
  for (const message of ["P95가 뭐야?", "P95를 어떻게 줄였어?"]) {
    const prepared = prepare(message);
    assert.deepEqual(prepared.groundedRequest.terms, [{ term: "P95" }]);
    if (message.includes("뭐야")) {
      assert.equal(prepared.candidateSources.length, 1);
      assert.equal(prepared.candidateSources[0].evidence,
        "P95\nP95는 전체 요청 중 95%가 이 시간 안에 응답했다는 뜻입니다. 평균보다 느린 상위 요청 구간의 사용자 경험을 확인할 때 유용합니다.");
      const result = acceptProposal({ intent: "define_term", confidence: 1, term: "P95" }, context, prepared, message);
      assert.equal(result.accepted, true);
    } else assert.ok(prepared.candidateSources.length > 0);
  }
});

test("resolved navigation carries only its registered target and no answer evidence", () => {
  for (const [message, targetId] of [
    ["CateQuest로 이동", "project-catequest"],
    ["N+1 보여줘", "project-catequest-n1"],
    ["Bookking ALB로 이동", "project-bookking-https"],
    ["About으로 이동", "about"]
  ]) {
    const prepared = prepare(message);
    const { id, label, type } = context.targetById.get(targetId);
    assert.deepEqual(prepared.candidateSources, [], message);
    assert.deepEqual(prepared.groundedRequest.targets, [{ id, label, type }], message);
    assert.deepEqual(prepared.groundedRequest.terms, [], message);
    assert.equal(prepared.coveragePossible, true, message);
  }
});

test("rejections carry no registries while ambiguity retains resolution options", () => {
  const weather = prepare("오늘 서울 날씨를 알려줘");
  assert.deepEqual(weather.obligations.expectedIntents, ["reject_out_of_scope"]);
  assert.deepEqual(weather.candidateSources, []);
  assert.deepEqual(weather.groundedRequest.targets, []);
  assert.deepEqual(weather.groundedRequest.terms, []);
  const ambiguous = prepare("소개로 이동");
  assert.deepEqual(ambiguous.groundedRequest.targets, full.targets);
  assert.deepEqual(ambiguous.groundedRequest.terms, full.terms);
  for (const message of ["요약해줘", "NebulaWorks 프로젝트 전체 요약해줘.", "어떻게 개선했어?"]) {
    const prepared = prepare(message);
    assert.deepEqual(prepared.obligations.expectedIntents, ["reject_out_of_scope"], message);
    assert.deepEqual(prepared.candidateSources, [], message);
    assert.deepEqual(prepared.groundedRequest.targets, [], message);
    assert.deepEqual(prepared.groundedRequest.terms, [], message);
  }
});

test("section and comparison projection keeps obligations only while a project summary keeps section breadth", () => {
  const section = prepare("CateQuest N+1 해결 방법을 설명해줘");
  assert.deepEqual(section.candidateSources.map((card) => card.id), ["project-catequest-n1"]);
  assert.deepEqual(section.candidateSources.map((card) => card.id), section.reservedSourceIds);

  const comparison = prepare("CateQuest N+1 해결과 Bookking HTTPS 성능 개선을 비교해줘");
  assert.deepEqual(new Set(comparison.candidateSources.map((card) => card.id)),
    new Set(["project-catequest-n1", "project-bookking-https"]));
  assert.deepEqual(new Set(comparison.candidateSources.map((card) => card.id)), new Set(comparison.reservedSourceIds));

  const summary = prepare("CateQuest 프로젝트를 요약해줘");
  assert.deepEqual(new Set(summary.candidateSources.map((card) => card.id)), new Set([
    "project-catequest", "project-catequest-ci", "project-catequest-ai", "project-catequest-n1"
  ]));
  assert.ok(summary.candidateSources.every((card) => card.id.startsWith("project-catequest")));
});

test("explicit measurements and implementation identifiers survive compact projection", () => {
  const duration = prepare("CateQuest N+1 해결과 Bookking HTTPS 성능 개선의 소요 시간을 비교해줘");
  const catequest = duration.candidateSources.find((card) => card.id === "project-catequest-n1");
  assert.match(catequest.evidence, /263ms/);
  assert.match(catequest.evidence, /64ms/);

  for (const [message, sourceId, identifier, witness] of [
    ["CateQuest에서 LinkedHashMap을 어떻게 사용했어?", "project-catequest-n1", "LinkedHashMap", "일기별 태그 목록"],
    ["Bookking에서 PaymentFacade를 어떻게 사용했어?", "project-bookking-lock", "PaymentFacade", "트랜잭션 커밋 이후"],
    ["CateQuest N+1 해결에서 LinkedHashMap을 어떻게 사용했어?", "project-catequest-n1", "LinkedHashMap", "일기별 태그 목록"],
    ["Bookking 분산 락에서 PaymentFacade를 어떻게 사용했어?", "project-bookking-lock", "PaymentFacade", "트랜잭션 커밋 이후"]
  ]) {
    const prepared = prepare(message);
    const card = prepared.candidateSources.find((candidate) => candidate.id === sourceId);
    assert.match(card.evidence, new RegExp(identifier));
    assert.match(card.evidence, new RegExp(witness));
  }
});

test("project metadata is not source authorization and projection never broadens output scope", () => {
  const message = "CateQuest N+1 해결 요약해줘";
  const prepared = prepare(message);
  assert.deepEqual(prepared.candidateSources.map((card) => card.id), ["project-catequest-n1"]);
  assert.deepEqual(prepared.groundedRequest.targets.map((target) => target.id), ["project-catequest-n1"]);
  for (const sourceId of ["project-catequest", "project-bookking"]) {
    const proposal = { intent: "answer_portfolio", confidence: 1, answer: "CateQuest N+1 해결", sourceIds: [sourceId] };
    assert.equal(acceptProposal(proposal, context, prepared, message).accepted, false);
  }
  assert.equal(context.routes.targets.length, full.targets.length);
  assert.equal(context.glossary.terms.length, full.terms.length);
});
