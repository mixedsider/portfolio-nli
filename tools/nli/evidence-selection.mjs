import { buildEvidenceIndex, tokenizeEvidence, measurementPairEvidence } from "./evidence-cards.mjs";
import { rankEvidenceCandidates } from "./evidence-ranking.mjs";
import { analyzeRequestObligations, getObligationSourceGroups } from "./request-obligations.mjs";
import { buildGroundedRequestBlock } from "./context.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { hasAny, includesKeyword, normalize } from "./text.mjs";
import { assistantIdentityWords } from "./routing-vocabulary.mjs";
import { assistantIdentityResponse } from "./responses.mjs";
import { registerPreparedDecision } from "./decision-schema.mjs";
import { mentionSpans, PARTICLES, requestedQuantityCount } from "./obligation-vocabulary.mjs";
import { boundEvidenceCard, boundedConversation, boundedUtf8String, MAX_GROUNDED_CANDIDATES,
  MAX_GROUNDED_SOURCES, MAX_GROUNDED_CARD_EVIDENCE_BYTES } from "./grounded-bounds.mjs";

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
  const allIntents = Object.freeze(["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"]);
  registerPreparedDecision(groundedRequest, { ...obligations, expectedIntents: allIntents, coveragePossible: selection.coveragePossible }, context);
  return deepFreeze({
    obligations: { ...obligations, expectedIntents: allIntents, coveragePossible: selection.coveragePossible },
    ...selection, candidateSources: grounded.candidateSources, groundedRequest, groundedRequestBlock
  });
}

const CORE_CARD_IDS = Object.freeze([
  "top",
  "projects",
  "metrics",
  "about",
  "project-makertion",
  "project-catequest",
  "project-bookking"
]);

function projectCandidateSources(selection, obligations, context, message) {
  const candidates = selection.candidateSources.map((card) => card.id === "about"
    ? { ...card, evidence: experienceEvidence(message, context) || card.evidence } : card);
  const byId = new Map(candidates.map((card) => [card.id, card]));
  const reserved = selection.reservedSourceIds.map((id) => byId.get(id)).filter(Boolean);
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
    const detail = sectionRequestEvidence(card, message, context) || card.detailEvidence || card.summaryEvidence || card.evidence;
    const requested = requestedIdentifierEvidence(message, card.evidence, context);
    return { ...card, evidence: boundedUtf8String([detail, requested].filter(Boolean).join("\n"), MAX_GROUNDED_CARD_EVIDENCE_BYTES) };
  });
  if (obligations.requiredProjectIds.length === 1 && obligations.requiredSubjectIds.length === 0) {
    const root = byId.get(obligations.requiredProjectIds[0]);
    const projectCards = root ? [root, ...candidates.filter((card) => card.id !== root.id)] : candidates;
    return projectCards.map((card) => {
      const overview = sectionRequestEvidence(card, message, context) || card.overviewEvidence || card.summaryEvidence || card.evidence;
      const requested = requestedIdentifierEvidence(message, card.evidence, context);
      return { ...card, evidence: boundedUtf8String([overview, requested].filter(Boolean).join("\n"), card.type === "section" ? MAX_GROUNDED_CARD_EVIDENCE_BYTES : MAX_PROJECT_SUMMARY_EVIDENCE_BYTES) };
    });
  }
  return candidates;
}

// Choose complete repository-owned records before applying the existing byte
// bound. A late experience record must not disappear behind the profile text.
function experienceEvidence(message, context) {
  const experience = context.portfolio?.experience;
  if (!experience) return "";
  const groups = [
    [/(?:멘토|mentoring)/iu, [experience.mentoring]],
    [/(?:학력|교육|졸업|대학|KDT)/iu, experience.education],
    [/(?:수상|상장|경진대회|우수상)/iu, experience.awards],
    [/(?:자격|SQLD|정보처리|네트워크관리)/iu, experience.certifications],
    [/(?:도구|tools|개인 개발)/iu, experience.tools]
  ];
  const toolMatches = (experience.tools || []).filter((tool) =>
    [tool.title, tool.title.replace(/ 수정$/u, "")].some((title) => normalize(message).includes(normalize(title))));
  const groupMatches = groups.filter(([pattern]) => pattern.test(message) &&
    (!toolMatches.length || pattern.source !== "(?:도구|tools|개인 개발)")).flatMap(([, records]) => records || []);
  const records = [...new Set([...toolMatches, ...groupMatches])];
  if (!records.length) return "";
  return completeLines([context.portfolio.profile?.name, "추가 경험", ...records.flatMap((record) =>
    record ? [record.title, record.period, record.summary, record.href] : [])], MAX_GROUNDED_CARD_EVIDENCE_BYTES);
}

function sectionRequestEvidence(card, message, context) {
  const section = context.sectionById?.get(card.id);
  if (!section) return "";
  const tables = (section.tables || []).flatMap((table) => [table.caption, table.headers?.join(" · "),
    ...(table.rows || []).map((row) => row.join(" · "))]);
  const examples = section.examples || [];
  const wantsExamples = /(?:예시|예제|출력|생성한 질문)/u.test(message);
  const wantsTables = /(?:표|비교|조건|처리량|수치|지표|결과)/u.test(message);
  const identifiers = message.match(/[A-Za-z][A-Za-z0-9_$+.-]{1,}/g) || [];
  const requestedActions = (section.action || []).flatMap((line) => line.split(/(?<=[.!?])\s+/u))
    .filter((line) => identifiers.some((identifier) => line.toLowerCase().includes(identifier.toLowerCase())));
  const route = context.targetById.get(card.id);
  const requestedRoute = identifiers.some((identifier) => route?.description?.toLowerCase().includes(identifier.toLowerCase()))
    ? route.description : "";
  return completeLines([section.projectTitle, section.title, section.result, ...(section.measurementNotes || []), ...measurementPairEvidence(section), requestedRoute, ...requestedActions,
    ...(wantsExamples ? examples : []), ...(wantsTables ? tables : []), ...(section.action || []),
    ...(!wantsExamples ? examples : []), ...(!wantsTables ? tables : [])], MAX_GROUNDED_CARD_EVIDENCE_BYTES);
}

function completeLines(lines, maxBytes) {
  let result = "";
  for (const line of lines.filter((line) => typeof line === "string" && line.trim())) {
    const next = result ? `${result}\n${line.trim()}` : line.trim();
    if (Buffer.byteLength(next, "utf8") <= maxBytes) result = next;
  }
  return result;
}

function requestedIdentifierEvidence(message, evidence, context) {
  const projects = new Set((context.portfolio?.projects || []).map((project) => normalize(project?.title || "")));
  const targetAliases = new Set((context.routes?.targets || []).flatMap((t) => [t.label, ...(t.aliases || [])]).map(normalize));
  const identifiers = [...new Set((message.match(/[A-Za-z][A-Za-z0-9_$@./<>+-]{2,}/g) || [])
    .filter((identifier) => !projects.has(normalize(identifier)) && !targetAliases.has(normalize(identifier))))];
  if (!identifiers.length) return "";
  return evidence.split("\n").filter((line) => identifiers.some((identifier) =>
    line.toLowerCase().includes(identifier.toLowerCase()))).join("\n");
}

function projectRequestRegistry(context) {
  return {
    targets: context.routes.targets,
    terms: context.glossary.terms
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
    const projected = target.type === "section" ? sectionRequestEvidence({ id }, request.message, context) : "";
    const card = boundEvidenceCard({ ...original, evidence: projected || original.evidence, targetId: id, label: target.label, type: target.type });
    if (!card?.evidence || card.id !== id) continue;
    seen.add(id);
    const searchEvidence = `${card.evidence}\n${target.label}\n${(target.aliases || []).join("\n")}\n${original.searchAliases || ""}`;
    Object.defineProperties(card, {
      metricCount: { value: original.metricCount }, scopeKey: { value: original.scopeKey },
      titleText: { value: `${target.label}\n${(target.aliases || []).join("\n")}` },
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
  const allowedSkillTypes = skill && !skill.entryKeys ? ["section"] : ["project", "section"];
  const matchedSkillCards = keys.length ? cards.filter((card) => allowedSkillTypes.includes(card.type) &&
    keys.some((key) => includesKeyword(normalize(card.evidence), key))) : cards;
  // Project tags remain authoritative stack evidence when no specific case
  // names that technology. Never substitute a generic page outline.
  const relevant = keys.length && !matchedSkillCards.length ? cards.filter((card) => card.type === "project" &&
    keys.some((key) => includesKeyword(normalize(card.evidence), key))) : matchedSkillCards;
  // Identity questions need semantic vocabulary, not overlap with their answer.
  // Select evidence only: never create a local response or widen resolved scope.
  const identity = obligations.scopeSource === "none" &&
    hasAny(normalize(request.message), [...assistantIdentityWords, "도움말", "사용법"]);
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
