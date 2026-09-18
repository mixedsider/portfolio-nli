import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { rankEvidenceCandidates } from "./evidence-ranking.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { buildGroundedRequestBlock } from "./context.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { hasAny, includesKeyword, normalize } from "./text.mjs";
import { assistantIdentityWords } from "./routing-vocabulary.mjs";
import { assistantIdentityResponse } from "./responses.mjs";
import { mentionSpans } from "./obligation-vocabulary.mjs";
import { boundEvidenceCard, boundedConversation, MAX_GROUNDED_CANDIDATES, MAX_GROUNDED_SOURCES } from "./grounded-bounds.mjs";

/** Prepare once per original request. Both stages and acceptance MUST reuse this
 * candidateSources array, never the full index. Coverage is structural, not entailment.
 * context is trusted loaded data plus validated currentTargetId/history. */
export function prepareGroundedRequest(message, context) {
  const index = buildEvidenceIndex(context);
  const history = boundedConversation(context.history);
  const boundedContext = { ...context, history };
  const obligations = analyzeRequestObligations(message, boundedContext, index);
  const selection = selectEvidenceCandidates(index, { message, history, currentTargetId: context.currentTargetId }, obligations, boundedContext);
  const registry = projectRequestRegistry(context, obligations, selection.candidateSources);
  const groundedRequestBlock = buildGroundedRequestBlock({
    currentTargetId: context.currentTargetId, history,
    candidateSources: selection.candidateSources,
    targets: registry.targets, terms: registry.terms
  });
  const grounded = JSON.parse(groundedRequestBlock);
  const groundedRequest = {
    currentTargetId: grounded.currentTargetId, history: grounded.conversation,
    candidateSources: grounded.candidateSources, targets: grounded.targets, terms: grounded.terms
  };
  return deepFreeze({
    obligations: { ...obligations, coveragePossible: selection.coveragePossible },
    ...selection, candidateSources: grounded.candidateSources, groundedRequest, groundedRequestBlock
  });
}

function projectRequestRegistry(context, obligations, candidateSources) {
  const targets = context.routes.targets;
  const terms = context.glossary.terms;
  const requiredTerms = terms.filter((term) => obligations.requiredSubjectIds.includes(`glossary:${term.term}`));
  const [intent] = obligations.expectedIntents;
  const resolved = obligations.expectedIntents.length === 1 && !obligations.ambiguousTargetIds.length;
  // An unresolved operation may still need any registered navigation/definition.
  if (!resolved || (intent !== "answer_portfolio" && !(intent === "define_term" && requiredTerms.length))) {
    return { targets, terms };
  }
  const ids = new Set([...candidateSources.map((card) => card.id),
    ...obligations.requiredProjectIds, ...obligations.requiredSubjectIds]);
  return {
    targets: targets.filter((target) => ids.has(target.id)).map(({ id, label, type }) => ({ id, label, type })),
    terms: requiredTerms
  };
}

export function selectEvidenceCandidates(index, request, obligations, context) {
  const registered = new Map(context.routes.targets.map((target) => [target.id, target]));
  const allowed = new Set(obligations.allowedSourceIds);
  const seen = new Set();
  const cards = [];
  for (const original of index) {
    const id = original.targetId || original.id;
    const target = registered.get(id);
    if (!target || !allowed.has(id) || seen.has(id)) continue;
    // Rank only what will actually reach the model, not removed tail text.
    const card = boundEvidenceCard({ ...original, targetId: id, label: target.label, type: target.type });
    if (!card?.evidence || card.id !== id) continue;
    seen.add(id);
    Object.defineProperties(card, {
      metricCount: { value: original.metricCount }, scopeKey: { value: original.scopeKey }
    });
    cards.push(card);
  }
  const groups = getObligationSourceGroups(obligations, context);
  // Reuse registered skill vocabulary for retrieval, not local response routing.
  // Page outlines/examples are not technical experience evidence.
  const match = !groups.length && context.portfolio?.projects && context.glossary?.terms
    ? findSkillExperienceMatch(request.message, context) : null;
  const skill = match && mentionSpans(request.message, [{ names: match.matchedKeys }]).length ? match : null;
  const keys = skill?.entryKeys || skill?.matchedKeys || [];
  const relevant = keys.length ? cards.filter((card) => ["project", "section"].includes(card.type) &&
    keys.some((key) => includesKeyword(normalize(card.evidence), key))) : cards;
  // Identity questions need semantic vocabulary, not overlap with their answer.
  // Select evidence only: never create a local response or widen resolved scope.
  const identity = obligations.scopeSource === "none" &&
    hasAny(normalize(request.message), assistantIdentityWords);
  const identityCards = identity ? cards.filter((card) => card.id === "top" &&
    card.evidence.includes(assistantIdentityResponse().answer)) : [];
  const rankedEvidence = identity && !groups.length && !skill ? [] : rankEvidenceCandidates(relevant, {
    message: skill?.entryKeys ? `${request.message} ${skill.entryKeys.join(" ")}` : request.message,
    // Only resolved references may borrow conversational retrieval relevance.
    history: obligations.scopeSource === "user_history" ? boundedConversation(request.history).filter((entry) => entry.role === "user") : [],
    currentTargetId: obligations.scopeSource === "current_target" ? request.currentTargetId : null
  });
  const ranked = [...identityCards, ...rankedEvidence.filter((card) => !identityCards.some((source) => source.id === card.id))];
  const available = new Set(ranked.map((card) => card.id));
  const missingGroupIds = groups.filter((group) => !group.sourceIds.some((id) => available.has(id))).map((group) => group.id);
  const alternatives = groups.map((group) => ranked.filter((card) => group.sourceIds.includes(card.id)).map((card) => card.id));
  const reserved = reserveGroups(alternatives, MAX_GROUNDED_SOURCES);
  const reservedSourceIds = reserved || [];
  const selectedIds = [...new Set([...reservedSourceIds, ...ranked.map((card) => card.id)])].slice(0, MAX_GROUNDED_CANDIDATES);
  const byId = new Map(ranked.map((card) => [card.id, card]));
  const candidateSources = selectedIds.map((id) => byId.get(id));
  const ambiguityCovered = (obligations.ambiguousTargetIds || []).every((id) => selectedIds.includes(id));
  return {
    candidateSources, reservedSourceIds, missingGroupIds,
    coveragePossible: obligations.coveragePossible && reserved !== null && ambiguityCovered
  };
}

function reserveGroups(groups, slots) {
  if (!groups.length) return [];
  if (!slots || groups.some((ids) => !ids.length)) return null;
  const smallest = groups.reduce((left, right) => left.length <= right.length ? left : right);
  for (const id of smallest) {
    const remaining = reserveGroups(groups.filter((ids) => !ids.includes(id)), slots - 1);
    if (remaining !== null) return [id, ...remaining];
  }
  return null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
