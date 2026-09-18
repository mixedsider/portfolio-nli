import test from "node:test";
import assert from "node:assert/strict";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";
import { loadNliContext } from "../nli-gateway.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { lfmReportFixture, qwenReportFixture } from "./eval-proof-fixture.mjs";
import { validLfmReport, validQwenReport } from "./eval-proof-validation.mjs";
import { runBoundVerification } from "./eval-bound-probe.mjs";
import { prepareProbeCases } from "./probe-request.mjs";

test("8s Qwen receipt and evaluation report cannot authorize amended 16s settings", async () => {
  const context = await loadNliContext();
  const settings = createGatewayConfig({}).model;
  const oldInputs = await createEvaluationInputs("qwen", { ...settings, timeoutMs: 8000 }, context);
  const currentInputs = await createEvaluationInputs("qwen", settings, context);
  const { report, receipt } = qwenReportFixture(oldInputs);
  assert.equal(validQwenReport(report, receipt, oldInputs, Date.now()), true);
  assert.equal(validQwenReport(report, receipt, currentInputs, Date.now()), false);
});

test("old LFM acceptance proof fails without policy even when every existing hash/fact matches", async () => {
  const inputs = await createEvaluationInputs("lfm", createGatewayConfig({}).lfm, await loadNliContext());
  const current = lfmReportFixture(inputs);
  const old = structuredClone(current);
  delete old.verificationPolicy;
  assert.equal(validLfmReport(old, inputs, Date.now()), false);
  assert.equal(inputs.binding.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(validLfmReport(current, inputs, Date.now()), true);
  const staleBinding = structuredClone(current);
  delete staleBinding.evaluationBinding.verificationPolicy;
  assert.equal(validLfmReport(staleBinding, inputs, Date.now()), false);
});

test("bound producer refuses to label a weak-policy result with the current acceptance policy", async () => {
  const context = await loadNliContext();
  const settings = createGatewayConfig({}).lfm;
  const inputs = await createEvaluationInputs("lfm", settings, context);
  const old = lfmReportFixture(inputs);
  delete old.verificationPolicy;
  let calls = 0;
  const report = await runBoundVerification({ endpoint: "lfm", mode: "verify", context, settings,
    cases: prepareProbeCases(inputs.fixtures, context) }, { runProbe: async () => { calls++; return old; } });
  assert.equal(calls, 1);
  assert.equal(report.ok, false);
  assert.equal(report.verified, false);
  assert.equal(report.verificationPolicy, undefined, "no marker retrofitted to old producer result");
  assert.ok(report.blockers.includes("verification_policy_mismatch"));
});

test("Qwen report, evaluation binding and exact receipt must all carry the shared acceptance policy", async () => {
  const inputs = await createEvaluationInputs("qwen", createGatewayConfig({}).model, await loadNliContext());
  const { report, receipt } = qwenReportFixture(inputs);
  assert.equal(inputs.binding.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(inputs.runtimeBinding.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(report.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(receipt.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(validQwenReport(report, receipt, inputs, Date.now()), true);
  for (const select of [(r) => r, (r) => r.binding, (r) => r.evaluationBinding]) {
    const old = structuredClone(report);
    delete select(old).verificationPolicy;
    assert.equal(validQwenReport(old, receipt, inputs, Date.now()), false);
  }
  const oldReceipt = structuredClone(receipt);
  delete oldReceipt.verificationPolicy;
  assert.equal(validQwenReport(report, oldReceipt, inputs, Date.now()), false);
});
