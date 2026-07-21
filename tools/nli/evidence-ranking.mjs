import { tokenizeEvidence } from "./evidence-cards.mjs";
import { normalize } from "./text.mjs";

export const MAX_EVIDENCE_CANDIDATES = 8;
export const MAX_EVIDENCE_HISTORY_ITEMS = 6;

const MAX_HISTORY_ENTRY_CHARS = 480;
const MAX_HISTORY_CHARS = 2_400;
const MAX_MESSAGE_CHARS = 1_200;
const BROAD_QUERY_SCORE = 3;
const DIRECT_METRIC_BONUS = 7;
const performanceTerms = new Set(["performance", "성능"]);
const optimizationTerms = new Set(["개선", "단축", "줄", "줄인", "최적", "최적화", "튜닝", "optimization", "optimize", "reduced"]);
const optimizationEvidencePattern =
  /(?:개선|단축|줄(?:였|인|였습니다|임)|최적화|튜닝|전환해|reduc|optimi|tuning)/i;

export function retrieveEvidenceCandidates(index, request = {}) {
  const cards = asArray(index).filter(isEvidenceCard);
  const message = boundedText(request?.message, MAX_MESSAGE_CHARS);
  const history = boundedHistory(request?.history);
  const messageTerms = searchTerms(message);
  const historyTerms = history.map((entry) => searchTerms(entry.text));
  const allTerms = new Set([...messageTerms, ...historyTerms.flat()]);

  if (allTerms.size === 0) return [];

  const scored = cards.map((card, order) => {
    const messageScore = scoreTerms(card, messageTerms);
    const historyScore = scoreHistory(card, historyTerms);
    return { card, order, semanticScore: messageScore + historyScore };
  });
  const strongestScore = Math.max(...scored.map((candidate) => candidate.semanticScore), 0);
  const hasBroadQuery = allTerms.size >= 3 && strongestScore >= BROAD_QUERY_SCORE;
  const matchedAnchors = [...allTerms].filter(
    (term) => isTechnicalAnchor(term) && cards.some((card) => scoreTerms(card, [term]) > 0)
  );
  const requiresOptimizationEvidence = isPerformanceOptimizationQuery(allTerms);
  const currentTargetId = stringValue(request?.currentTargetId);
  const currentCard = cards.find((card) => card.targetId === currentTargetId) || null;

  return scored
    .map((candidate) => scoreCandidate(candidate, { currentCard, hasBroadQuery, matchedAnchors, requiresOptimizationEvidence }))
    .filter(Boolean)
    .sort(compareCandidates)
    .slice(0, MAX_EVIDENCE_CANDIDATES)
    .map(({ card }) => publicCard(card));
}

function scoreCandidate(candidate, { currentCard, hasBroadQuery, matchedAnchors, requiresOptimizationEvidence }) {
  const { card, semanticScore } = candidate;
  if (matchedAnchors.length && !matchedAnchors.some((term) => scoreTerms(card, [term]) > 0)) return null;
  if (requiresOptimizationEvidence && !hasOptimizationEvidence(card)) return null;

  const structuralScore = hasBroadQuery ? metricCount(card) * DIRECT_METRIC_BONUS : 0;
  if (semanticScore <= 0 && structuralScore <= 0) return null;

  let score = semanticScore + structuralScore;
  if (semanticScore > 0 && currentCard) {
    if (card.targetId === currentCard.targetId) score += 2;
    else if (scopeKey(card) === scopeKey(currentCard)) score += 0.35;
  }

  return { card, order: candidate.order, score };
}

function boundedHistory(value) {
  if (!Array.isArray(value)) return [];

  const selected = value.slice(-MAX_EVIDENCE_HISTORY_ITEMS);
  const history = [];
  let remaining = MAX_HISTORY_CHARS;

  for (let index = selected.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = selected[index];
    if (!isRecord(entry) || !["user", "assistant"].includes(entry.role) || typeof entry.text !== "string") continue;

    const text = boundedText(entry.text, Math.min(MAX_HISTORY_ENTRY_CHARS, remaining));
    if (!normalize(text)) continue;
    history.push({ text });
    remaining -= text.length;
  }

  return history.reverse();
}

function boundedText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function scoreHistory(card, histories) {
  return histories.reduce((score, terms, index) => {
    const recencyWeight = 0.12 + (0.12 * (index + 1)) / histories.length;
    return score + scoreTerms(card, terms) * recencyWeight;
  }, 0);
}

function scoreTerms(card, terms) {
  if (!terms.length) return 0;

  const text = searchText(card);
  const tokens = tokenSet(card);
  let score = 0;

  for (const term of terms) {
    const weight = 0.7 + Math.min(Array.from(term).length, 8) * 0.35;
    if (tokens.has(term)) score += weight;
    else if (text.includes(term)) score += weight * 0.45;
  }

  return score;
}

function searchTerms(value) {
  const terms = new Set();

  for (const token of tokenizeEvidence(value)) {
    terms.add(token);
    if (!/^[\uAC00-\uD7A3]+$/u.test(token)) continue;

    const characters = Array.from(token);
    for (let length = 2; length < characters.length; length += 1) {
      terms.add(characters.slice(0, length).join(""));
    }
  }

  return [...terms];
}

function isTechnicalAnchor(term) {
  return /^[a-z0-9+#.]{2,}$/i.test(term);
}

function isPerformanceOptimizationQuery(terms) {
  const termList = [...terms];
  return termList.some((term) => performanceTerms.has(term)) && termList.some((term) => hasOptimizationTerm(term));
}

function hasOptimizationTerm(term) {
  return optimizationTerms.has(term) || [...optimizationTerms].some((keyword) => term.includes(keyword));
}

function hasOptimizationEvidence(card) {
  return optimizationEvidencePattern.test(searchText(card));
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.order !== right.order) return left.order - right.order;
  return left.card.targetId < right.card.targetId ? -1 : left.card.targetId > right.card.targetId ? 1 : 0;
}

function publicCard(card) {
  return {
    id: card.targetId,
    targetId: card.targetId,
    label: stringValue(card.label),
    type: stringValue(card.type),
    evidence: stringValue(card.evidence)
  };
}

function metricCount(card) {
  return Number.isInteger(card.metricCount) && card.metricCount > 0 ? card.metricCount : 0;
}

function scopeKey(card) {
  return stringValue(card.scopeKey) || card.targetId;
}

function searchText(card) {
  return typeof card.searchText === "string" ? card.searchText : normalize(card.evidence);
}

function tokenSet(card) {
  return card.tokenSet instanceof Set ? card.tokenSet : new Set(tokenizeEvidence(card.evidence));
}

function isEvidenceCard(value) {
  return isRecord(value) && Boolean(stringValue(value.targetId)) && typeof value.evidence === "string";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
