import assert from "node:assert/strict";
import test from "node:test";
import { inspectModelCompletion, MODEL_FAILURE_KINDS } from "./model-outcome.mjs";

const candidate = { intent: "reject_out_of_scope", confidence: 1 };
function envelope(content = JSON.stringify(candidate)) {
  return { model: "returned-alias", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] };
}

test("strict completion metadata distinguishes unavailable and zero reasoning accounting", () => {
  const data = envelope();
  const result = inspectModelCompletion(data, "qwen");
  assert.equal(result.tag, "success");
  assert.deepEqual(result.candidate, candidate);
  assert.equal(result.metadata.modelId, "returned-alias");
  assert.equal(result.metadata.usageAvailable, false);
  assert.equal(result.metadata.reasoningAccounting, "unavailable");
  data.usage = { completion_tokens_details: { reasoning_tokens: 0 } };
  assert.equal(inspectModelCompletion(data, "qwen").metadata.reasoningAccounting, "zero");
  data.choices[0].message.tool_calls = [];
  assert.equal(inspectModelCompletion(data, "qwen").tag, "success");
});

test("strict transport rejects incomplete and hostile envelopes without candidate leakage", () => {
  const cases = [
    [null, "invalid_envelope"], [{ choices: [] }, "invalid_envelope"],
    [{ choices: [...envelope().choices, ...envelope().choices] }, "invalid_envelope"],
    [envelope(""), "invalid_json"], [envelope("```json\n{}\n```"), "invalid_json"],
    [envelope("[]"), "invalid_json"], [envelope("null"), "invalid_json"],
    [envelope("{} trailing"), "invalid_json"]
  ];
  for (const [key, value, kind] of [
    ["finish_reason", "length", "truncated"], ["finish_reason", null, "invalid_envelope"],
    ["role", "user", "invalid_envelope"], ["role", undefined, "invalid_envelope"],
    ["tool_calls", [{}], "invalid_envelope"], ["tool_calls", {}, "invalid_envelope"],
    ["function_call", { name: "tool" }, "invalid_envelope"]
  ]) {
    const data = envelope();
    (key === "finish_reason" ? data.choices[0] : data.choices[0].message)[key] = value;
    cases.push([data, kind]);
  }
  for (const [data, kind] of cases) {
    const result = inspectModelCompletion(data, "qwen");
    assert.equal(result.tag, "failure");
    assert.equal(result.kind, kind);
    assert.equal(Object.hasOwn(result, "candidate"), false);
    assert.ok(MODEL_FAILURE_KINDS.includes(kind));
  }
});

test("Qwen positive reasoning fails; LFM records facts but never promotes hidden content", () => {
  for (const field of ["reasoning_content", "reasoning", "reasoning_details"]) {
    const data = envelope();
    data.choices[0].message[field] = "private synthetic reasoning";
    const qwen = inspectModelCompletion(data, "qwen");
    assert.equal(qwen.kind, "reasoning_violation");
    const lfm = inspectModelCompletion(data, "lfm");
    assert.equal(lfm.tag, "success");
    assert.deepEqual(lfm.candidate, candidate);
    assert.ok(lfm.metadata.reasoningBytes > 0);
    assert.equal(JSON.stringify([lfm, qwen]).includes("private synthetic"), false);
    data.choices[0].message.content = "";
    assert.equal(inspectModelCompletion(data, "lfm").tag, "failure");
  }
  const data = envelope();
  data.usage = { completion_tokens_details: { reasoning_tokens: 2 } };
  assert.equal(inspectModelCompletion(data, "qwen").kind, "reasoning_violation");
  assert.equal(inspectModelCompletion(data, "lfm").metadata.reasoningAccounting, "positive");
  assert.equal(inspectModelCompletion(envelope('{"answer":"<think>secret</think>"}'), "qwen").kind, "reasoning_violation");
});
