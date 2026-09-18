import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext, buildGroundedRequestBlock } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";

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
    const ids = new Set([...prepared.candidateSources.map((card) => card.id),
      ...original.requiredProjectIds, ...original.requiredSubjectIds]);
    assert.deepEqual(prepared.groundedRequest.targets.map((target) => target.id),
      context.routes.targets.filter((target) => ids.has(target.id)).map((target) => target.id), message);
    assert.ok(prepared.groundedRequest.targets.every((target) => target.aliases.length === 0));
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
    assert.ok(prepared.candidateSources.every((card) => Buffer.byteLength(card.evidence) <= 3000));
  }
});

test("registered definitions and contextual glossary requests retain only required canonical terms and aliases", () => {
  for (const message of ["P95가 뭐야?", "P95를 어떻게 줄였어?"]) {
    const prepared = prepare(message);
    const canonical = full.terms.find((term) => term.term === "P95");
    assert.deepEqual(prepared.groundedRequest.terms, [canonical]);
    assert.ok(prepared.candidateSources.length > 0);
    if (message.includes("뭐야")) {
      const result = acceptProposal({ intent: "define_term", confidence: 1, term: "P95" }, context, prepared, message);
      assert.equal(result.accepted, true);
    }
  }
});

test("navigation, ambiguity and unconstrained unknown requests preserve full registry coverage", () => {
  for (const message of ["CateQuest로 이동", "소개로 이동", "요약해줘", "NebulaWorks 프로젝트 전체 요약해줘.", "어떻게 개선했어?"]) {
    const prepared = prepare(message);
    assert.deepEqual(prepared.groundedRequest.targets, full.targets, message);
    assert.deepEqual(prepared.groundedRequest.terms, full.terms, message);
  }
});

test("project metadata is not source authorization and projection never broadens output scope", () => {
  const message = "CateQuest N+1 해결 요약해줘";
  const prepared = prepare(message);
  assert.deepEqual(prepared.candidateSources.map((card) => card.id), ["project-catequest-n1"]);
  assert.ok(prepared.groundedRequest.targets.some((target) => target.id === "project-catequest"));
  for (const sourceId of ["project-catequest", "project-bookking"]) {
    const proposal = { intent: "answer_portfolio", confidence: 1, answer: "CateQuest N+1 해결", sourceIds: [sourceId] };
    assert.equal(acceptProposal(proposal, context, prepared, message).accepted, false);
  }
  assert.equal(context.routes.targets.length, full.targets.length);
  assert.equal(context.glossary.terms.length, full.terms.length);
});
