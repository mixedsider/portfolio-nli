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
  "reject_out_of_scope"
]);

const responseKeys = new Set(["intent", "confidence", "targetId", "term", "message", "answer", "relatedTargets"]);
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
  reject_out_of_scope: ["intent", "confidence", "message"]
};

export function validateNliResponse(response, context, options = {}) {
  const errors = [];
  const modelCandidate = options.modelCandidate === true;

  if (!isPlainObject(response)) return { ok: false, errors: ["response must be an object"] };
  for (const key of Object.keys(response)) {
    if (!responseKeys.has(key)) errors.push(`unknown property: ${key}`);
  }

  if (!intentNames.has(response.intent)) errors.push("intent is invalid");
  if (typeof response.confidence !== "number" || response.confidence < 0 || response.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  if (!modelCandidate) validateCanonicalShape(response, errors);
  validateIntentSlots(response, context, errors);
  return { ok: errors.length === 0, errors };
}

export function canonicalizeModelResponse(modelResponse, context) {
  const validation = validateNliResponse(modelResponse, context, { modelCandidate: true });
  if (!validation.ok) return null;

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

function validateCanonicalShape(response, errors) {
  const allowedKeys = canonicalKeysByIntent[response.intent];
  if (!allowedKeys) return;
  for (const key of Object.keys(response)) {
    if (!allowedKeys.includes(key)) errors.push(`${key} is not allowed for ${response.intent}`);
  }
  if (typeof response.message !== "string" || !response.message.trim()) errors.push("message is required");

  if (requiresAnswer(response.intent) && (typeof response.answer !== "string" || !response.answer.trim())) {
    errors.push(`answer is required for ${response.intent}`);
  }
}

function validateIntentSlots(response, context, errors) {
  if (response.intent === "navigate") validateRouteTarget(response.targetId, context, errors);
  if (response.intent === "summarize_section") validateSectionTarget(response.targetId, context, errors);
  if (response.intent === "summarize_project") validateProjectTarget(response.targetId, context, errors);

  if (response.intent === "define_term") {
    if (typeof response.term !== "string" || !response.term.trim()) {
      errors.push("term is required");
    } else if (!context.termByCanonical.has(normalize(response.term))) {
      errors.push(`unknown term: ${response.term}`);
    }
    if (response.relatedTargets !== undefined) validateTargetList(response.relatedTargets, context, errors);
  }

  if (response.intent === "list_skill_experience") {
    if (typeof response.term !== "string" || !response.term.trim()) {
      errors.push("term is required for list_skill_experience");
    } else if (!findSkillExperienceMatch(response.term, context)) {
      errors.push(`unknown skill experience term: ${response.term}`);
    }
  }
}

function requiresAnswer(intent) {
  return intent !== "navigate" && intent !== "reject_out_of_scope";
}

function validateRouteTarget(targetId, context, errors) {
  if (typeof targetId !== "string" || !targetId.trim()) {
    errors.push("targetId is required");
  } else if (!context.targetById.has(targetId)) {
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
  for (const targetId of targets) {
    if (typeof targetId !== "string" || !context.targetById.has(targetId)) {
      errors.push(`unknown related targetId: ${targetId}`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
