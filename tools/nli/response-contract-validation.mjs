import {
  assistantIdentityResponse,
  defineTermResponse,
  introduceProfileResponse,
  listAchievementsResponse,
  listCapabilitiesResponse,
  listContactsResponse,
  listProjectsResponse,
  listSkillExperienceResponse,
  listTocResponse,
  navigateResponse,
  rejectResponse,
  summarizePortfolioResponse,
  summarizeProjectResponse,
  summarizeSectionResponse
} from "./responses.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { normalize } from "./text.mjs";

const intentNames = new Set([
  "navigate",
  "define_term",
  "summarize_section",
  "introduce_profile",
  "summarize_project",
  "list_projects",
  "summarize_portfolio",
  "list_toc",
  "list_contacts",
  "list_achievements",
  "list_skill_experience",
  "list_capabilities",
  "answer_portfolio",
  "reject_out_of_scope"
]);

const responseKeys = new Set(["intent", "confidence", "targetId", "term", "message", "answer", "relatedTargets", "sources"]);
const modelDecisionKeys = new Set(["intent", "confidence", "targetId", "term"]);
const answerPortfolioCandidateKeys = new Set(["intent", "confidence", "answer", "sourceIds"]);
const MAX_MESSAGE_LENGTH = 500;
const MAX_ANSWER_LENGTH = 12_000;
const MAX_PORTFOLIO_ANSWER_LENGTH = 4_000;
const MAX_TARGET_ID_LENGTH = 128;
const MAX_TERM_LENGTH = 128;
const MAX_RELATED_TARGETS = 20;
const canonicalKeysByIntent = {
  navigate: ["intent", "confidence", "targetId", "message"],
  define_term: ["intent", "confidence", "term", "message", "answer", "relatedTargets"],
  summarize_section: ["intent", "confidence", "targetId", "message", "answer"],
  introduce_profile: ["intent", "confidence", "message", "answer"],
  summarize_project: ["intent", "confidence", "targetId", "message", "answer"],
  list_projects: ["intent", "confidence", "message", "answer"],
  summarize_portfolio: ["intent", "confidence", "message", "answer"],
  list_toc: ["intent", "confidence", "message", "answer"],
  list_contacts: ["intent", "confidence", "message", "answer"],
  list_achievements: ["intent", "confidence", "message", "answer"],
  list_skill_experience: ["intent", "confidence", "term", "message", "answer"],
  list_capabilities: ["intent", "confidence", "message", "answer"],
  answer_portfolio: ["intent", "confidence", "answer", "sources"],
  reject_out_of_scope: ["intent", "confidence", "message"]
};

export function validateResponseContract(response, context, errors, modelCandidate) {
  const allowedKeys = modelCandidate
    ? response.intent === "answer_portfolio"
      ? answerPortfolioCandidateKeys
      : modelDecisionKeys
    : responseKeys;
  for (const key of Object.keys(response)) {
    if (!allowedKeys.has(key)) errors.push(`unknown property: ${key}`);
  }

  if (!intentNames.has(response.intent)) errors.push("intent is invalid");
  if (!Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  if (!modelCandidate) validateCanonicalShape(response, errors);
  validateIntentSlots(response, context, errors, { canonicalResponse: !modelCandidate });
}

export function canonicalizeGeneralModelResponse(modelResponse, context) {
  switch (modelResponse.intent) {
    case "navigate":
      return navigateResponse(modelResponse.targetId, modelResponse.confidence);
    case "define_term":
      return defineTermResponse(context.termByCanonical.get(normalize(modelResponse.term)), modelResponse.confidence);
    case "summarize_section":
      return summarizeSectionResponse(modelResponse.targetId, context, modelResponse.confidence);
    case "introduce_profile":
      return introduceProfileResponse(context, modelResponse.confidence);
    case "summarize_project":
      return summarizeProjectResponse(modelResponse.targetId, context, modelResponse.confidence);
    case "list_projects":
      return listProjectsResponse(context, modelResponse.confidence);
    case "summarize_portfolio":
      return summarizePortfolioResponse(context, modelResponse.confidence);
    case "list_toc":
      return listTocResponse(context, modelResponse.confidence);
    case "list_contacts":
      return listContactsResponse(context, modelResponse.confidence);
    case "list_achievements":
      return listAchievementsResponse(context, modelResponse.confidence);
    case "list_skill_experience":
      return listSkillExperienceResponse(context, modelResponse.term, modelResponse.confidence);
    case "list_capabilities":
      return listCapabilitiesResponse(modelResponse.confidence);
    case "reject_out_of_scope":
      return rejectResponse();
    default:
      return null;
  }
}

export function validateRequiredString(value, label, maxLength, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} is required`);
    return false;
  }
  if (value.length > maxLength) {
    errors.push(`${label} must be at most ${maxLength} characters`);
    return false;
  }
  return true;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCanonicalShape(response, errors) {
  const allowedKeys = canonicalKeysByIntent[response.intent];
  if (!allowedKeys) return;
  for (const key of allowedKeys) {
    if (!Object.hasOwn(response, key)) errors.push(`${key} is required for ${response.intent}`);
  }
  for (const key of Object.keys(response)) {
    if (!allowedKeys.includes(key)) errors.push(`${key} is not allowed for ${response.intent}`);
  }

  if (response.intent !== "answer_portfolio") {
    validateRequiredString(response.message, "message", MAX_MESSAGE_LENGTH, errors);
  }

  if (response.intent === "answer_portfolio") {
    validateRequiredString(response.answer, "answer", MAX_PORTFOLIO_ANSWER_LENGTH, errors);
  } else if (requiresAnswer(response.intent)) {
    validateRequiredString(response.answer, "answer", MAX_ANSWER_LENGTH, errors);
  }
}

function validateIntentSlots(response, context, errors, options) {
  if (response.intent === "navigate") validateRouteTarget(response.targetId, context, errors);
  if (response.intent === "summarize_section") validateSectionTarget(response.targetId, context, errors);
  if (response.intent === "summarize_project") validateProjectTarget(response.targetId, context, errors);

  if (response.intent === "define_term") {
    validateKnownTerm(response.term, context, "term", errors);
    if (options.canonicalResponse) validateTargetList(response.relatedTargets, context, errors);
  }

  if (response.intent === "list_skill_experience") {
    if (!validateRequiredString(response.term, "term", MAX_TERM_LENGTH, errors)) return;
    if (!findSkillExperienceMatch(response.term, context)) {
      errors.push(`unknown skill experience term: ${response.term}`);
    }
  }
}

function requiresAnswer(intent) {
  return intent !== "navigate" && intent !== "reject_out_of_scope";
}

function validateRouteTarget(targetId, context, errors) {
  if (!validateRequiredString(targetId, "targetId", MAX_TARGET_ID_LENGTH, errors)) return;
  if (!context.targetById.has(targetId)) {
    errors.push(`unknown targetId: ${targetId}`);
  }
}

function validateSectionTarget(targetId, context, errors) {
  validateRouteTarget(targetId, context, errors);
  if (typeof targetId === "string" && !context.sectionById.has(targetId)) {
    errors.push(`targetId is not a section: ${targetId}`);
  }
}

function validateProjectTarget(targetId, context, errors) {
  validateRouteTarget(targetId, context, errors);
  if (typeof targetId === "string" && !context.projectByTargetId.has(targetId)) {
    errors.push(`targetId is not a project: ${targetId}`);
  }
}

function validateTargetList(targets, context, errors) {
  if (!Array.isArray(targets)) {
    errors.push("relatedTargets must be an array");
    return;
  }
  if (targets.length > MAX_RELATED_TARGETS) {
    errors.push(`relatedTargets must contain at most ${MAX_RELATED_TARGETS} targets`);
  }
  for (const targetId of targets) {
    if (!validateRequiredString(targetId, "related targetId", MAX_TARGET_ID_LENGTH, errors)) continue;
    if (!context.targetById.has(targetId)) {
      errors.push(`unknown related targetId: ${targetId}`);
    }
  }
}

function validateKnownTerm(term, context, label, errors) {
  if (!validateRequiredString(term, label, MAX_TERM_LENGTH, errors)) return;
  if (!context.termByCanonical.has(normalize(term))) errors.push(`unknown term: ${term}`);
}
