import assert from "node:assert/strict";
import test from "node:test";
import { shouldEscalate } from "./escalation-policy.mjs";

const eligible = { obligations: { kind: "comparison", coveragePossible: true }, lfmAccepted: false, qwenEnabled: true, qwenVerified: true, remainingStageMs: 2000, admissionAvailable: true };
test("pure predicate permits only unresolved difficult requests at inclusive stage budget", () => {
  for (const kind of ["comparison", "synthesis", "ambiguity"]) {
    const input = { ...eligible, obligations: { ...eligible.obligations, kind } };
    assert.deepEqual(shouldEscalate(input), { allow: true, reason: "eligible" });
    assert.equal(input.remainingStageMs, 2000);
  }
});
test("every terminal and eligibility rejection has a deterministic reason", () => {
  for (const [patch, reason] of [
    [{ lfmAccepted: true }, "lfm_accepted"],
    [{ cancelled: true }, "cancelled"],
    [{ deadlineExceeded: true }, "deadline_exhausted"],
    [{ lfmFailure: "busy" }, "admission_unavailable"],
    [{ lfmFailure: "aborted" }, "cancelled"],
    [{ admissionAvailable: false }, "admission_unavailable"],
    [{ obligations: { kind: "ordinary", coveragePossible: true } }, "ordinary_request"],
    [{ obligations: { kind: "comparison", coveragePossible: false } }, "coverage_impossible"],
    [{ qwenEnabled: false }, "qwen_disabled"],
    [{ qwenVerified: false }, "qwen_unverified"],
    [{ remainingStageMs: 1999 }, "insufficient_stage_budget"],
    [{ remainingStageMs: NaN }, "insufficient_stage_budget"]
  ]) assert.deepEqual(shouldEscalate({ ...eligible, ...patch }), { allow: false, reason });
  assert.equal(shouldEscalate({}).allow, false);
});
test("confidence and ordinary malformed/timeout outcomes never cause promotion", () => {
  for (const confidence of [0.01, 0.99]) {
    assert.equal(shouldEscalate({ ...eligible, confidence, lfmAccepted: true }).allow, false);
    for (const lfmFailure of ["timeout", "invalid_json"]) assert.equal(shouldEscalate({ ...eligible, confidence, lfmFailure, obligations: { kind: "ordinary", coveragePossible: true } }).allow, false);
  }
});
