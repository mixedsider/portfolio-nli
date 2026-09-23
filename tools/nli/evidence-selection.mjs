import { buildEvidenceIndex, tokenizeEvidence } from "./evidence-cards.mjs";
import { rankEvidenceCandidates } from "./evidence-ranking.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { buildGroundedRequestBlock } from "./context.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { hasAny, includesKeyword, normalize } from "./text.mjs";
import { assistantIdentityWords } from "./routing-vocabulary.mjs";
import { assistantIdentityResponse } from "./responses.mjs";
import { mentionSpans, PARTICLES, requestedQuantityCount } from "./obligation-vocabulary.mjs";
import { boundEvidenceCard, boundedConversation, boundedUtf8String, MAX_GROUNDED_CANDIDATES,
  MAX_GROUNDED_SOURCES } from "./grounded-bounds.mjs";

const MAX_PROJECT_SUMMARY_EVIDENCE_BYTES = 1_100;

/** Prepare once per original request. Both stages and acceptance MUST reuse this
 * candidateSources array, never the full index. Coverage is structural, not entailment.
 * context is trusted loaded data plus validated currentTargetId/history. */
export function prepareGroundedRequest(message, context) {
  const index = buildEvidenceIndex(context);
  const history = boundedConversation(context.history);
  const boundedContext = { ...context, history };
  const obligations = analyzeRequestObligations(message, boundedContext, index);
  const selection = selectEvidenceCandidates(index, { message, history, currentTargetId: context.currentTargetId }, obligations, boundedContext);
  const candidateSources = projectCandidateSources(selection, obligations, context, message);
  const registry = projectRequestRegistry(context, obligations, candidateSources, selection.candidateSources, message);
  const groundedRequestBlock = buildGroundedRequestBlock({
    currentTargetId: context.currentTargetId, history,
    candidateSources,
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

function projectCandidateSources(selection, obligations, context, message) {
  const candidates = selection.candidateSources;
  if (obligations.expectedIntents.length !== 1 || obligations.ambiguousTargetIds.length) return candidates;
  const [intent] = obligations.expectedIntents;
  if (intent === "navigate" || intent === "reject_out_of_scope") return [];
  const byId = new Map(candidates.map((card) => [card.id, card]));
  const reserved = selection.reservedSourceIds.map((id) => byId.get(id)).filter(Boolean);
  if (intent === "define_term") {
    const definition = context.glossary?.terms?.find((term) =>
      obligations.requiredSubjectIds.includes(`glossary:${term.term}`));
    if (!definition) return reserved.slice(0, 1);
    const evidence = `${definition.term}\n${definition.answer}`;
    return reserved.slice(0, 1).map((card) => ({ ...card,
      evidence: boundedUtf8String(evidence, MAX_PROJECT_SUMMARY_EVIDENCE_BYTES) }));
  }
  const groups = getObligationSourceGroups(obligations, context);
  const explicitSection = groups.some((group) => obligations.requiredSubjectIds.includes(group.id) &&
    group.sourceIds.length === 1 && context.targetById.get(group.sourceIds[0])?.type === "section");
  if (["comparison", "synthesis"].includes(obligations.kind)) return reserved.map((card) => {
    const comparisonEvidence = card.comparisonEvidence || card.summaryEvidence || card.evidence;
    const quantitative = requestedQuantityCount(message) > 0;
    const evidence = obligations.kind === "synthesis" || quantitative ? card.summaryEvidence || comparisonEvidence : comparisonEvidence;
    const comparisonLabel = comparisonEvidence.split("\n", 2)[1];
    return { ...card, label: comparisonLabel || card.label,
      evidence: boundedUtf8String(evidence, MAX_PROJECT_SUMMARY_EVIDENCE_BYTES) };
  });
  if (explicitSection) return reserved.map((card) => {
    const detail = card.detailEvidence || card.summaryEvidence || card.evidence;
    const requested = requestedIdentifierEvidence(message, card.evidence, context);
    return { ...card, evidence: boundedUtf8String([detail, requested].filter(Boolean).join("\n"), MAX_PROJECT_SUMMARY_EVIDENCE_BYTES) };
  });
  if (obligations.requiredProjectIds.length === 1 && obligations.requiredSubjectIds.length === 0) {
    const root = byId.get(obligations.requiredProjectIds[0]);
    const projectCards = root ? [root, ...candidates.filter((card) => card.id !== root.id)] : candidates;
    return projectCards.map((card) => {
      const overview = card.overviewEvidence || card.summaryEvidence || card.evidence;
      const requested = requestedIdentifierEvidence(message, card.evidence, context);
      return { ...card, evidence: boundedUtf8String([overview, requested].filter(Boolean).join("\n"), MAX_PROJECT_SUMMARY_EVIDENCE_BYTES) };
    });
  }
  return candidates;
}

function requestedIdentifierEvidence(message, evidence, context) {
  const projects = new Set((context.portfolio?.projects || []).map((project) => normalize(project?.title || "")));
  const identifiers = [...new Set((message.match(/[A-Za-z][A-Za-z0-9_$@./<>+-]{2,}/g) || [])
    .filter((identifier) => !projects.has(normalize(identifier))))];
  if (!identifiers.length) return "";
  return evidence.split("\n").filter((line) => identifiers.some((identifier) =>
    line.toLowerCase().includes(identifier.toLowerCase()))).join("\n");
}

function projectRequestRegistry(context, obligations, candidateSources, selectedCandidates, message) {
  const targets = context.routes.targets;
  const terms = context.glossary.terms;
  const requiredTerms = terms.filter((term) => obligations.requiredSubjectIds.includes(`glossary:${term.term}`))
    .map(({ term }) => ({ term }));
  const [intent] = obligations.expectedIntents;
  const resolved = obligations.expectedIntents.length === 1 && !obligations.ambiguousTargetIds.length;
  if (!resolved) return { targets, terms };
  if (intent === "reject_out_of_scope") return { targets: [], terms: [] };
  if (intent === "navigate") {
    const targetId = resolvedNavigationTargetId(context, obligations, selectedCandidates, message);
    const target = targets.find((entry) => entry.id === targetId);
    return { targets: target ? [compactTarget(target)] : [], terms: [] };
  }
  if (intent === "define_term") return { targets: [], terms: requiredTerms };
  if (["comparison", "synthesis"].includes(obligations.kind)) return { targets: [], terms: requiredTerms };
  const ids = new Set(candidateSources.map((card) => card.id));
  return {
    targets: targets.filter((target) => ids.has(target.id)).map(compactTarget),
    terms: requiredTerms
  };
}

function resolvedNavigationTargetId(context, obligations, selectedCandidates, message) {
  const mentioned = [...new Set(mentionSpans(message, context.routes.targets.map((target) => ({
    id: target.id, names: [target.label, ...(target.aliases || [])]
  })), [...PARTICLES, "로", "으로"]).map((match) => match.id))];
  if (mentioned.length === 1) return mentioned[0];
  const subjectSources = getObligationSourceGroups(obligations, context)
    .filter((group) => obligations.requiredSubjectIds.includes(group.id))
    .flatMap((group) => group.sourceIds);
  const uniqueSubjects = [...new Set(subjectSources)];
  if (uniqueSubjects.length === 1) return uniqueSubjects[0];
  if (!uniqueSubjects.length && obligations.requiredProjectIds.length === 1) return obligations.requiredProjectIds[0];
  const allowedTargets = context.routes.targets.filter((target) => obligations.allowedSourceIds.includes(target.id));
  if (allowedTargets.length === 1) return allowedTargets[0].id;
  return selectedCandidates.find((card) => obligations.allowedSourceIds.includes(card.id))?.id;
}

function compactTarget({ id, label, type }) {
  return { id, label, type };
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
    const searchEvidence = `${card.evidence}\n${original.searchAliases || ""}`;
    Object.defineProperties(card, {
      metricCount: { value: original.metricCount }, scopeKey: { value: original.scopeKey },
      summaryEvidence: { value: original.summaryEvidence },
      overviewEvidence: { value: original.overviewEvidence },
      comparisonEvidence: { value: original.comparisonEvidence },
      detailEvidence: { value: original.detailEvidence },
      searchText: { value: normalize(searchEvidence) }, tokenSet: { value: new Set(tokenizeEvidence(searchEvidence)) }
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
