import assert from "node:assert/strict";
import test from "node:test";
import { isAnswerSupportedBySelectedEvidence as supported } from "./answer-evidence-support.mjs";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";

// Synthetic five-token claim: nine tokenized terms, three direct anchors.
const claim = "백엔드 구성 관련 서비스 운영합니다";
const evidence = "Backend 구성 서비스 운영 업무";

test("supports the synthetic nine-term category translation without rewriting the claim", () => {
  assert.equal(supported(claim, evidence), true);
});

test("supports the reverse synthetic nine-term translation", () => {
  assert.equal(supported("Backend 구성 관련 서비스 운영합니다", "백엔드 구성 서비스 운영 업무"), true);
});

for (const [answer, source] of [
  ["백엔드", "Backend"], ["BACKEND", "백엔드"],
  ["백엔드는", "backend"], ["backend", "백엔드에서"],
  ["  백엔드  는  ", "  BACKEND  "], ["Backend", "(백엔드),"],
  ["백엔드에서", "[Backend];"], ["Backend는", "백엔드"]
]) {
  test(`supports exact category tokens with case, spacing, punctuation or particles: ${answer}`, () => {
    assert.equal(supported(`${answer} 서비스`, `${source} 서비스`), true);
  });
}

for (const [answer, source] of [
  ["백엔드", "mybackend"], ["백엔드", "backendish"],
  ["backend", "초백엔드"], ["backend", "백엔드기술"],
  ["백엔드기술", "backend"], ["backendish", "백엔드"],
  ["백엔드", "back end"], ["백엔드구성", "Backend 구성"],
  ["백엔드", "BackendX"], ["백엔드", "Backend_implementation"]
]) {
  test(`rejects unapproved category substrings or adjacent-token joins: ${answer}/${source}`, () => {
    assert.equal(supported(`${answer} 서비스`, `${source} 서비스`), false);
  });
}

for (const answer of [
  `${claim} Kubernetes`,
  `${claim} Kubernetes는`,
  "백엔드 구성 관련 서비스 항상 운영합니다",
  "백엔드 구성 관련 서비스 운영하지 않습니다",
  "백엔드 구성 관련 서비스 전문적으로 운영합니다",
  "백엔드 구성 관련 서비스 전문가입니다"
]) {
  test(`does not rescue an unsupported synthetic technical or stronger claim: ${answer}`, () => {
    assert.equal(supported(answer, `${evidence} Redis`), false);
  });
}

test("preserves baseline accepted claims even where legacy thresholds are permissive", () => {
  assert.equal(supported("Redis Valkey 관련 서비스 운영합니다 Kubernetes", "Redis Valkey 서비스"), true);
  assert.equal(supported("백엔드 구성 관련 Redis 서비스 운영합니다 Kubernetes", `${evidence} Redis`), true);
});

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "CateQuest 프로젝트를 요약해줘";
const original = prepareGroundedRequest(message, context);
const prepared = { ...original, candidateSources: original.candidateSources.map((card) => ({
  ...card, evidence: `${card.evidence}\n${evidence}`
})) };
const proposal = (answer) => ({ intent: "answer_portfolio", confidence: 1,
  answer, sourceIds: ["project-catequest"] });

test("full acceptance preserves the synthetic translated assertion and selected sources", () => {
  const candidate = proposal(`CateQuest는 ${claim}.`);
  const result = acceptProposal(candidate, context, prepared, message);
  assert.equal(result.accepted, true);
  assert.equal(result.response.answer, candidate.answer);
  assert.deepEqual(result.response.sources.map((source) => source.id), candidate.sourceIds);
});

test("full acceptance preserves a reverse synthetic translation against Korean-only bounded evidence", () => {
  const koreanPrepared = { ...original, candidateSources: original.candidateSources.map((card) => ({
    ...card, evidence: "CateQuest 백엔드 구성 서비스 운영 업무"
  })) };
  const candidate = proposal("CateQuest는 Backend 구성 관련 서비스 운영합니다.");
  const result = acceptProposal(candidate, context, koreanPrepared, message);
  assert.equal(result.accepted, true);
  assert.equal(result.response.answer, candidate.answer);
  assert.deepEqual(result.response.sources.map((source) => source.id), candidate.sourceIds);
});

for (const answer of [
  `CateQuest는 ${claim} Kubernetes.`,
  `CateQuest는 ${claim} Kubernetes는.`,
  "CateQuest는 백엔드 구성 관련 Redis 서비스 운영합니다 Kubernetes.",
  `Bookking은 ${claim}.`,
  `CateQuest는 ${claim} 999ms.`,
  "CateQuest는 백엔드 구성 관련 서비스 운영하지 않습니다.",
  "CateQuest는 백엔드 구성 관련 서비스 항상 운영합니다.",
  "CateQuest는 백엔드 구성 관련 서비스 전문가입니다."
]) {
  test(`full acceptance rejects a synthetic changed fact beside the category alias: ${answer}`, () => {
    assert.equal(acceptProposal(proposal(answer), context, prepared, message).accepted, false);
  });
}
