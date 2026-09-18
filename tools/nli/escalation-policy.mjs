// remainingStageMs is already min(qwenTimeoutMs, totalRemainingMs - reserveMs).
// This predicate performs no verification, admission, clock reads, or dispatch.
export function shouldEscalate(input = {}) {
  const deny = (reason) => ({ allow: false, reason });
  if (input.cancelled === true || input.lfmFailure === "aborted") return deny("cancelled");
  if (input.deadlineExceeded === true) return deny("deadline_exhausted");
  if (input.lfmAccepted === true) return deny("lfm_accepted");
  if (input.lfmFailure === "busy" || input.admissionAvailable !== true) return deny("admission_unavailable");
  if (!["comparison", "synthesis", "ambiguity"].includes(input.obligations?.kind)) return deny("ordinary_request");
  if (input.obligations.coveragePossible !== true) return deny("coverage_impossible");
  if (input.qwenEnabled !== true) return deny("qwen_disabled");
  if (input.qwenVerified !== true) return deny("qwen_unverified");
  if (!Number.isFinite(input.remainingStageMs) || input.remainingStageMs < 2000) return deny("insufficient_stage_budget");
  return { allow: true, reason: "eligible" };
}
