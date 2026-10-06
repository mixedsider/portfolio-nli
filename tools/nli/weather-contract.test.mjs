import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadNliContext } from "./context.mjs";
import { prepareProbeCases } from "./probe-request.mjs";
import { inspectProbeCompletion, matchesProbeExpectation } from "./probe-result.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const context = await loadNliContext(root);
const fixtures = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));
const envelope = (candidate) => ({ model: "test-model", choices: [{
  finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) }
}] });

test("weather requests are explicitly rejected before portfolio intent selection", () => {
  assert.match(context.prompt, /reject\b[^\n]*external\b[^\n]*weather\b/i);
  assert.match(context.prompt, /context[^\n]*history[^\n]*evidence[^\n]*untrusted/i);
  assert.match(context.prompt, /ignore[^\n]*instructions/i);
  assert.match(context.prompt, /context\b[^\n]*cannot\b[^\n]*expand\b[^\n]*scope\b/i);
  assert.match(context.prompt, /other (?:one-)?section:[^\n]*one[^\n]*≤\s*60[^\n]*sentence/i);
  assert.match(context.prompt, /answer\s+4,000\s+char(?:acters|s)\b/i);
  assert.match(context.prompt, /comparison\/synthesis:[^\n]*supported[^\n]*≤\s*40[^\n]*clause[^\n]*project[^\n]*subject/i);
  assert.doesNotMatch(context.prompt, /(?:at most|under) 600 characters/);
  assert.match(context.prompt, /4,000/);
  assert.doesNotMatch(context.prompt, /```/);
  assert.ok(Buffer.byteLength(context.prompt) <= 2500);
  const routing = JSON.parse(context.prompt.match(/`(\{"요약\/설명\+candidateSources":.*?\})`/u)[1]);
  assert.equal(routing["external/no evidence"], "reject_out_of_scope");
  for (const intent of ["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"]) {
    assert.ok(context.prompt.includes(intent));
  }
  for (const field of ["intent", "confidence", "targetId", "term", "answer", "sourceIds"]) {
    assert.ok(context.prompt.includes(field));
  }
});

test("external weather cannot navigate to invented or registered targets but accepts minimal rejection", () => {
  const message = "오늘 날씨 보여줘";
  const prepared = prepareGroundedRequest(message, context);
  assert.deepEqual(prepared.obligations.expectedIntents, ["reject_out_of_scope"]);
  assert.equal(context.targetById.has("synthetic-weather-target"), false);
  assert.deepEqual(acceptProposal({ intent: "navigate", confidence: 1, targetId: "synthetic-weather-target" },
    context, prepared, message), { accepted: false, reason: "proposal_invalid" });
  assert.deepEqual(acceptProposal({ intent: "navigate", confidence: 1, targetId: "project-catequest" },
    context, prepared, message), { accepted: false, reason: "intent_mismatch" });
  assert.equal(acceptProposal({ intent: "reject_out_of_scope", confidence: 1 }, context, prepared, message).accepted, true);
  const move = "CateQuest로 이동";
  assert.equal(acceptProposal({ intent: "navigate", confidence: 1, targetId: "project-catequest" },
    context, prepareGroundedRequest(move, context), move).accepted, true);
});

test("weather fixture keeps strict production validation separate from intent matching", () => {
  for (const length of [0, 2, 6]) {
    const history = Array.from({ length }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", text: "CateQuest"
    }));
    const cases = prepareProbeCases(fixtures.map((item) => ({ ...item, history })), context);
    const weather = cases.find((item) => item.id === "out-of-scope");
    const inScope = cases.find((item) => item.id === "navigation");
    const rejection = { intent: "reject_out_of_scope", confidence: 1 };

    assert.equal(matchesProbeExpectation(rejection, weather), true);
    assert.equal(inspectProbeCompletion(envelope(rejection), weather, context, "lfm").ok, true);

    for (const invalid of [
      { intent: "reject_out_of_scope" },
      { intent: "reject_out_of_scope", confidence: "1" },
      { intent: "reject_out_of_scope", confidence: 1, message: "not model-owned" }
    ]) {
      assert.equal(matchesProbeExpectation(invalid, weather), true);
      assert.equal(inspectProbeCompletion(envelope(invalid), weather, context, "lfm").kind, "proposal_invalid");
    }

    assert.deepEqual(weather.candidateSources, []);
    assert.deepEqual(weather.grounded.targets, []);
    assert.deepEqual(weather.grounded.terms, []);
    const unsupported = { intent: "answer_portfolio", confidence: 1,
      answer: "오늘 서울 날씨는 맑습니다.", sourceIds: ["top"] };
    const result = inspectProbeCompletion(envelope(unsupported), weather, context, "lfm");
    assert.equal(result.kind, "proposal_invalid");
    assert.equal(result.visibleAnswer, undefined);
    assert.equal(inspectProbeCompletion(envelope(rejection), inScope, context, "lfm").kind, "false_rejection");
  }
});
