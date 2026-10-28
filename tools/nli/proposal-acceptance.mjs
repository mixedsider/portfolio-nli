import { canonicalizeModelResponse, validateNliResponse } from "./validation.mjs";
import { checkAnswerObligations, quantitiesSupported } from "./answer-obligations.mjs";
import { getObligationSourceGroups, obligationCatalog } from "./obligation-sources.mjs";
import { mentionSpans, normalizeObligationText, PARTICLES, requestedQuantityCount } from "./obligation-vocabulary.mjs";
import { assistantIdentityWords, capabilityWords } from "./routing-vocabulary.mjs";
import { hasAny, normalize } from "./text.mjs";
import { MAX_GROUNDED_CARD_EVIDENCE_BYTES } from "./grounded-bounds.mjs";

export const PROPOSAL_FAILURE_REASONS = Object.freeze([
  "transport_invalid", "prepared_invalid", "proposal_invalid", "coverage_impossible", "ambiguous_request",
  "false_rejection", "intent_mismatch", "scope_mismatch", "source_group_missing", "ambiguous_attribution",
  "clause_unsupported", "quantity_unsupported", "requested_quantity_missing", "project_clause_missing", "subject_clause_missing"
]);

// Detailed task6 success is gate 1, not semantic acceptance. No draft is returned on failure.
export function acceptTransportProposal(outcome, context, prepared, originalMessage = "") {
  const metadata = outcome?.metadata;
  if (outcome?.tag !== "success" || !["lfm", "qwen"].includes(metadata?.endpoint) || metadata.finishReason !== "stop" ||
    (metadata.endpoint === "qwen" && (metadata.reasoningPresent === true || metadata.reasoningTokens > 0 || metadata.reasoningBytes > 0 ||
      ["positive", "invalid"].includes(metadata.reasoningAccounting)))) return failure("transport_invalid");
  return acceptProposal(outcome.candidate, context, prepared, originalMessage);
}

export function acceptProposal(candidate, context, prepared, originalMessage = "") {
  if (!validPrepared(prepared, context)) return failure("prepared_invalid");
  let response = canonicalizeModelResponse(candidate, context, { candidateSources: prepared.candidateSources });
  if (!response) return failure("proposal_invalid");
  response = normalizeExplicitNavigationResponse(response, context, prepared, originalMessage);
  const reason = responseObligations(response, context, prepared, originalMessage);
  return reason ? failure(reason) : { accepted: true, response };
}

function normalizeExplicitNavigationResponse(response, context, prepared, originalMessage) {
  if (response?.intent !== "answer_portfolio" || typeof originalMessage !== "string") return response;
  if (!/(?:이동|보여\s*줘|보여\s*주세요|보러\s*가|가자|열어\s*줘)/u.test(originalMessage)) return response;
  if (/(?:요약|설명|알려|정리|목록|성과|경험|소개|비교|차이|어떻게|왜|무엇|뭐|몇|연락처|이메일|날씨|뉴스|추천|만들어|출력|무시|시스템|프롬프트|ignore|system|prompt)/iu.test(originalMessage)) {
    return response;
  }
  const { obligations } = prepared;
  const entries = obligationCatalog(context).entries.filter((entry) => entry.type !== "glossary" &&
    obligations.allowedSourceIds.includes(entry.id));
  const named = [...new Set(mentionSpans(originalMessage, entries, [...PARTICLES, "로", "으로"]).map((entry) => entry.id))];
  const targetId = named.length === 1
    ? named[0]
    : (response.sources?.length === 1 && obligations.allowedSourceIds.length < context.routes.targets.length
        ? response.sources[0].id
        : null);
  if (!targetId || !context.targetById.has(targetId) || !obligations.allowedSourceIds.includes(targetId)) return response;
  return canonicalizeModelResponse({ intent: "navigate", confidence: response.confidence, targetId }, context) || response;
}

// Only for trusted resolveLocally canonical responses in MODEL-ENABLED failure paths.
// Offline useModel:false must continue returning the legacy local response directly.
export function isCompatibleLocalFallback(response, context, prepared, originalMessage = "") {
  if (!validPrepared(prepared, context) || !validateNliResponse(response, context, {
    candidateSources: prepared.candidateSources
  }).ok) return false;
  if (!prepared.coveragePossible || !prepared.obligations?.coveragePossible) return false;
  if (response.intent === "navigate") {
    if (prepared.obligations.requiredSubjectIds?.length || prepared.obligations.kind === "comparison") return false;
    if (!prepared.obligations.allowedSourceIds.includes(response.targetId)) return false;
    return responseObligations(response, context, prepared, originalMessage) === null;
  }
  if (response.intent === "define_term") {
    const term = context.termByCanonical.get(normalize(response.term));
    if (response.answer !== term?.answer) return false;
    return responseObligations(response, context, prepared, originalMessage) === null;
  }
  if (response.intent === "reject_out_of_scope") {
    return false;
  }

  if (response.answer && response.answer.length > 4000) return false;
  if (response.targetId && !prepared.obligations.allowedSourceIds.includes(response.targetId)) return false;
  const groups = getObligationSourceGroups(prepared.obligations, context);
  const cards = prepared.candidateSources.filter((card) => !response.targetId || card.id === response.targetId ||
    (context.projectByTargetId.has(response.targetId) && groups.find((group) => group.id === response.targetId)?.sourceIds.includes(card.id)));
  return sourceSubsets(cards.map((card) => card.id)).some((sourceIds) =>
    checkAnswerObligations(response.answer, sourceIds, context, prepared, originalMessage) === null
  );
}



function responseObligations(response, context, prepared, originalMessage) {
  const { obligations } = prepared;
  if (!prepared.coveragePossible || !obligations.coveragePossible) return "coverage_impossible";
  if (obligations.ambiguousTargetIds.length > 1 || obligations.kind === "ambiguity") return "ambiguous_request";
  if (response.intent === "reject_out_of_scope" && obligations.kind === "comparison") return "false_rejection";
  if (response.intent === "navigate") {
    if (/(?:연락처|이메일|contact|email)(?:로|으로)?\s*이동/u.test(originalMessage)) return "intent_mismatch";
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
  }
  if (response.intent === "answer_portfolio") {
    const selected = prepared.candidateSources.filter((card) => response.sources.some((s) => s.id === card.id));
    const projectCardCount = selected.filter((card) => context.targetById.get(card.id)?.type === "project").length;
    const evidence = [
      ...selected.map((card) => card.evidence),
      ...(projectCardCount > 1 ? [`${projectCardCount}개`] : [])
    ].join("\n");
    if (evidence && !quantitiesSupported(response.answer, evidence)) return "quantity_unsupported";
    if (requestedQuantityCount(originalMessage) > 0 || obligations.kind === "comparison") {
      const ids = response.sources.map((source) => source.id);
      if (ids.some((id) => !obligations.allowedSourceIds.includes(id))) return "scope_mismatch";
      return checkAnswerObligations(response.answer, ids, context, prepared, originalMessage);
    }
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
    card && typeof card.evidence === "string" && card.evidence.trim() &&
    Buffer.byteLength(card.evidence, "utf8") <= MAX_GROUNDED_CARD_EVIDENCE_BYTES &&
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
