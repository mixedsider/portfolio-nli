import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "../nli-gateway.mjs";
import { verificationEvidence } from "./eval-verification.mjs";

export const FINAL_PROOF_REASONS = Object.freeze(["unchanged_current_proof", "initial_proof_unverified",
  "final_lfm_unverified", "final_qwen_unverified", "proof_identity_unobserved", "lfm_report_changed", "qwen_report_changed",
  "receipt_changed", "final_receipt_unstable", "final_proof_time_unobserved", "final_proof_expired", "unexpected_final_inference",
  "final_cleanup_failed", "final_verification_failed"]);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function finalProofDecision(initial, final, now) {
  const reasons = [];
  if (initial?.lfmVerified !== true || initial?.qwenVerified !== true) reasons.push("initial_proof_unverified");
  if (final?.lfmVerified !== true || final.runtimeLfmGate?.ok !== true) reasons.push("final_lfm_unverified");
  if (final?.qwenVerified !== true || final.runtimeQwenGate?.ok !== true) reasons.push("final_qwen_unverified");
  for (const [key, reason] of [["lfmReport", "lfm_report_changed"], ["qwenReport", "qwen_report_changed"], ["receipt", "receipt_changed"]]) {
    const before = initial?.proofDigests?.[key];
    const after = final?.proofDigests?.[key];
    if (!digest(before) || !digest(after)) reasons.push("proof_identity_unobserved");
    else if (before !== after) reasons.push(reason);
  }
  if (initial?.receiptStable !== true || final?.receiptStable !== true) reasons.push("final_receipt_unstable");
  if (!Number.isFinite(now) || !Number.isFinite(final?.validUntil)) reasons.push("final_proof_time_unobserved");
  else if (now > final.validUntil) reasons.push("final_proof_expired");
  if (final?.runtimeLfmGate?.inferenceCalls !== 0 || final?.runtimeQwenGate?.inferenceCalls !== 0) reasons.push("unexpected_final_inference");
  if (final?.cleanup?.ok !== true) reasons.push("final_cleanup_failed");
  return { ok: reasons.length === 0, reason: reasons[0] ?? "unchanged_current_proof", reasons: [...new Set(reasons)] };
}

// Fresh local inputs + actual metadata checks only. Never run inference verification again.
export async function revalidateFinalProof(initial, options, dependencies = {}) {
  const wallNow = dependencies.wallNow ?? Date.now;
  try {
    const config = (dependencies.loadConfig ?? createGatewayConfig)();
    const context = await (dependencies.loadContext ?? loadNliContext)();
    const verification = await (dependencies.verify ?? verificationEvidence)(options, config, context, { wallNow });
    const now = wallNow();
    return { ...finalProofDecision(initial, verification, now), checkedAt: new Date(now).toISOString(), verification };
  } catch {
    return { ok: false, reason: "final_verification_failed", reasons: ["final_verification_failed"], verification: null };
  }
}
