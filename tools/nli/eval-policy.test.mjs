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
import { validReceipt } from "./qwen-verification-proof.mjs";

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

for (const endpoint of ["lfm", "qwen"]) {
  test(`${endpoint}: explicit v1 semantic proof is stale despite unchanged hashes`, async () => {
    const config = createGatewayConfig({});
    const inputs = await createEvaluationInputs(endpoint, endpoint === "lfm" ? config.lfm : config.model, await loadNliContext());
    const { report, receipt } = endpoint === "lfm" ? { report: lfmReportFixture(inputs) } : qwenReportFixture(inputs);
    const valid = (value, proof = receipt) => endpoint === "lfm" ? validLfmReport(value, inputs, Date.now()) :
      validQwenReport(value, proof, inputs, Date.now());
    assert.equal(VERIFICATION_POLICY, "shared-acceptance-v2");
    assert.equal(report.version, 1);
    assert.equal(valid(report), true);
    for (const select of [(r) => r, (r) => r.evaluationBinding, ...(endpoint === "qwen" ? [(r) => r.binding] : [])]) {
      const old = structuredClone(report);
      select(old).verificationPolicy = "shared-acceptance-v1";
      assert.equal(valid(old), false);
    }
    if (endpoint === "qwen") {
      const runtime = { binding: inputs.runtimeBinding, matrix: inputs.matrix };
      const old = { ...receipt, verificationPolicy: "shared-acceptance-v1" };
      assert.equal(receipt.version, 1);
      assert.equal(validReceipt(receipt, runtime, Date.now()), true);
      assert.equal(validReceipt(old, runtime, Date.now()), false);
      assert.equal(valid(report, old), false);
    }
  });

  test(`${endpoint}: bound producer cannot relabel a v1 report as v2`, async () => {
    const context = await loadNliContext();
    const config = createGatewayConfig({});
    const settings = endpoint === "lfm" ? config.lfm : config.model;
    const inputs = await createEvaluationInputs(endpoint, settings, context);
    const current = endpoint === "lfm" ? lfmReportFixture(inputs) : qwenReportFixture(inputs).report;
    const old = { ...current, verificationPolicy: "shared-acceptance-v1" };
    delete old.evaluationBinding;
    const options = { endpoint, mode: "verify", context, settings, cases: prepareProbeCases(inputs.fixtures, context) };
    const result = await runBoundVerification(options, { runProbe: async () => old });
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.equal(result.verificationPolicy, "shared-acceptance-v1");
    assert.equal(result.evaluationBinding, undefined);
    assert.ok(result.blockers.includes("verification_policy_mismatch"));
    const fresh = await runBoundVerification(options, { runProbe: async () => current });
    assert.equal(fresh.verified, true);
    assert.equal(fresh.evaluationBinding.verificationPolicy, "shared-acceptance-v2");
  });
}
