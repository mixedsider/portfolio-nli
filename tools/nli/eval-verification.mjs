import { createModelAdmission } from "./model-admission.mjs";
import { createQwenVerifier } from "./qwen-verification.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { readProofFile } from "./eval-proof-files.mjs";
import { validLfmReport, validQwenReport } from "./eval-proof-validation.mjs";
import { collectProbeMetadata } from "./probe-metadata.mjs";

export async function verificationEvidence(options, config, context, { wallNow = Date.now } = {}) {
  const lfm = await readProofFile(options["lfm-verification"]);
  const qwen = await readProofFile(options["qwen-verification"]);
  const lfmInputs = await createEvaluationInputs("lfm", config.lfm, context);
  const qwenInputs = await createEvaluationInputs("qwen", config.model, context);
  const before = await readProofFile(config.cascade.qwenVerificationFile, 65536);
  const admission = createModelAdmission(config.cascade.maxConcurrentRequests);
  const verifier = createQwenVerifier(config.model, config.cascade, { context, admission, wallNow });
  const gate = await verifier.verify();
  let runtimeLfmGate = { ok: false, reason: "invalid_report", metadataCalls: 0, inferenceCalls: 0 };
  if (validLfmReport(lfm?.value, lfmInputs, wallNow())) {
    const release = admission.acquire(lfmInputs.binding.completionUrl, config.lfm.maxConcurrentRequests);
    if (release) {
      try {
        const metadata = await collectProbeMetadata("lfm", config.lfm, lfmInputs.matrix[0].payload);
        const ok = metadata.ok === true && metadata.identitySha256 === lfm.value.metadata.identitySha256;
        runtimeLfmGate = { ok, reason: ok ? null : "metadata_identity_mismatch", metadataCalls: 1, inferenceCalls: 0,
          status: metadata.status ?? null, elapsedMs: metadata.elapsedMs };
      } finally { release(); }
    } else runtimeLfmGate = { ...runtimeLfmGate, reason: "busy" };
  }
  const after = await readProofFile(config.cascade.qwenVerificationFile, 65536);
  const lfmAfter = await readProofFile(options["lfm-verification"]);
  const qwenAfter = await readProofFile(options["qwen-verification"]);
  const reportsStable = { lfm: lfm !== null && lfmAfter !== null && lfm.digest === lfmAfter.digest,
    qwen: qwen !== null && qwenAfter !== null && qwen.digest === qwenAfter.digest };
  const lfmVerified = reportsStable.lfm && runtimeLfmGate.ok && validLfmReport(lfm?.value, lfmInputs, wallNow());
  const receiptStable = before !== null && after !== null && before.digest === after.digest;
  const qwenVerified = reportsStable.qwen && gate.ok === true && receiptStable && gate.returnedModelId === after.value.returnedModelId &&
    validQwenReport(qwen?.value, after.value, qwenInputs, wallNow());
  const timestamps = [lfmAfter?.value.checkedAt, qwenAfter?.value.checkedAt, after?.value.checkedAt].map((value) =>
    typeof value === "string" ? Date.parse(value) : NaN);
  const validUntil = timestamps.every(Number.isFinite) ? Math.min(...timestamps) + 86400000 : null;
  if (admission.active) throw new Error("Verification admission leak");
  return { lfmVerified, qwenVerified, lfmReport: options["lfm-verification"] ?? null,
    qwenReport: options["qwen-verification"] ?? null, runtimeQwenGate: gate, runtimeLfmGate, receiptStable, reportsStable, validUntil,
    proofDigests: { lfmReport: lfmAfter?.digest ?? null, qwenReport: qwenAfter?.digest ?? null, receipt: receiptStable ? after.digest : null },
    qualification: { lfm: lfmVerified ? "current_complete_verify_report" : "missing_or_invalid_current_proof",
      qwen: qwenVerified ? "current_report_matches_verified_receipt" : "missing_or_invalid_report_receipt_binding" },
    cleanup: { ok: true, active: admission.active } };
}
