import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "../nli-gateway.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { validLfmReport, validQwenReport } from "./eval-proof-validation.mjs";
import { lfmReportFixture, qwenReportFixture } from "./eval-proof-fixture.mjs";
import { readFile } from "node:fs/promises";
import { sha256 } from "./qwen-verification-proof.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { auditProofInterfaces } from "./eval-proof-audit.mjs";

test("LFM report requires current complete binding, unique coverage and positive verification facts", async () => {
  const context = await loadNliContext();
  const inputs = await createEvaluationInputs("lfm", createGatewayConfig({}).lfm, context);
  const report = lfmReportFixture(inputs);
  assert.equal(validLfmReport(report, inputs, Date.now()), true);
  const mutations = [
    (r) => { r.schemaSha256 = "stale-schema"; },
    (r) => { r.settings.maxResponseBytes = 1; },
    (r) => { r.settings.maxConcurrentRequests = 1; },
    (r) => { r.results[1] = structuredClone(r.results[0]); },
    (r) => { r.results[0].caseId = "unknown-case"; },
    (r) => { r.results.pop(); },
    (r) => { r.results[0].groundedSha256 = "stale"; },
    (r) => { r.results[0].requestBytes++; },
    (r) => { r.results[0].ok = "true"; },
    (r) => { r.results[0].kind = "timeout"; },
    (r) => { r.results[0].validation.ok = false; },
    (r) => { r.results[0].elapsedMs = -1; },
    (r) => { delete r.results[0].finishReason; },
    (r) => { r.results[0].usage.prompt_tokens = -1; },
    (r) => { r.metadata.models[0].state = "not-loaded"; },
    (r) => { r.mode = "baseline"; },
    (r) => { r.selectedMode = "plain"; },
    (r) => { r.checkedAt = "2000-01-01T00:00:00Z"; },
    (r) => { r.checkedAt = new Date(Date.now() + 60000).toISOString(); },
    (r) => { delete r.evaluationBinding; },
    (r) => { r.results = {}; },
    (r) => { r.error = "failed"; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(report); mutate(invalid);
    assert.equal(validLfmReport(invalid, inputs, Date.now()), false, mutate.toString());
  }
  for (const key of Object.keys(inputs.binding)) {
    const invalid = structuredClone(report); invalid.evaluationBinding[key] = "stale";
    assert.equal(validLfmReport(invalid, inputs, Date.now()), false, key);
  }
  const time = Date.parse(report.checkedAt);
  assert.equal(validLfmReport(report, inputs, time + 86400000), true);
  assert.equal(validLfmReport(report, inputs, time + 86400001), false);
});

test("bindings use current raw schema/fixtures and exact prepared payloads without any network", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("No network authorized"); };
  try {
    const context = await loadNliContext();
    const inputs = await createEvaluationInputs("qwen", createGatewayConfig({}).model, context);
    assert.equal(inputs.binding.schemaSha256, sha256(await readFile(new URL("../../nli/model-decision.schema.json", import.meta.url))));
    assert.equal(inputs.binding.fixtureSha256, sha256(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url))));
    for (const { item, payload } of inputs.matrix) {
      const prepared = prepareGroundedRequest(item.message, { ...context, history: item.history, currentTargetId: item.currentTargetId });
      assert.equal(payload.messages[1].content, prepared.groundedRequestBlock);
    }
    const audit = await auditProofInterfaces(createGatewayConfig({}), context);
    assert.equal(audit.networkCalls, 0);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("Qwen report must identify exactly the current receipt, complete unique matrix and freshness", async () => {
  const inputs = await createEvaluationInputs("qwen", createGatewayConfig({}).model, await loadNliContext());
  const { report, receipt } = qwenReportFixture(inputs);
  assert.equal(validQwenReport(report, receipt, inputs, Date.now()), true);
  const mutations = [
    (r) => { r.endpoint = "lfm"; }, (r) => { r.mode = "baseline"; },
    (r) => { r.checkedAt = "2000-01-01T00:00:00Z"; },
    (r) => { r.checkedAt = new Date(Date.now() + 10000).toISOString(); },
    (r) => { r.checkedAt = new Date(Date.parse(r.checkedAt) - 1).toISOString(); },
    (r) => { r.binding.endpoint = "http://127.0.0.1:1/v1/chat/completions"; },
    (r) => { r.results = Array.from({ length: 18 }, () => ({ ok: true })); },
    (r) => { r.results[1] = structuredClone(r.results[0]); },
    (r) => { r.results[0].reasoningPresent = true; },
    (r) => { r.results[0].reasoningBytes = -1; },
    (r) => { r.proof.buildInfoSha256 = "0".repeat(64); },
    (r) => { r.receiptWritten = "true"; }, (r) => { r.inferenceCalls = 17; },
    (r) => { r.selectedMode = "plain"; }, (r) => { r.blockers = ["qwen_unverified"]; },
    (r) => { r.results[0].kind = "failure"; }, (r) => { delete r.evaluationBinding; }
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(report); mutate(invalid);
    assert.equal(validQwenReport(invalid, receipt, inputs, Date.now()), false, mutate.toString());
  }
  for (const key of Object.keys(inputs.binding)) {
    const invalid = structuredClone(report); invalid.evaluationBinding[key] = "stale";
    assert.equal(validQwenReport(invalid, receipt, inputs, Date.now()), false, key);
  }
  assert.equal(validQwenReport(report, null, inputs, Date.now()), false);
  const time = Date.parse(report.checkedAt);
  assert.equal(validQwenReport(report, receipt, inputs, time + 86400000), true);
  assert.equal(validQwenReport(report, receipt, inputs, time + 86400001), false);
});

test("issue 6 invalidates old LFM settings proof, not unchanged Qwen proof or payloads", async () => {
  const context = await loadNliContext();
  // Intentional pre-issue-6 settings; never relabel a historical proof with new hashes.
  const previous = createGatewayConfig({ LFM_TIMEOUT_MS: "4000", NLI_CASCADE_TIMEOUT_MS: "21000" });
  const current = createGatewayConfig({});
  const oldLfm = await createEvaluationInputs("lfm", previous.lfm, context);
  const newLfm = await createEvaluationInputs("lfm", current.lfm, context);
  const report = lfmReportFixture(oldLfm);
  assert.equal(validLfmReport(report, oldLfm, Date.now()), true);
  assert.equal(validLfmReport(report, newLfm, Date.now()), false);
  assert.notEqual(oldLfm.binding.settingsSha256, newLfm.binding.settingsSha256);
  assert.equal(oldLfm.binding.matrixSha256, newLfm.binding.matrixSha256);
  const oldQwen = await createEvaluationInputs("qwen", previous.model, context);
  const newQwen = await createEvaluationInputs("qwen", current.model, context);
  assert.deepEqual(oldQwen.binding, newQwen.binding);
  assert.deepEqual(oldQwen.runtimeBinding, newQwen.runtimeBinding);
  const proof = qwenReportFixture(oldQwen);
  assert.equal(validQwenReport(proof.report, proof.receipt, newQwen, Date.now()), true);
});

test("configured plain mode needs actual schema-unsupported selection, not a relabeled schema success", async () => {
  const inputs = await createEvaluationInputs("lfm", { ...createGatewayConfig({}).lfm, outputMode: "plain" }, await loadNliContext());
  const report = lfmReportFixture(inputs);
  assert.equal(validLfmReport(report, inputs, Date.now()), false, "schema would actually be selected first");
  report.results = report.results.map((row) => row.outputMode === "plain" ? row : {
    caseId: row.caseId, outputMode: row.outputMode, requestBytes: row.requestBytes, groundedSha256: row.groundedSha256,
    ok: false, kind: "http_error", status: 400, bytes: 100, elapsedMs: 10, schemaUnsupported: true
  });
  assert.equal(validLfmReport(report, inputs, Date.now()), true);
  report.results[0].schemaUnsupported = false;
  report.results.slice(1, 6).forEach((row) => { row.schemaUnsupported = false; });
  assert.equal(validLfmReport(report, inputs, Date.now()), false);
});
