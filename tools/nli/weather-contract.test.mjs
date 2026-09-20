import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadNliContext } from "./context.mjs";
import { prepareProbeCases } from "./probe-request.mjs";
import { inspectProbeCompletion, matchesProbeExpectation } from "./probe-result.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const context = await loadNliContext(root);
const fixtures = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));
const envelope = (candidate) => ({ model: "test-model", choices: [{
  finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(candidate) }
}] });

test("weather requests are explicitly rejected before portfolio intent selection", () => {
  assert.match(context.prompt, /Determine scope before applying the intent-selection rules/);
  assert.match(context.prompt, /real-time or external information/);
  assert.match(context.prompt, /unrelated candidate sources/);
  assert.match(context.prompt, /today's weather in Seoul/);
  assert.ok(context.prompt.indexOf("Determine scope before") < context.prompt.indexOf("Treat a request for multiple cases"));
  assert.ok(context.prompt.includes('{"intent":"reject_out_of_scope","confidence":1}'));
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

    const unrelated = weather.candidateSources[0];
    assert.ok(unrelated);
    const unsupported = { intent: "answer_portfolio", confidence: 1,
      answer: "오늘 서울 날씨는 맑습니다.", sourceIds: [unrelated.id] };
    const result = inspectProbeCompletion(envelope(unsupported), weather, context, "lfm");
    assert.equal(result.kind, "proposal_invalid");
    assert.equal(result.visibleAnswer, undefined);
    assert.equal(inspectProbeCompletion(envelope(rejection), inScope, context, "lfm").kind, "false_rejection");
  }
});
