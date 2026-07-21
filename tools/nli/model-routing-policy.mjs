import { hasAny, normalize } from "./text.mjs";
import { isPromptInjectionAttempt } from "./prompt-safety.mjs";
import { explicitNavigationPatterns, explicitNavigationWords, explanatoryQuestionWords } from "./routing-vocabulary.mjs";

const broadLocalIntents = new Set([
  "list_skill_experience",
  "introduce_profile",
  "summarize_portfolio",
  "list_capabilities",
  "navigate",
  "reject_out_of_scope"
]);
const broadSynthesisPattern = /(?:\uacbd\ud5d8|\uc0ac\ub840|\uc5ed\ub7c9|\uac15\uc810|\ube44\uad50|\uc885\ud569|\uc804\uccb4|\ud3ec\ud2b8\ud3f4\ub9ac\uc624|\ud504\ub85c\ud544|experience|examples?|strengths?|capabilit|portfolio|profile|compare|overview)/iu;

export function isDirectNavigationRequest(message, localResult) {
  if (localResult?.intent !== "navigate") return false;
  if (typeof localResult.targetId !== "string" || !localResult.targetId.trim()) return false;

  const normalizedMessage = normalize(message);
  return (
    hasExplicitNavigationWording(normalizedMessage) ||
    (localResult.confidence >= 0.86 && isBareTargetReference(normalizedMessage))
  );
}

export function isDependentFollowUp(message) {
  return /(?:\uadf8\uc911|\uadf8\uac83|\uadf8\uac70|\uc774\uac83|\uc774\uac70|\uc55e\uc11c|\ubc29\uae08|\uc704\uc758|which one|that one|those|previous|above|follow[ -]?up)/iu.test(
    normalize(message)
  );
}

export function shouldUseGroundedSynthesis(message, localResult, candidateSources, history = []) {
  if (!Array.isArray(candidateSources) || candidateSources.length === 0) return false;
  if (isPromptInjectionAttempt(message) || isDirectNavigationRequest(message, localResult)) return false;
  if (broadLocalIntents.has(localResult?.intent)) return true;
  if (Array.isArray(history) && history.length > 0 && isDependentFollowUp(message)) return true;

  return broadSynthesisPattern.test(normalize(message));
}

function isBareTargetReference(normalizedMessage) {
  if (!normalizedMessage || hasAny(normalizedMessage, explanatoryQuestionWords)) return false;
  return normalizedMessage.split(/\s+/u).filter(Boolean).length <= 3;
}

function hasExplicitNavigationWording(normalizedMessage) {
  return explicitNavigationPatterns.some((pattern) => pattern.test(normalizedMessage)) ||
    hasAny(normalizedMessage, explicitNavigationWords);
}
