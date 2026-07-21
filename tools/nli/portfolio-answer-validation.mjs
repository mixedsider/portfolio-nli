import { answerPortfolioResponse } from "./responses.mjs";
import { isAnswerSupportedBySelectedEvidence } from "./answer-evidence-support.mjs";
import { buildEvidenceIndex } from "./evidence-cards.mjs";
import { isPlainObject, validateRequiredString } from "./response-contract-validation.mjs";

const sourceKeys = new Set(["id", "label"]);
const MAX_PORTFOLIO_ANSWER_LENGTH = 4_000;
const MAX_TARGET_ID_LENGTH = 128;
const MIN_PORTFOLIO_SOURCES = 1;
const MAX_PORTFOLIO_CANDIDATE_SOURCES = 8;
const MAX_PORTFOLIO_SOURCES = 6;

export function validatePortfolioAnswerCandidateShape(response, context, candidateSources, errors) {
  validateRequiredString(response.answer, "answer", MAX_PORTFOLIO_ANSWER_LENGTH, errors);
  validatePlainTextAnswer(response.answer, errors);

  const candidateSourceMap = validateCandidateSourcePool(candidateSources, context, errors);
  const selectedSourceIds = validatePortfolioSourceIds(response.sourceIds, context, candidateSourceMap, errors);
  validateAnswerSupportedBySelectedSources(response.answer, selectedSourceIds, candidateSourceMap, errors);
}

export function validatePortfolioAnswerCanonicalShape(response, context, candidateSources, errors) {
  validatePlainTextAnswer(response.answer, errors);

  const candidateSourceMap = validateCandidateSourcePool(candidateSources, context, errors);
  const selectedSourceIds = validateCanonicalSources(response.sources, context, candidateSourceMap, errors);
  validateAnswerSupportedBySelectedSources(response.answer, selectedSourceIds, candidateSourceMap, errors);
}

export function canonicalizeValidatedPortfolioAnswerCandidate(candidate, context) {
  return answerPortfolioResponse(candidate.answer, candidate.sourceIds, context, candidate.confidence);
}

function validateCandidateSourcePool(candidateSources, context, errors) {
  const sourceMap = new Map();
  const evidenceByTargetId = new Map(buildEvidenceIndex(context).map((card) => [card.id, card.evidence]));

  if (!Array.isArray(candidateSources)) {
    errors.push("candidateSources must be an array");
    return sourceMap;
  }
  if (candidateSources.length < MIN_PORTFOLIO_SOURCES) {
    errors.push(`candidateSources must contain at least ${MIN_PORTFOLIO_SOURCES} source`);
  }
  if (candidateSources.length > MAX_PORTFOLIO_CANDIDATE_SOURCES) {
    errors.push(`candidateSources must contain at most ${MAX_PORTFOLIO_CANDIDATE_SOURCES} sources`);
  }

  for (const candidateSource of candidateSources) {
    const sourceId = readCandidateSourceId(candidateSource);
    if (!validateRequiredString(sourceId, "candidate sourceId", MAX_TARGET_ID_LENGTH, errors)) continue;
    if (!context.targetById.has(sourceId)) {
      errors.push(`unknown candidate sourceId: ${sourceId}`);
      continue;
    }
    if (sourceMap.has(sourceId)) {
      errors.push("candidateSources must not contain duplicates");
      continue;
    }

    const target = context.targetById.get(sourceId);
    const sourceEvidence = readCandidateSourceEvidence(candidateSource);
    sourceMap.set(sourceId, {
      id: target.id,
      label: target.label,
      evidence: sourceEvidence === undefined ? evidenceByTargetId.get(sourceId) || target.label : sourceEvidence || target.label
    });
  }

  return sourceMap;
}

function validatePortfolioSourceIds(sourceIds, context, candidateSourceMap, errors) {
  const selectedSourceIds = [];
  if (!Array.isArray(sourceIds)) {
    errors.push("sourceIds is required");
    return selectedSourceIds;
  }
  if (sourceIds.length < MIN_PORTFOLIO_SOURCES) {
    errors.push(`sourceIds must contain at least ${MIN_PORTFOLIO_SOURCES} source`);
  }
  if (sourceIds.length > MAX_PORTFOLIO_SOURCES) {
    errors.push(`sourceIds must contain at most ${MAX_PORTFOLIO_SOURCES} sources`);
  }

  const seenSourceIds = new Set();
  for (const sourceId of sourceIds) {
    if (!validateRequiredString(sourceId, "sourceId", MAX_TARGET_ID_LENGTH, errors)) continue;
    if (seenSourceIds.has(sourceId)) {
      errors.push("sourceIds must not contain duplicates");
      continue;
    }
    seenSourceIds.add(sourceId);

    if (!context.targetById.has(sourceId)) {
      errors.push(`unknown sourceId: ${sourceId}`);
    } else if (!candidateSourceMap.has(sourceId)) {
      errors.push(`sourceId is not a candidate source: ${sourceId}`);
    } else {
      selectedSourceIds.push(sourceId);
    }
  }

  return selectedSourceIds;
}

function validateCanonicalSources(sources, context, candidateSourceMap, errors) {
  const selectedSourceIds = [];
  if (!Array.isArray(sources)) {
    errors.push("sources is required");
    return selectedSourceIds;
  }
  if (sources.length < MIN_PORTFOLIO_SOURCES) {
    errors.push(`sources must contain at least ${MIN_PORTFOLIO_SOURCES} source`);
  }
  if (sources.length > MAX_PORTFOLIO_SOURCES) {
    errors.push(`sources must contain at most ${MAX_PORTFOLIO_SOURCES} sources`);
  }

  const seenSourceIds = new Set();
  for (const source of sources) {
    if (!isPlainObject(source)) {
      errors.push("source must be an object");
      continue;
    }
    for (const key of Object.keys(source)) {
      if (!sourceKeys.has(key)) errors.push(`unknown source property: ${key}`);
    }
    if (!validateRequiredString(source.id, "source id", MAX_TARGET_ID_LENGTH, errors)) continue;
    if (seenSourceIds.has(source.id)) {
      errors.push("sources must not contain duplicates");
      continue;
    }
    seenSourceIds.add(source.id);

    const target = context.targetById.get(source.id);
    if (!target) {
      errors.push(`unknown source id: ${source.id}`);
      continue;
    }
    if (!candidateSourceMap.has(source.id)) {
      errors.push(`source id is not a candidate source: ${source.id}`);
    }
    if (source.label !== target.label) {
      errors.push(`source label does not match target: ${source.id}`);
    }
    if (candidateSourceMap.has(source.id) && source.label === target.label) selectedSourceIds.push(source.id);
  }

  return selectedSourceIds;
}

function readCandidateSourceId(candidateSource) {
  if (typeof candidateSource === "string") return candidateSource;
  if (isPlainObject(candidateSource)) return candidateSource.id;
  return undefined;
}

function readCandidateSourceEvidence(candidateSource) {
  return isPlainObject(candidateSource) && Object.hasOwn(candidateSource, "evidence") && typeof candidateSource.evidence === "string"
    ? candidateSource.evidence.trim()
    : undefined;
}

function validateAnswerSupportedBySelectedSources(answer, sourceIds, candidateSourceMap, errors) {
  if (typeof answer !== "string" || !answer.trim() || sourceIds.length === 0) return;

  const evidence = sourceIds.map((sourceId) => candidateSourceMap.get(sourceId)?.evidence || "").join("\n");
  if (!isAnswerSupportedBySelectedEvidence(answer, evidence)) errors.push("answer must be supported by selected sources");
}

function validatePlainTextAnswer(answer, errors) {
  if (typeof answer !== "string" || !answer.trim()) return;
  if (containsHtmlLikeMarkup(answer) || /\[[^\]]+\]\([^)]*\)/.test(answer)) {
    errors.push("answer must be plain text");
  }
  if (/(?:https?:\/\/|www\.)/i.test(answer)) {
    errors.push("answer must not contain a URL");
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(answer)) {
    errors.push("answer must be plain text");
  }
}

function containsHtmlLikeMarkup(value) {
  return /<\s*\/?\s*(?:[a-z][^>]*|!--[\s\S]*?--)>/i.test(value);
}
