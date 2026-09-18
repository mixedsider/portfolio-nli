import { buildEvidenceIndex, retrieveEvidenceCandidates } from "./evidence.mjs";
import { isCurrentProjectScopeConstrained, isTargetInCurrentProjectScope } from "./router.mjs";
import { canonicalizeModelResponse } from "./validation.mjs";
import { UpstreamUnavailableError } from "./request-deadline.mjs";

// Explicit proposal-only TEST seam; never constructed or selected for normal service.
export async function resolveLegacyRequest(message, context, local, fallback, options) {
  if (fallback.intent === "summarize_project") return fallback;
  const candidateSources = retrieveEvidenceCandidates(buildEvidenceIndex(context), {
    message, history: context.history, currentTargetId: context.currentTargetId
  });
  let proposal;
  try {
    proposal = await options.modelClient(message, context, {
      candidateSources, history: context.history, currentTargetId: context.currentTargetId,
      targets: context.routes.targets, terms: context.glossary.terms
    });
  } catch {
    if (local.confidence > 0) return local;
    if (options.reportUpstreamFailure) throw new UpstreamUnavailableError();
    return fallback;
  }
  const canonical = canonicalizeModelResponse(proposal, context, { candidateSources });
  const scoped = canonical?.intent === "navigate" && isCurrentProjectScopeConstrained(message, context) &&
    !isTargetInCurrentProjectScope(canonical.targetId, context) ? null : canonical;
  if (fallback.intent === "navigate") {
    return scoped?.intent === "navigate" && scoped.targetId === fallback.targetId ? scoped : fallback;
  }
  if (!scoped && local.confidence <= 0 && options.reportUpstreamFailure) throw new UpstreamUnavailableError();
  return scoped || fallback;
}
