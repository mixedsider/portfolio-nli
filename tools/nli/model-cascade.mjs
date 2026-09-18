import { createDetailedModelClient } from "./model-client.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { MODEL_FAILURE_KINDS, modelFailure } from "./model-outcome.mjs";
import { createQwenVerifier } from "./qwen-verification.mjs";
import { acceptTransportProposal, isCompatibleLocalFallback, PROPOSAL_FAILURE_REASONS } from "./proposal-acceptance.mjs";
import { shouldEscalate } from "./escalation-policy.mjs";
import { rejectResponse } from "./responses.mjs";
import { assertCascadeRequest, runCascadeOperation } from "./model-cascade-deadline.mjs";

export const CASCADE_STAGES = Object.freeze(["lfm", "qwen", "local_fallback", "clarification", "upstream_error"]);
export const CASCADE_REASONS = Object.freeze([...new Set([
  ...MODEL_FAILURE_KINDS, ...PROPOSAL_FAILURE_REASONS, "accepted", "eligible", "cancelled", "deadline_exhausted",
  "lfm_accepted", "admission_unavailable", "ordinary_request", "qwen_disabled", "qwen_unverified",
  "insufficient_stage_budget", "model_mismatch"
])]);
import { APPLICATION_TIMEOUT_MS, QWEN_TIMEOUT_MS } from "./timeout-policy.mjs";

const nonconforming = new Set(["body_limit", "invalid_envelope", "invalid_json", "truncated", "reasoning_violation"]);

// Construct ONCE per Gateway, never once per request. Injection is trusted test-only.
export function createModelCascade(config, { context, lfmClient, qwenClient, verifier,
  now = () => performance.now(), observer = () => {} } = {}) {
  const settings = structuredClone({ lfm: config.lfm, model: config.model, cascade: config.cascade });
  const limit = Math.min(4, settings.cascade.maxConcurrentRequests);
  const admission = createModelAdmission(limit);
  lfmClient ??= createDetailedModelClient(settings.lfm, { endpoint: "lfm", admission, now });
  qwenClient ??= createDetailedModelClient(settings.model, { endpoint: "qwen", admission, now });
  verifier ??= createQwenVerifier(qwenClient.settings ?? settings.model, settings.cascade, { context, admission, now });
  let invalidated = false;
  const emit = (type, stage, reason) => {
    // Deliberately no caller-supplied IDs, outcome spreading, drafts or metadata objects.
    try { observer(Object.freeze({ type, stage, reason })); } catch { /* Telemetry cannot change routing. */ }
  };
  const invalidate = () => {
    if (invalidated) return;
    invalidated = true;
    verifier.invalidate();
  };

  async function resolve(input) {
    assertCascadeRequest(input);
    const { originalMessage, scopedContext, prepared, signal, localFallback } = input;
    const deadlineAt = Math.min(input.deadlineAt, now() + Math.min(APPLICATION_TIMEOUT_MS, settings.cascade.timeoutMs));
    const workDeadline = deadlineAt - 1000;
    const terminal = () => signal?.aborted ? "aborted" : now() >= workDeadline ? "deadline_exhausted" : null;
    const finish = (stage, reason, response) => {
      const stopped = terminal();
      if (stopped) { stage = "upstream_error"; reason = stopped; response = undefined; }
      emit("complete", stage, reason);
      return response === undefined ? { stage, reason } : { stage, reason, response };
    };
    const fallback = (reason) => {
      if (terminal() || ["busy", "aborted"].includes(reason)) return finish("upstream_error", reason);
      if (!prepared.coveragePossible || prepared.obligations.kind === "ambiguity" || prepared.obligations.ambiguousTargetIds.length > 1) {
        return finish("clarification", !prepared.coveragePossible ? "coverage_impossible" : "ambiguous_request",
          rejectResponse("비교하거나 설명할 대상을 더 구체적으로 알려주세요."));
      }
      if (localFallback && isCompatibleLocalFallback(localFallback, scopedContext, prepared, originalMessage)) {
        return finish("local_fallback", reason, localFallback);
      }
      return finish("upstream_error", reason);
    };
    const stage = async (endpoint, client, stageDeadline) => {
      emit("attempt", endpoint, "eligible");
      const result = await runCascadeOperation((stageSignal) => client(originalMessage, scopedContext, prepared.groundedRequest, {
        signal: stageSignal, deadlineAt: stageDeadline, budgetMs: stageDeadline - now()
      }), { signal, deadlineAt: stageDeadline, now });
      const outcome = result.failure ? modelFailure(result.failure, { endpoint }) : result.value;
      if (outcome?.metadata?.endpoint !== endpoint || !["success", "failure"].includes(outcome?.tag) ||
        (outcome.tag === "failure" && !MODEL_FAILURE_KINDS.includes(outcome.kind))) {
        return modelFailure("invalid_envelope", { endpoint });
      }
      return outcome;
    };
    if (terminal()) return finish("upstream_error", terminal());
    const lfmDeadline = Math.min(workDeadline, now() + Math.min(4000, settings.lfm.timeoutMs));
    const lfm = await stage("lfm", lfmClient, lfmDeadline);
    if (terminal()) return finish("upstream_error", terminal());
    const accepted = acceptTransportProposal(lfm, scopedContext, prepared, originalMessage);
    emit("acceptance", "lfm", accepted.accepted ? "accepted" : accepted.reason);
    if (accepted.accepted) return finish("lfm", "accepted", accepted.response);
    // Preserve transport failure independently of the acceptance adapter's generic reason.
    if (lfm.tag === "failure" && ["busy", "aborted"].includes(lfm.kind)) return fallback(lfm.kind);
    const qwenStart = now();
    const remainingStageMs = Math.min(QWEN_TIMEOUT_MS, settings.model.timeoutMs, workDeadline - qwenStart);
    const qwenDeadline = qwenStart + remainingStageMs;
    const available = admission.active < limit && (!qwenClient.url ||
      admission.activeFor(qwenClient.url) < Math.min(4, settings.model.maxConcurrentRequests));
    // Pure preflight only; verified=true here asks whether verification is worth attempting.
    // No inference is authorized until the real gate below succeeds.
    const eligibility = shouldEscalate({ obligations: prepared.obligations, lfmAccepted: false,
      lfmFailure: lfm.kind, cancelled: signal?.aborted === true, deadlineExceeded: now() >= workDeadline,
      qwenEnabled: settings.cascade.qwenEnabled, qwenVerified: !invalidated, remainingStageMs, admissionAvailable: available });
    emit("escalation", "qwen", eligibility.reason);
    if (!eligibility.allow) return fallback(eligibility.reason === "admission_unavailable" ? "busy" : eligibility.reason);
    const metadataDeadline = Math.min(qwenDeadline, now() + 1000);
    const checked = await runCascadeOperation((stageSignal) => verifier.verify({ signal: stageSignal,
      deadlineAt: qwenDeadline, budgetMs: metadataDeadline - now()
    }), { signal, deadlineAt: metadataDeadline, now });
    if (terminal()) return finish("upstream_error", terminal());
    const gate = checked.value;
    if (checked.failure === "aborted" || ["aborted", "busy"].includes(gate?.detail)) return fallback(checked.failure ?? gate.detail);
    if (checked.failure || invalidated || gate?.ok !== true || typeof gate.returnedModelId !== "string" || !gate.returnedModelId) {
      return fallback("qwen_unverified");
    }
    // Eligibility's 2000ms test is NOT repeated after metadata. Only positive time is required.
    if (now() >= qwenDeadline) return fallback("timeout");
    const qwen = await stage("qwen", qwenClient, qwenDeadline);
    if (qwen.tag === "failure" && nonconforming.has(qwen.kind)) invalidate();
    if (qwen.metadata.modelId != null && qwen.metadata.modelId !== gate.returnedModelId) invalidate();
    if (terminal()) return finish("upstream_error", terminal());
    if (qwen.tag === "failure") return fallback(qwen.kind);
    if (qwen.metadata.modelId !== gate.returnedModelId) {
      if (!invalidated) invalidate();
      return fallback("model_mismatch");
    }
    if (invalidated) return fallback("qwen_unverified");
    const final = acceptTransportProposal(qwen, scopedContext, prepared, originalMessage);
    emit("acceptance", "qwen", final.accepted ? "accepted" : final.reason);
    if (final.accepted) return finish("qwen", "accepted", final.response);
    invalidate();
    return fallback(final.reason);
  }
  return Object.freeze({ resolve, admission });
}
