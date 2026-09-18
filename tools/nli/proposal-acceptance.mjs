import { canonicalizeModelResponse, validateNliResponse } from "./validation.mjs";
import { checkAnswerObligations } from "./answer-obligations.mjs";
import { getObligationSourceGroups, obligationCatalog } from "./obligation-sources.mjs";
import { mentionSpans, normalizeObligationText, PARTICLES } from "./obligation-vocabulary.mjs";
import { assistantIdentityWords, capabilityWords } from "./routing-vocabulary.mjs";
import { hasAny, normalize } from "./text.mjs";

export const PROPOSAL_FAILURE_REASONS = Object.freeze([
  "transport_invalid", "prepared_invalid", "proposal_invalid", "coverage_impossible", "ambiguous_request",
  "false_rejection", "intent_mismatch", "scope_mismatch", "source_group_missing", "ambiguous_attribution",
  "clause_unsupported", "quantity_unsupported", "project_clause_missing", "subject_clause_missing"
]);

// Detailed task6 success is gate 1, not semantic acceptance. No draft is returned on failure.
export function acceptTransportProposal(outcome, context, prepared, originalMessage = "") {
  const metadata = outcome?.metadata;
  if (outcome?.tag !== "success" || !["lfm", "qwen"].includes(metadata?.endpoint) || metadata.finishReason !== "stop" ||
    (metadata.endpoint === "qwen" && (metadata.reasoningPresent === true || metadata.reasoningTokens > 0 || metadata.reasoningBytes > 0 ||
      ["positive", "invalid"].includes(metadata.reasoningAccounting)))) return failure("transport_invalid");
  return acceptProposal(outcome.candidate, context, prepared, originalMessage);
}

// Direct candidate seam: caller must already have passed the strict task6 transport gate.
export function acceptProposal(candidate, context, prepared, originalMessage = "") {
  if (!validPrepared(prepared, context)) return failure("prepared_invalid");
  const response = canonicalizeModelResponse(candidate, context, { candidateSources: prepared.candidateSources });
  if (!response) return failure("proposal_invalid");
  const reason = responseObligations(response, context, prepared, originalMessage);
  return reason ? failure(reason) : { accepted: true, response };
}

// Only for trusted resolveLocally canonical responses in MODEL-ENABLED failure paths.
// Offline useModel:false must continue returning the legacy local response directly.
export function isCompatibleLocalFallback(response, context, prepared, originalMessage = "") {
  if (!validPrepared(prepared, context) || !validateNliResponse(response, context, {
    candidateSources: prepared.candidateSources
  }).ok) return false;
  if (["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"].includes(response.intent)) {
    return responseObligations(response, context, prepared, originalMessage) === null;
  }
  if (!prepared.obligations.expectedIntents.includes("answer_portfolio")) return false;
  if (response.answer.length > 4000) return false;
  if (response.targetId && !prepared.obligations.allowedSourceIds.includes(response.targetId)) return false;
  const groups = getObligationSourceGroups(prepared.obligations, context);
  const cards = prepared.candidateSources.filter((card) => !response.targetId || card.id === response.targetId ||
    (context.projectByTargetId.has(response.targetId) && groups.find((group) => group.id === response.targetId)?.sourceIds.includes(card.id)));
  // Legacy answers have no sourceIds. A bounded <=6-card witness is inferred only
  // from trusted scope; it is never exposed as a replacement canonical response.
  return sourceSubsets(cards.map((card) => card.id)).some((sourceIds) => responseObligations({
    intent: "answer_portfolio", answer: response.answer, sources: sourceIds.map((id) => ({ id }))
  }, context, prepared, originalMessage) === null);
}

function responseObligations(response, context, prepared, originalMessage) {
  const { obligations, candidateSources } = prepared;
  if (!prepared.coveragePossible || !obligations.coveragePossible) return "coverage_impossible";
  if (obligations.ambiguousTargetIds.length > 1 || obligations.kind === "ambiguity") return "ambiguous_request";
  if (response.intent === "reject_out_of_scope") {
    const rejectionOnly = obligations.expectedIntents.length === 1 && obligations.expectedIntents[0] === response.intent;
    if (!rejectionOnly && (obligations.requiredProjectIds.length || obligations.requiredSubjectIds.length ||
      !obligations.expectedIntents.includes(response.intent) || !originalMessage.trim() ||
      hasAny(normalize(originalMessage), [...assistantIdentityWords, ...capabilityWords]))) return "false_rejection";
  }
  if (!obligations.expectedIntents.includes(response.intent)) return "intent_mismatch";
  const groups = getObligationSourceGroups(obligations, context);
  if (response.intent === "navigate") {
    if (!obligations.allowedSourceIds.includes(response.targetId) ||
      groups.some((group) => !group.sourceIds.includes(response.targetId))) return "scope_mismatch";
    const entries = obligationCatalog(context).entries.filter((entry) => entry.type !== "glossary" &&
      obligations.allowedSourceIds.includes(entry.id));
    const named = [...new Set(mentionSpans(originalMessage, entries, [...PARTICLES, "로", "으로"]).map((entry) => entry.id))];
    if (named.length && (named.length !== 1 || named[0] !== response.targetId)) return "scope_mismatch";
  }
  if (response.intent === "define_term") {
    const term = context.termByCanonical.get(normalize(response.term));
    if (response.answer !== term?.answer) return "clause_unsupported";
    const termId = `glossary:${response.term}`;
    if (obligations.requiredSubjectIds.some((id) => normalizeObligationText(id) !== normalizeObligationText(termId)) ||
      obligations.requiredProjectIds.length) return "subject_clause_missing";
    if (groups.some((group) => !candidateSources.some((card) => group.sourceIds.includes(card.id)))) return "source_group_missing";
  }
  if (response.intent === "answer_portfolio") {
    const ids = response.sources.map((source) => source.id);
    if (ids.some((id) => !obligations.allowedSourceIds.includes(id))) return "scope_mismatch";
    return checkAnswerObligations(response.answer, ids, context, prepared);
  }
  return null;
}

function validPrepared(prepared, context) {
  if (!prepared || !prepared.obligations || typeof prepared.coveragePossible !== "boolean") return false;
  const { obligations, candidateSources } = prepared;
  if (!["requiredProjectIds", "requiredSubjectIds", "allowedSourceIds", "expectedIntents", "ambiguousTargetIds"]
    .every((field) => Array.isArray(obligations[field]))) return false;
  if (!Array.isArray(candidateSources) || candidateSources.length > 8) return false;
  return new Set(candidateSources.map((card) => card?.id)).size === candidateSources.length && candidateSources.every((card) =>
    card && typeof card.evidence === "string" && card.evidence.trim() && Buffer.byteLength(card.evidence, "utf8") <= 3000 &&
    card.id === card.targetId && context.targetById.has(card.id) && obligations.allowedSourceIds.includes(card.id));
}

function sourceSubsets(ids) {
  const subsets = [];
  for (let mask = 1; mask < 2 ** ids.length; mask += 1) {
    const selected = ids.filter((_, index) => mask & (1 << index));
    if (selected.length <= 6) subsets.push(selected);
  }
  return subsets;
}

function failure(reason) {
  return { accepted: false, reason };
}
