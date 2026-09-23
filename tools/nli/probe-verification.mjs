import { open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createModelAdmission } from "./model-admission.mjs";
import { inspectModelCompletion } from "./model-outcome.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";
import { verificationInputs, collectQwenProof, sha256 } from "./qwen-verification-proof.mjs";
import { withVerificationBudget, verificationRequest } from "./qwen-verification-http.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

const failureDetails = new Set(["aborted", "timeout", "busy", "http_error", "invalid_json", "body_limit",
  "identity", "template", "completion", "identity_changed"]);

async function writeReceipt(path, receipt, signal) {
  if (!(await stat(dirname(path))).isDirectory()) throw new Error("receipt_parent");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function runQwenVerification(options, dependencies = {}) {
  const inputs = verificationInputs(options.settings, options.context, options.schemaBytes);
  const now = dependencies.now || (() => performance.now());
  const admission = dependencies.admission || createModelAdmission(4);
  const counters = { metadataCalls: 0, inferenceCalls: 0 };
  const results = [];
  const report = { version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint: "qwen", mode: "verify", ok: false, verified: false, receiptWritten: false,
    selectedMode: inputs.settings.outputMode, status: "activation-blocked", blockers: [], results };
  const bounded = (budgetMs, operation) => withVerificationBudget({ budgetMs, now, signal: options.signal }, (scope) =>
    operation(verificationRequest(inputs, { ...dependencies, admission }, scope, counters)));
  let stage = "initial_proof";
  try {
    const proof = await bounded(inputs.settings.timeoutMs, (request) => collectQwenProof(inputs, request));
    stage = "inference";
    for (const { item, repeat, payload } of inputs.matrix) {
      const data = await bounded(inputs.settings.timeoutMs, (request) => request(inputs.url, payload));
      const outcome = inspectModelCompletion(data, "qwen");
      const fixture = inspectProbeCompletion(data, item, options.context, "qwen");
      const metadata = outcome.metadata;
      const ok = outcome.tag === "success" && fixture.ok && metadata.modelId === proof.returnedModelId;
      results.push({ caseId: item.id, repeat, ok, returnedModelId: metadata.modelId, finishReason: metadata.finishReason,
        reasoningPresent: metadata.reasoningPresent, reasoningBytes: metadata.reasoningBytes,
        reasoningAccounting: metadata.reasoningAccounting });
      if (!ok) throw new Error("completion");
    }
    stage = "final_proof";
    const after = await bounded(inputs.settings.timeoutMs, (request) => collectQwenProof(inputs, request));
    if (sha256(after) !== sha256(proof)) throw new Error("identity_changed");
    const receipt = { version: 1, ...inputs.binding, returnedModelId: proof.returnedModelId, proof,
      checkedAt: new Date((dependencies.wallNow || Date.now)()).toISOString(), probeCount: results.length, results,
      reasoningAccounting: results.every((row) => row.reasoningAccounting === "zero") ? "zero" : "unavailable" };
    if (options.receipt) {
      stage = "receipt_write";
      await writeReceipt(options.receipt, receipt, options.signal);
      report.receiptWritten = true;
    }
    stage = "complete";
    Object.assign(report, { ok: true, verified: true, status: "live-verified", checkedAt: receipt.checkedAt,
      binding: inputs.binding, proof, reasoningAccounting: receipt.reasoningAccounting });
  } catch (error) {
    report.blockers.push("qwen_unverified");
    report.detail = failureDetails.has(error?.message) ? error.message :
      stage === "initial_proof" ? "metadata_transport" : stage === "receipt_write" ? "receipt_write" : "unknown";
  }
  return { ...report, ...counters };
}
