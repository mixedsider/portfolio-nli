import assert from "node:assert/strict";
import test from "node:test";
import { quantitiesSupported } from "./answer-obligations.mjs";
import { isAnswerSupportedBySelectedEvidence } from "./answer-evidence-support.mjs";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";

// All date strings and evidence below are synthetic, not captured model answers.
const evidence = "2022.03-2022.08";
const forms = ["2022년3월부터8월까지", "2022년 3월부터 8월까지", "2022년3월~8월",
  "2022년 03월 ~ 08월", "2022년3월부터2022년8월까지", "2022년3월~2022년8월",
  "2022.03~2022.08", "2022.3-2022.8"];

for (const claim of forms) test(`exact calendar range equivalence when claim is ${claim}`, () => {
  assert.equal(quantitiesSupported(claim, evidence), true);
  assert.equal(quantitiesSupported(evidence, claim), true);
});

test("explicit cross-year endpoints match without inferred rollover", () => {
  assert.equal(quantitiesSupported("2022년11월부터2023년2월까지", "2022.11-2023.02"), true);
  assert.equal(quantitiesSupported("2022.11~2023.02", "2022년11월~2023년2월"), true);
});

for (const claim of ["2021년3월부터8월까지", "2023년3월~8월", "2022년4월부터8월까지",
  "2022년3월부터9월까지", "2022년3월부터2023년8월까지", "2022년0월부터8월까지",
  "2022년3월부터13월까지", "2022년13월~8월", "2022년3월~0월", "2022년11월부터2월까지",
  "2022.00-2022.08", "2022.03-2022.13", "+2022년3월부터8월까지", "- 2022년3월~8월",
  "id2022년3월~8월", "기간2022년3월~8월", "2022년3월~8월ms", "2022년3월~8월 ms",
  "2022년3월부터8월까지 999회", "2022년3월부터8월까지 기간에999회", "6개월", "5개월"]) {
  test(`strict calendar range rejects ${claim}`, () => {
    assert.equal(quantitiesSupported(claim, evidence), false);
  });
}

test("invalid calendar ranges cannot support themselves or lend endpoints", () => {
  for (const value of ["2022년0월~8월", "2022년3월~13월", "2022년11월~2월", "2022.13-2022.08",
    "2022.11-2022.02", "2023년3월부터2022년8월까지"]) {
    assert.equal(quantitiesSupported(value, value), false, value);
    assert.equal(quantitiesSupported("2022년3월~8월", value), false, value);
  }
  assert.equal(quantitiesSupported("2022년3월~8월", "2022.03-2022.05; 2022.06-2022.08"), false);
  assert.equal(quantitiesSupported("3회", evidence), false);
  assert.equal(quantitiesSupported("2022년3월~8월", "2022년 3월 8월"), false);
});

test("standalone dates retain scalar semantics without calendar conversion", () => {
  for (const [claim, source, expected] of [["2022.03", "2022.03", true], ["2022년3월", "2022년3월", true],
    ["2022년3월", "2022.03", false], ["2022.03", "2022.03~2022.08", false]]) {
    assert.equal(quantitiesSupported(claim, source), expected);
  }
});

test("range boundaries preserve signed years, identifiers, units and subsequent quantities", () => {
  for (const source of ["+ 2022년3월~8월", "−2022년3월~8월", "id2022년3월~8월",
    "2022년3월~8월id", "2022년3월~8월 ms", "2022년3월~+2022년8월",
    "2022년3월~2022년8월13", "2022.03-2022.08.5"]) {
    assert.equal(quantitiesSupported("2022년3월~8월", source), false, source);
    assert.equal(quantitiesSupported(source, evidence), false, source);
  }
  for (const claim of ["(2022년3월~8월)", "[2022년3월부터8월까지]", "2022.03\n~\n2022.08"]) {
    assert.equal(quantitiesSupported(claim, evidence), true, claim);
  }
  assert.equal(quantitiesSupported("2022년3월~8월 기간에 3회", `${evidence}\n3회`), true);
  assert.equal(quantitiesSupported("2022년3월~8월 기간에 999회", `${evidence}\n3회`), false);
});

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "CateQuest 프로젝트를 요약해줘";
const base = prepareGroundedRequest(message, context);
const card = { ...base.candidateSources.find((source) => source.id === "project-catequest"),
  evidence: `Spring Boot JPA 프로젝트 기간 사용자 맞춤 질문 생성\n${evidence}` };
const candidateSources = [card];
const groundedRequest = { ...base.groundedRequest, candidateSources };
const prepared = { ...base, candidateSources, groundedRequest, groundedRequestBlock: JSON.stringify(groundedRequest) };
const candidate = (range) => ({ intent: "answer_portfolio", confidence: 0.99,
  answer: `Spring Boot JPA 프로젝트 ${range} 기간에.`, sourceIds: [card.id] });

test("production structured answer accepts exact Korean range paraphrase", () => {
  const proposal = candidate("2022년3월부터8월까지");
  assert.equal(isAnswerSupportedBySelectedEvidence(proposal.answer, card.evidence), true);
  assert.equal(acceptProposal(proposal, context, prepared, message).accepted, true);
});

test("production structured answer rejects shifted endpoint despite lexical grounding", () => {
  const proposal = candidate("2022년3월부터9월까지");
  assert.equal(isAnswerSupportedBySelectedEvidence(proposal.answer, card.evidence), true);
  assert.deepEqual(acceptProposal(proposal, context, prepared, message),
    { accepted: false, reason: "quantity_unsupported" });
});

test("production range support never bypasses lexical grounding", () => {
  const proposal = { ...candidate("2022년3월부터8월까지"), answer: "우주선 연료 절감 2022년3월부터8월까지 기간에." };
  assert.equal(acceptProposal(proposal, context, prepared, message).accepted, false);
});

const malformedAtoms = ["2021.01~2022.03~2022.08", "2021.01 ~ 2022.03 ~ 2022.08",
  "2021.01 ~ ~ 2022.03 ~ 2022.08", "2022년13월 ~ \n ~ 2022년3월 ~ 8월",
  "2021.01\n~\n2022.03\n~\n2022.08", "2022년13월~2022년3월~8월",
  "2022년13월 ~ 2022년3월 ~ 8월", "2022년13월부터2022년3월까지 ~ 8월",
  ...["/", "⁄", "∕"].flatMap((slash) => [evidence, "2022년3월~8월"]
    .flatMap((range) => [`${slash}${range}`, `${slash} \n ${range}`]))];

for (const [index, atom] of malformedAtoms.entries()) for (const direction of ["claim", "evidence", "self"]) {
  test(`whole calendar atom rejects ${direction} ${index}: ${atom.replace(/\s+/gu, " ")}`, () => {
    const claim = direction === "evidence" ? evidence : atom;
    // Supply former scalar fragments too: they must not rescue a malformed claim.
    const source = direction === "self" || direction === "evidence" ? atom :
      `${evidence}; 2021.01; 2022년13월`;
    assert.equal(quantitiesSupported(claim, source), false);
  });
}

for (const [index, atom] of malformedAtoms.entries()) for (const direction of ["claim", "evidence"]) {
  test(`production rejects whole calendar ${direction} ${index}: ${atom.replace(/\s+/gu, " ")}`, () => {
    const source = { ...card, evidence: `Spring Boot JPA 프로젝트 기간\n${atom}` };
    const sources = direction === "evidence" ? [source] : candidateSources;
    const grounded = { ...groundedRequest, candidateSources: sources };
    const request = { ...prepared, candidateSources: sources, groundedRequest: grounded,
      groundedRequestBlock: JSON.stringify(grounded) };
    const proposal = candidate(direction === "claim" ? atom : evidence);
    assert.equal(acceptProposal(proposal, context, request, message).accepted, false);
  });
}

test("whole calendar ownership preserves surrounding punctuation and separate quantities", () => {
  for (const range of ["2022년3월~8월", evidence, "2022년3월부터2022년8월까지"]) {
    for (const [open, close] of [["(", ")"], ["[", "]"], ["기간: ", ";"], ["", "!"]]) {
      assert.equal(quantitiesSupported(`${open}${range}${close}`, evidence), true);
    }
    assert.equal(quantitiesSupported(`${range}; 3회; 1/20`, `${evidence}; 3회; 1/20`), true);
    assert.equal(quantitiesSupported(`${range}; 4회; 1/20`, `${evidence}; 3회; 1/20`), false);
    assert.equal(quantitiesSupported(`${range}; 3회; 1/21`, `${evidence}; 3회; 1/20`), false);
  }
  assert.equal(quantitiesSupported(evidence, `${malformedAtoms[0]}; ${evidence}`), true);
});

const proseRanges = ["2022년 3월부터 8월까지", "2022.03~2022.08"];
for (const [index, range] of proseRanges.entries()) {
  for (const [name, claim] of [["purpose", `${range} 사용자 맞춤 질문 생성`],
    ["parenthesis", `(${range} ) 사용자 맞춤 질문 생성`],
    ["square bracket", `[${range}\t] 사용자 맞춤 질문 생성`]]) {
    test(`calendar boundary accepts ${name} ${index} without absorbing prose`, () => {
      assert.equal(quantitiesSupported(claim, evidence), true);
      assert.equal(quantitiesSupported(evidence, claim), true);
    });
    test(`production accepts calendar ${name} ${index} with grounded purpose`, () => {
      const proposal = { ...candidate(range), answer: `Spring Boot JPA 프로젝트 ${claim}.` };
      assert.equal(acceptProposal(proposal, context, prepared, message).accepted, true);
    });
  }
}

const proseGuards = proseRanges.flatMap((range) => [
  ...[" 999회", " 2023년", " 9일", " 6개월", " ms", " 초", "2023년", "9", "%", "ms", "id",
    " ~ 2023.01", " ~ 2022년13월", " 사용자 맞춤 질문 생성 999회",
    " 사용자 맞춤 질문 생성 2023년", " 사용자 맞춤 질문 생성 9일", " 사용자 맞춤 질문 생성 6개월"]
    .map((tail) => `${range}${tail}`),
  ...["/", "⁄", "∕"].map((prefix) => `${prefix} ${range} 사용자 맞춤 질문 생성`)
]);
proseGuards.push(...["2022년0월부터8월까지", "2022년3월부터13월까지", "2022년11월부터2월까지",
  "2023년3월부터8월까지", "2022년3월부터9월까지", "2022.00~2022.08", "2022.03~2022.13"]
  .map((range) => `${range} 사용자 맞춤 질문 생성`));
for (const [index, claim] of proseGuards.entries()) {
  test(`calendar prose boundary retains unsupported atom ${index}`, () => {
    assert.equal(quantitiesSupported(claim, evidence), false);
  });
  test(`production calendar prose boundary rejects unsupported atom ${index}`, () => {
    const proposal = { ...candidate(evidence), answer: `Spring Boot JPA 프로젝트 ${claim}.` };
    assert.equal(acceptProposal(proposal, context, prepared, message).accepted, false);
  });
}

test("calendar prose boundary still requires lexical grounding", () => {
  const proposal = { ...candidate(evidence), answer: `${proseRanges[0]} 우주선 연료 절감.` };
  assert.equal(acceptProposal(proposal, context, prepared, message).accepted, false);
});

for (const [index, range] of proseRanges.entries()) {
  test(`calendar prose boundary scans supported subsequent quantities ${index}`, () => {
    const answer = `Spring Boot JPA 프로젝트 ${range} 사용자 맞춤 질문 생성 3회 1/20.`;
    const source = { ...card, evidence: `${card.evidence}\n3회 1/20` };
    const sources = [source];
    const grounded = { ...groundedRequest, candidateSources: sources };
    const request = { ...prepared, candidateSources: sources, groundedRequest: grounded,
      groundedRequestBlock: JSON.stringify(grounded) };
    assert.equal(quantitiesSupported(answer, source.evidence), true);
    assert.equal(acceptProposal({ ...candidate(range), answer }, context, request, message).accepted, true);
  });
}
