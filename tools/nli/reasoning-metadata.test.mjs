import assert from "node:assert/strict";
import test from "node:test";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const message = "오늘 서울 날씨를 알려줘";
const prepared = prepareGroundedRequest(message, context);
const item = { message, prepared, grounded: JSON.parse(prepared.groundedRequestBlock),
  expected: { intent: "reject_out_of_scope" }, candidateSources: prepared.candidateSources };
const envelope = () => ({ model: "fake", choices: [{ finish_reason: "stop", message: {
  role: "assistant", content: '{"intent":"reject_out_of_scope","confidence":1}'
} }] });
const locations = [(value) => ({ reasoning_tokens: value }),
  (value) => ({ completion_tokens_details: { reasoning_tokens: value } }),
  (value) => ({ output_tokens_details: { reasoning_tokens: value } })];

test("present invalid reasoning counts at every supported alias fail Qwen with parser parity", () => {
  for (const location of locations) for (const value of [0.5, 1e20, "2", "0", -1, null, true, {}, [], undefined, NaN, Infinity]) {
    const data = { ...envelope(), usage: location(value) };
    const outcome = inspectModelCompletion(data, "qwen");
    const probe = inspectProbeCompletion(data, item, context, "qwen");
    assert.equal(outcome.kind, "reasoning_violation", `counter ${String(value)}`);
    assert.equal(probe.kind, "reasoning_violation");
    assert.equal(outcome.metadata.reasoningAccounting, "invalid");
    assert.equal(probe.reasoning.accounting, "invalid");
    assert.equal(outcome.metadata.reasoningTokens, null);
    assert.equal(inspectModelCompletion(data, "lfm").tag, "success");
    assert.equal(inspectProbeCompletion(data, item, context, "lfm").ok, true);
  }
});

test("absent, valid zero and positive counts retain distinct accounting states", () => {
  for (const usage of [undefined, {}, { completion_tokens_details: {}, output_tokens_details: {} }]) {
    const data = envelope();
    if (usage !== undefined) data.usage = usage;
    assert.equal(inspectModelCompletion(data, "qwen").metadata.reasoningAccounting, "unavailable");
    assert.equal(inspectProbeCompletion(data, item, context, "qwen").reasoning.accounting, "unavailable");
  }
  for (const location of locations) for (const value of [0, 2, Number.MAX_SAFE_INTEGER]) {
    const data = { ...envelope(), usage: location(value) };
    const outcome = inspectModelCompletion(data, "qwen");
    assert.equal(outcome.metadata.reasoningAccounting, value ? "positive" : "zero");
    assert.equal(outcome.metadata.reasoningTokens, value);
    assert.equal(outcome.tag, value ? "failure" : "success");
    assert.equal(inspectProbeCompletion(data, item, context, "qwen").ok, !value);
  }
});

test("malformed parents and mixed aliases cannot hide invalid counts behind zero", () => {
  for (const usage of [null, [], "SECRET", { output_tokens_details: null }, { completion_tokens_details: [] },
    { reasoning_tokens: 0, output_tokens_details: { reasoning_tokens: "SECRET" } },
    { reasoning_tokens: 2, completion_tokens_details: { reasoning_tokens: -1 } }]) {
    const data = { ...envelope(), usage };
    const outcome = inspectModelCompletion(data, "qwen");
    const probe = inspectProbeCompletion(data, item, context, "qwen");
    assert.equal(outcome.kind, "reasoning_violation");
    assert.equal(probe.kind, "reasoning_violation");
    assert.ok(!JSON.stringify([outcome, probe]).includes("SECRET"));
  }
});
