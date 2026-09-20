import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { quantitiesSupported } from "./answer-obligations.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "CateQuest와 Bookking의 성능 개선을 비교해줘";
const prepared = prepareGroundedRequest(message, { ...context, currentTargetId: "project-makertion-db" });
const full = "CateQuest는 DTO Projection과 JPQL 조인으로 DB 접근을 54회에서 1회로 줄였습니다. Bookking은 HTTPS 응답 지연을 200ms에서 30ms로 줄였습니다.";
function inspect(answer, endpoint) {
  const candidate = { intent: "answer_portfolio", confidence: 0.99, answer,
    sourceIds: ["project-catequest-n1", "project-bookking-https"] };
  const result = inspectModelCompletion({ model: "numeric-regression-fixture", choices: [{
    finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) }
  }] }, endpoint);
  assert.equal(result.tag, "success");
  return { ...result, metadata: { ...result.metadata, endpoint } };
}

// All seven failures from the retained independent suite, now product regressions.
for (const [name, answer] of [["plus-prefixed-fabrication", full.replace("30ms", "+999ms")],
  ["negative-latency", full.replace("30ms", "-30ms")],
  ["korean-adjacent-fabrication", full.replace("200ms에서 30ms", "응답시간999ms")]]) {
  for (const endpoint of ["lfm", "qwen"]) test(`REGRESSION:${name}/${endpoint}`, () => {
    const before = JSON.stringify(prepared);
    assert.ok(Object.isFrozen(prepared));
    assert.strictEqual(prepared.candidateSources, prepared.groundedRequest.candidateSources);
    assert.deepEqual(prepared.candidateSources, JSON.parse(prepared.groundedRequestBlock).candidateSources);
    assert.deepEqual(acceptTransportProposal(inspect(answer, endpoint), context, prepared, message),
      { accepted: false, reason: "quantity_unsupported" });
    assert.equal(JSON.stringify(prepared), before);
  });
}
test("REGRESSION: quantity primitive does not silently omit signed or adjacent numerals", () => {
  assert.deepEqual(["999ms", "+999ms", "-30ms", "응답시간999ms"].map((claim) =>
    quantitiesSupported(claim, "200ms에서 30ms")), [false, false, false, false]);
});

test("explicit signs must be present in evidence, never stripped or converted", () => {
  for (const [claim, evidence, expected] of [
    ["+30ms", "+30ms", true], ["-30ms", "-30ms", true], ["−30ms", "−30ms", true],
    ["+ 30 MS", "+30ms", true], ["- 30ms", "-30ms", true],
    ["+30ms", "30ms", false], ["-30ms", "30ms", false], ["30ms", "-30ms", false],
    ["+30ms", "-30ms", false], ["−30ms", "30ms", false], ["−30ms", "-30ms", false],
    ["-0.30ms", "+0.30ms", false], ["+0.30ms", "+0.30ms", true],
    ["+999ms", "+30ms", false], ["+6.4%", "약 +6.4% 처리량 증가", true]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("Korean quantity prefixes and suffixes cannot hide positive or negative numerals", () => {
  for (const [claim, evidence, expected] of [
    ["응답시간30ms로", "응답시간 30ms", true], ["응답시간999ms로", "30ms", false],
    ["응답시간-30ms로", "30ms", false], ["응답시간+30ms로", "+30ms", true],
    ["접근54회에서1회로", "54회에서 1회로", true], ["접근999회에서1회로", "54회에서 1회", false],
    ["최대+0.30ms까지", "+0.30ms", true], ["개선율−6.4%", "6.4%", false]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("decimal, percent and rate boundaries preserve whole quantities without conversion", () => {
  for (const [claim, evidence, expected] of [
    [".30ms", ".30ms", true], [".30ms", "0.30ms", false], ["30ms", "130ms", false],
    ["-30.5ms", "30.5ms", false], ["−30.5%", "−30.5%", true],
    ["30٪", "30%", false], ["30٪", "30٪", true], ["30‰", "30%", false],
    ["+362.80/s", "+362.80 / s", true], ["−362.80/s", "362.80/s", false],
    ["362.80/s", "362.80/min", false], ["30ms/s", "30ms/min", false],
    ["3,648회", "3,648회", true], ["3648회", "3,648회", false]
  ]) assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
});

test("malformed numeric tokens fail closed rather than disappearing or matching substrings", () => {
  for (const claim of ["++30ms", "--30ms", "+-30ms", "−-30ms", "30..5ms", "30,00ms", "30%%", "30/s/min", "1e3ms",
    "30 ms%%", "30 / s / min", "30 /"]) {
    assert.equal(quantitiesSupported(claim, `${claim} 30ms 5ms 3ms 1회`), false, claim);
  }
});

test("spacing cannot drop an unsupported unit or silently convert unit names", () => {
  for (const [claim, evidence, expected] of [["30 milliseconds", "30ms", false],
    ["30 milliseconds", "30milliseconds", true], ["30 msfoo", "30ms", false],
    ["30 s", "30ms", false], ["30 ms / min", "30ms/min", true]]) {
    assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
  }
});

test("REGRESSION: issue 12 accepts an evidenced fraction with a Korean particle", () => {
  // Synthetic minimal fixture, not a retained model answer or portfolio excerpt.
  assert.equal(quantitiesSupported("비율 1/20로 감소", "비율 1/20 수준"), true);
});

test("issue 12 fraction controls reject changed or absent numeric evidence", () => {
  for (const claim of ["1/21로", "2/20로", "+1/20로", "-1/20로", "1/20ms", "1/20/3로"]) {
    assert.equal(quantitiesSupported(claim, "비율 1/20 수준"), false, claim);
  }
  assert.equal(quantitiesSupported("1/20로", "비율 1 또는 20"), false);
});

test("literal fractions preserve numerator, denominator, signs and leading zeros", () => {
  for (const value of ["1/20", "0/20", "+1/20", "-1/20", "−1/20", "01/020", "1/00020"]) {
    assert.equal(quantitiesSupported(value, value), true, value);
  }
  for (const [claim, evidence] of [["+ 1 / 20로", "+1/20"], ["− 01 / 020", "−01/020"],
    ["비율１／２０로", "1/20"], ["1/20에서", "1 / 20"], ["(1/20)", "[1/20]"]]) {
    assert.equal(quantitiesSupported(claim, evidence), true, `${claim} / ${evidence}`);
  }
  for (const [claim, evidence] of [["1/20", "2/40"], ["1/20", "0.05"], ["1/20", "01/020"],
    ["1/20", "+1/20"], ["-1/20", "−1/20"], ["1", "1/20"], ["20", "1/20"],
    ["1/20", "1"], ["1/20", "1 20"], ["1/20", "11/20"], ["1/20", "1/200"]]) {
    assert.equal(quantitiesSupported(claim, evidence), false, `${claim} / ${evidence}`);
  }
});

test("malformed fraction atoms cannot disappear or lend supported prefixes", () => {
  for (const value of ["1/20.5", "1/20/3", "1//20", "1/-20", "1/+20", "1/−20", "1/0", "1/000",
    "1.5/20", "1,000/20", "1/20,5", "1/20..", "1/20,,", "1 / / 20", "1 / - 20", "++1/20",
    "1/20٣", "١/20", "1/٢٠", "1⁄20", "1∕20", "½", "1/20/", "1/20%%", "1/20/s/min"]) {
    assert.equal(quantitiesSupported(value, value), false, `malformed self: ${value}`);
    assert.equal(quantitiesSupported(value, "1 20 3 5 0 000 1/20 1/20ms"), false, `fragment trap: ${value}`);
    assert.equal(quantitiesSupported("1/20", value), false, `prefix trap: ${value}`);
  }
});

test("fraction units stay distinct and retain asymmetric unitless matching", () => {
  for (const [claim, evidence, expected] of [["1/20ms", "1/20ms", true], ["1 / 20 MS", "1/20ms", true],
    ["1/20분으로", "1/20분", true], ["1/20/s", "1/20/s", true], ["1/20ms/s", "1/20ms/s", true],
    ["1/20", "1/20ms", true], ["1/20ms", "1/20", false], ["1/20초", "1/20분", false],
    ["1/20ms", "1/20s", false], ["1/20/s", "1/20/min", false], ["1/20%", "1/20", false],
    ["1/20%", "1/20%", true], ["1/20milliseconds", "1/20ms", false]]) {
    assert.equal(quantitiesSupported(claim, evidence), expected, `${claim} / ${evidence}`);
  }
});

test("fraction boundaries preserve subsequent quantities and sentence delimiters", () => {
  for (const claim of ["1/20로 31% 1분", "1/20로31% 1분", "1/20로1분", "1/20. 31% 1분", "1/20, 31% 1분"]) {
    assert.equal(quantitiesSupported(claim, "1/20 수준 31% 1분"), true, claim);
    assert.equal(quantitiesSupported(claim, "1/20 수준"), false, claim);
  }
  assert.equal(quantitiesSupported("1/20로 32% 1분", "1/20 수준 31% 1분"), false);
  assert.equal(quantitiesSupported("1/20로 31% 2분", "1/20 수준 31% 1분"), false);
  assert.equal(quantitiesSupported("1/20로31%1분", "1/20 수준 31% 1분"), false, "existing malformed percent atom stays invalid");
});

const malformedFractionBoundaries = ["1/20⁄", "1/20∕s", "/1/20", "⁄1/20", "∕1/20", "/ 1 / 20",
  "⁄ / 1/20", "/⁄∕1/20", "+ /1/20", "/ - 1/20", "1/20 ⁄", "1/20 ∕ s", "1/20⁄/s",
  "1/20 / ⁄", "1/20⁄ ∕s", "1/20∕/⁄", "1/20ms⁄", "1/20ms∕s", "1/20분⁄", "1/20로⁄",
  "1/20로 ⁄ s", "1/20분 /", "1/20 / / s"];

for (const base of ["1/20", "1/20ms", "1/20/s", "1/20%", "1/20분"]) {
  for (const tail of ["٣", "로ms", "로%", "로٣", "로⁄", "로∕s", ", ⁄", ". /", ", . ⁄", ". , /3", "로/3"]) {
    const malformed = base + tail;
    test(`whole fraction ownership rejects ${malformed} in both directions and self`, () => {
      for (const [claim, evidence] of [[malformed, base], [base, malformed], [malformed, malformed],
        ["1/20", malformed], [malformed, `${base} 1 20 3`]]) {
        assert.equal(quantitiesSupported(claim, evidence), false, `${claim} / ${evidence}`);
      }
      assert.equal(quantitiesSupported(base, `${malformed}; ${base}`), true, "separate valid evidence survives");
    });
  }
}

test("whole fraction units reject mixed scripts and percent compositions", () => {
  for (const value of ["1/20%분", "1/20분%", "1/20ms분", "1/20분ms", "1/20msλ", "1/20로ms"]) {
    assert.equal(quantitiesSupported(value, value), false, value);
    assert.equal(quantitiesSupported("1/20", value), false, value);
  }
  for (const [claim, evidence] of [["1/20%분", "1/20%"], ["1/20분%", "1/20분"]]) {
    assert.equal(quantitiesSupported(claim, evidence), false);
    assert.equal(quantitiesSupported(evidence, claim), false);
  }
  for (const value of ["1/20ms로", "1/20%로", "1/20수준", "1/20분으로", "1/20ms/s로"]) {
    assert.equal(quantitiesSupported(value, value), true, value);
    assert.equal(quantitiesSupported("1/20", value), true, value);
  }
  for (const value of ["1/20, prose", "1/20. prose", "1/20ms, prose", "1/20ms. prose"]) {
    assert.equal(quantitiesSupported("1/20", value), true, value);
  }
});

test("whole fraction ownership retains malformed signs and unterminated interiors", () => {
  for (const value of ["++1/20ms로", "–1/20", "1/−20ms", "/ - 1/20ms", "١/20ms", "1/٢٠ms",
    "1/", "1 / /", "1/20/", "1/20로/", "1/20ms/٣", "1/20로٣/40"]) {
    assert.equal(quantitiesSupported(value, `${value}; 1 20 40 1/20`), false, value);
    for (const claim of ["1", "20", "40", "1/20"]) {
      assert.equal(quantitiesSupported(claim, value), false, `${claim} from ${value}`);
    }
  }
});

test("fraction slash boundaries cannot hide malformed claims", () => {
  for (const value of malformedFractionBoundaries) {
    assert.equal(quantitiesSupported(value, "1/20 1/20ms 1/20분 -1/20 +1/20 1 20"), false, value);
  }
});

test("fraction slash boundaries cannot lend an evidence prefix", () => {
  for (const value of malformedFractionBoundaries) {
    assert.equal(quantitiesSupported("1/20", value), false, value);
  }
});

test("fraction slash boundary malformations fail even against themselves", () => {
  for (const value of malformedFractionBoundaries) {
    assert.equal(quantitiesSupported(value, value), false, value);
  }
  for (const value of ["1/20/s", "1 / 20 / s", "1/20ms/s", "30/s", "30 ms / s"]) {
    assert.equal(quantitiesSupported(value, value), true, `ASCII rate: ${value}`);
  }
});

for (const endpoint of ["lfm", "qwen"]) test(`actual bounded positive signed rate improvement/${endpoint}`, () => {
  const request = "현재 프로젝트에서 캐싱을 어떻게 개선했어?";
  const preparation = prepareGroundedRequest(request, { ...context, currentTargetId: "project-makertion-db" });
  const sourceId = "project-makertion-cache";
  assert.ok(preparation.candidateSources.find((card) => card.id === sourceId).evidence.includes("+6.4%"));
  const answer = "Main 홈페이지 캐싱은 RPS 초당 처리량을 약 +6.4% 개선했습니다.";
  const outcome = inspect(answer, endpoint);
  outcome.candidate.sourceIds = [sourceId];
  assert.equal(acceptTransportProposal(outcome, context, preparation, request).accepted, true);
  outcome.candidate.answer = answer.replace("+6.4%", "-6.4%");
  assert.equal(acceptTransportProposal(outcome, context, preparation, request).accepted, false);
});

test("identifier exclusions are explicit and cannot conceal attached quantity extensions", () => {
  for (const claim of ["P95", "P95는", "N+1", "N+1을", "1+N 쿼리"]) {
    assert.equal(quantitiesSupported(claim, ""), true, claim);
  }
  for (const claim of ["P95 +999ms", "N+1 응답시간999ms", "N+1999ms", "P95.999ms", "N+1-999ms"]) {
    assert.equal(quantitiesSupported(claim, "P95 N+1 30ms"), false, claim);
  }
});

test("Qwen adapter rejects invalid as well as positive reasoning accounting", () => {
  const valid = inspect(full, "qwen");
  for (const reasoningAccounting of ["invalid", "positive"]) {
    assert.deepEqual(acceptTransportProposal({ ...valid, metadata: { ...valid.metadata, reasoningAccounting } },
      context, prepared, message), { accepted: false, reason: "transport_invalid" });
  }
});
