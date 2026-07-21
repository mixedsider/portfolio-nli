import {
  canonicalizeGeneralModelResponse,
  isPlainObject,
  validateResponseContract
} from "./response-contract-validation.mjs";
import {
  canonicalizeValidatedPortfolioAnswerCandidate,
  validatePortfolioAnswerCandidateShape,
  validatePortfolioAnswerCanonicalShape
} from "./portfolio-answer-validation.mjs";

export function validateNliResponse(response, context, options = {}) {
  const errors = [];
  const modelCandidate = options.modelCandidate === true;

  if (!isPlainObject(response)) return { ok: false, errors: ["response must be an object"] };
  validateResponseContract(response, context, errors, modelCandidate);

  if (response.intent === "answer_portfolio") {
    if (modelCandidate) {
      validatePortfolioAnswerCandidateShape(response, context, options.candidateSources, errors);
    } else {
      validatePortfolioAnswerCanonicalShape(response, context, options.candidateSources, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validatePortfolioAnswerCandidate(candidate, context, candidateSources) {
  return validateNliResponse(candidate, context, { modelCandidate: true, candidateSources });
}

export function canonicalizePortfolioAnswerCandidate(candidate, context, candidateSources) {
  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);
  if (!validation.ok) return null;
  return canonicalizeValidatedPortfolioAnswerCandidate(candidate, context);
}

export function canonicalizeModelResponse(modelResponse, context, options = {}) {
  const validation = validateNliResponse(modelResponse, context, {
    modelCandidate: true,
    candidateSources: options.candidateSources
  });
  if (!validation.ok) return null;

  if (modelResponse.intent === "answer_portfolio") {
    return canonicalizeValidatedPortfolioAnswerCandidate(modelResponse, context);
  }
  return canonicalizeGeneralModelResponse(modelResponse, context);
}
