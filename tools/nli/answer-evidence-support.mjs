import { tokenizeEvidence } from "./evidence-cards.mjs";
import { normalize } from "./text.mjs";

const genericAnswerTerms = new Set([
  "answer",
  "claim",
  "claims",
  "evidence",
  "experience",
  "grounded",
  "portfolio",
  "strongest",
  "가진",
  "경험",
  "근거",
  "기반",
  "내용",
  "답변",
  "대한",
  "사례",
  "선택",
  "설명",
  "정리",
  "통해",
  "포트폴리오",
  "했습니다"
]);

export function isAnswerSupportedBySelectedEvidence(answer, evidence) {
  const evidenceText = normalize(evidence);
  const evidenceTokens = new Set(tokenizeEvidence(evidence));
  const claimTermGroups = splitAnswerClaims(answer)
    .map((claim) => meaningfulTerms(claim))
    .filter((terms) => terms.length > 0);

  return (
    claimTermGroups.length > 0 &&
    claimTermGroups.every((terms) => claimSupportedByEvidence(terms, evidenceText, evidenceTokens))
  );
}

function splitAnswerClaims(answer) {
  return String(answer)
    .split(/[\n\r]+|[!?]+|\.(?=\s|$)|[。！？]+|[;；]+/u)
    .flatMap(splitWeakClaimBoundaries)
    .map((claim) => claim.trim())
    .filter(Boolean);
}

function splitWeakClaimBoundaries(claim) {
  const pieces = [];
  const weakBoundaryPattern = /\s+and\s+|[,，]\s*/giu;
  let startIndex = 0;

  for (const match of claim.matchAll(weakBoundaryPattern)) {
    const boundaryIndex = match.index;
    const nextIndex = boundaryIndex + match[0].length;
    const left = claim.slice(startIndex, boundaryIndex);
    const right = claim.slice(nextIndex);

    if (shouldSplitJoinedClaim(left, right)) {
      pieces.push(left);
      startIndex = nextIndex;
    }
  }

  pieces.push(claim.slice(startIndex));
  return pieces;
}

function shouldSplitJoinedClaim(left, right) {
  const leftTerms = meaningfulTerms(left);
  const rightTerms = meaningfulTerms(right);
  return leftTerms.length >= 3 && rightTerms.length >= 4 && hasClauseSignal(right);
}

function hasClauseSignal(claim) {
  return /\b(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|can|could|should)\b/i.test(claim) ||
    /[\uAC00-\uD7A3](?:다|요|니다|습니다)[\s.!?。！？,;]*$/u.test(claim);
}

function claimSupportedByEvidence(terms, evidenceText, evidenceTokens) {
  const supportedTerms = terms.filter((term) => termSupportedByEvidence(term, evidenceText, evidenceTokens));
  const anchors = terms.filter(isAnswerAnchor);
  const supportedAnchors = anchors.filter((term) => termSupportedByEvidence(term, evidenceText, evidenceTokens));

  if (hasUnsupportedAnchorIsland(terms, evidenceText, evidenceTokens)) return false;
  if (isConciseTechnicalClaim(terms, anchors) && supportedAnchors.length < anchors.length) return false;
  if (supportedAnchors.length >= 2) return true;
  if (supportedAnchors.length >= 1 && supportedTerms.length >= 3) return true;
  return anchors.length === 0 && supportedTerms.length >= Math.min(3, terms.length);
}

function hasUnsupportedAnchorIsland(terms, evidenceText, evidenceTokens) {
  let unsupportedAnchors = 0;
  for (const term of terms) {
    if (!isAnswerAnchor(term) || termSupportedByEvidence(term, evidenceText, evidenceTokens)) {
      unsupportedAnchors = 0;
      continue;
    }
    unsupportedAnchors += 1;
    if (unsupportedAnchors >= 3) return true;
  }
  return false;
}

function meaningfulTerms(value) {
  return tokenizeEvidence(value).filter((term) => !genericAnswerTerms.has(term));
}

function isConciseTechnicalClaim(terms, anchors) {
  return terms.length <= 4 && anchors.length >= 2 && anchors.length === terms.length;
}

function termSupportedByEvidence(term, evidenceText, evidenceTokens) {
  if (evidenceTokens.has(term)) return true;
  if (/^[a-z0-9+#.]+$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(term)}($|[^a-z0-9+#.])`, "i").test(evidenceText);
  }
  if (/^[\uAC00-\uD7A3]+$/u.test(term)) {
    return koreanTermVariants(term).some((variant) => evidenceTokens.has(variant) || evidenceText.includes(variant));
  }
  return evidenceText.includes(term);
}

function koreanTermVariants(term) {
  const suffixes = ["으로", "에서", "에게", "부터", "까지", "처럼", "보다", "하고", "과", "와", "을", "를", "은", "는", "이", "가"];
  return suffixes
    .filter((suffix) => term.endsWith(suffix) && term.length > suffix.length + 1)
    .map((suffix) => term.slice(0, -suffix.length));
}

function isAnswerAnchor(term) {
  return /[0-9+#.]/.test(term) || /^[a-z]{2,}$/i.test(term) || /^[\uAC00-\uD7A3]{3,}$/u.test(term);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
