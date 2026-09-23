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
  assert.match(context.prompt, /Decide scope first/);
  assert.match(context.prompt, /current\/external requests \(including weather\)/);
  assert.match(context.prompt, /unrelated context cannot expand scope/i);
  assert.match(context.prompt, /Other one-section: one ≤60-character sentence/);
  assert.match(context.prompt, /answer 4,000 characters/);
  assert.match(context.prompt, /one supported ≤40-char clause per project\/subject/);
  assert.doesNotMatch(context.prompt, /(?:at most|under) 600 characters/);
  assert.match(context.prompt, /4,000/);
  assert.doesNotMatch(context.prompt, /```/);
  assert.ok(Buffer.byteLength(context.prompt) <= 2500);
  assert.ok(context.prompt.indexOf("Decide scope first") < context.prompt.indexOf("`navigate` is only"));
  for (const intent of ["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"]) {
    assert.ok(context.prompt.includes(intent));
  }
  for (const field of ["intent", "confidence", "targetId", "term", "answer", "sourceIds"]) {
    assert.ok(context.prompt.includes(field));
  }
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
