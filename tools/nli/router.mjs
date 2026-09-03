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
import { compact, hasAny, normalize } from "./text.mjs";
import { isPromptInjectionAttempt } from "./prompt-safety.mjs";
import {
  achievementWords,
  assistantIdentityWords,
  blockedGenerationWords,
  capabilityWords,
  contactWords,
  currentProjectWords,
  defineWords,
  explicitNavigationWords,
  navigateWords,
  portfolioSummaryWords,
  profileWords,
  projectListWords,
  projectSummaryWords,
  skillExperienceWords,
  summarizeWords,
  tocWords
} from "./routing-vocabulary.mjs";

export { isPromptInjectionAttempt };
export function resolveLocally(message, context) {
  const normalizedMessage = normalize(message);
  const scopeConstrained = isCurrentProjectScopeConstrained(normalizedMessage, context);
  const routeTargets = scopeConstrained
    ? context.routes.targets.filter((target) => isTargetInCurrentProjectScope(target.id, context))
    : context.routes.targets;
  const routeMatch = findBestRoute(message, routeTargets);
  const termMatch = findBestTerm(message, context.glossary.terms);
  const skillMatch = findSkillExperienceMatch(normalizedMessage, context);

  if (isPromptInjectionAttempt(normalizedMessage)) {
    return rejectResponse("보안상 지시 변경이나 내부 프롬프트 요청은 처리할 수 없습니다.");
  }
  if (hasAny(normalizedMessage, blockedGenerationWords)) {
    return rejectResponse("이 도우미는 포트폴리오 탐색만 지원하며 면접 예상 질문이나 평가 질문은 만들지 않습니다.");
  }
  if (requiresGroundedPortfolioAnswer(normalizedMessage)) return rejectResponse(undefined, 0);
  if (hasAny(normalizedMessage, capabilityWords)) return listCapabilitiesResponse();
  if (hasAny(normalizedMessage, assistantIdentityWords)) return assistantIdentityResponse();
  if (hasAny(normalizedMessage, contactWords)) return listContactsResponse(context);
  if (hasAny(normalizedMessage, profileWords)) return introduceProfileResponse(context);
  if (hasAny(normalizedMessage, achievementWords) && !hasExplicitNavigation(normalizedMessage) &&
      (!hasAny(normalizedMessage, navigateWords) || !hasSpecificRouteContext(normalizedMessage, routeMatch?.target))) {
    return listAchievementsResponse(context);
  }
  if (hasAny(normalizedMessage, tocWords)) return listTocResponse(context);

  const typoProject = findProjectTypo(normalizedMessage, context.routes.targets);
  if (typoProject) return rejectResponse(`${typoProject.label} 프로젝트를 찾으셨나요?`, 0.8);
  if (hasAny(normalizedMessage, projectListWords)) return listProjectsResponse(context);
  if (routeMatch && routeMatch.target.type !== "page" && hasAny(normalizedMessage, summarizeWords)) {
    return isProjectTarget(routeMatch.target)
      ? summarizeProjectResponse(routeMatch.target.id, context, routeMatch.score)
      : summarizeSectionResponse(routeMatch.target.id, context, routeMatch.score);
  }
  if (termMatch && hasAny(normalizedMessage, defineWords)) return defineTermResponse(termMatch.term, termMatch.score);
  if (routeMatch && routeMatch.target.type !== "page" &&
      (hasAny(normalizedMessage, summarizeWords) || hasAny(normalizedMessage, projectSummaryWords))) {
    return isProjectTarget(routeMatch.target)
      ? summarizeProjectResponse(routeMatch.target.id, context, routeMatch.score)
      : summarizeSectionResponse(routeMatch.target.id, context, routeMatch.score);
  }
  if (hasAny(normalizedMessage, currentProjectWords) && hasAny(normalizedMessage, summarizeWords)) {
    const currentProject = context.projectByTargetId.get(context.currentTargetId);
    if (currentProject) return summarizeProjectResponse(`project-${currentProject.id}`, context, 0.92);
  }
  if (routeMatch && (hasAny(normalizedMessage, summarizeWords) || hasAny(normalizedMessage, projectSummaryWords))) {
    return rejectResponse("요약할 포트폴리오 프로젝트나 사례를 구체적으로 알려주세요.", 0);
  }
  if (routeMatch && isProjectTarget(routeMatch.target) && hasExplicitNavigation(normalizedMessage)) {
    return navigateResponse(routeMatch.target.id, routeMatch.score);
  }
  if (skillMatch && isGenericSkillExperienceRequest(normalizedMessage, skillMatch, routeMatch)) {
    return listSkillExperienceResponse(context, skillMatch, 0.9);
  }
  if (skillMatch && hasAny(normalizedMessage, skillExperienceWords) && !hasAny(normalizedMessage, navigateWords)) {
    return listSkillExperienceResponse(context, skillMatch, 0.9);
  }
  if (hasAny(normalizedMessage, portfolioSummaryWords)) return summarizePortfolioResponse(context);
  if (routeMatch && (routeMatch.score >= 0.86 || hasAny(normalizedMessage, navigateWords))) {
    if (routeMatch.target.type === "page" && !hasAny(normalizedMessage, navigateWords)) {
      return rejectResponse("이동할 포트폴리오 위치를 구체적으로 알려주세요.", 0);
    }
    return navigateResponse(routeMatch.target.id, routeMatch.score);
  }
  if (termMatch && termMatch.score >= 0.9) return defineTermResponse(termMatch.term, termMatch.score);
  if (routeMatch) return navigateResponse(routeMatch.target.id, Math.min(routeMatch.score, 0.72));
  if (scopeConstrained) {
    return rejectResponse("현재 보고 있는 프로젝트 안에서 확인할 수 있는 내용을 찾지 못했습니다.", 0.8);
  }

  return rejectResponse("이 포트폴리오에서 이동하거나 설명할 수 있는 내용을 찾지 못했습니다.", 0);
}

export function isCurrentProjectScopeConstrained(message, context) {
  const normalizedMessage = normalize(message);
  return Boolean(
    context.currentTargetId &&
    currentProjectTargetId(context.currentTargetId, context) &&
    hasAny(normalizedMessage, currentProjectWords) &&
    !hasExplicitNamedTarget(normalizedMessage, context.routes.targets)
  );
}

export function isTargetInCurrentProjectScope(targetId, context) {
  const currentProjectId = currentProjectTargetId(context.currentTargetId, context);
  return Boolean(currentProjectId && currentProjectTargetId(targetId, context) === currentProjectId);
}

function findBestRoute(message, targets) {
  const normalizedMessage = normalize(message);
  return targets
    .map((target, order) => createRouteCandidate(normalizedMessage, target, order))
    .filter((candidate) => candidate.matchRank > 0)
    .sort(compareRouteCandidates)[0] || null;
}

function createRouteCandidate(normalizedMessage, target, order) {
  const directKeywords = [target.label, ...(target.aliases || [])];
  const isProjectRootWording = normalizedMessage.includes(normalize("프로젝트")) ||
    (target.project && normalizedMessage.includes(normalize(target.project)));
  const directLabelAliasScore = Math.max(
    ...directKeywords
      .filter((keyword) => !(isProjectRootWording && target.type === "section" && normalize(target.project).includes(normalize(keyword))))
      .map((keyword) => keywordScore(normalizedMessage, keyword)),
    0
  );
  const projectAssociationScore = keywordScore(normalizedMessage, target.project) * 0.35;
  const strongScores = directKeywords
    .map((keyword) => keywordScore(normalizedMessage, keyword))
    .filter((score) => score > 0);
  const base = Math.max(directLabelAliasScore, projectAssociationScore, 0);
  const specificityBonus = strongScores.length > 1 ? 0.12 : 0;
  const projectBonus = projectAssociationScore > 0 && strongScores.length ? 0.08 : 0;
  const matchRank = target.type === "section"
    ? directLabelAliasScore > 0 ? 4 : projectAssociationScore > 0 ? 2 : 0
    : target.type === "project"
      ? directLabelAliasScore > 0 ? 3 : 0
      : directLabelAliasScore > 0 ? 1 : 0;

  return {
    target,
    directLabelAliasScore,
    projectAssociationScore,
    type: target.type,
    order,
    matchRank,
    score: Math.min(0.98, base + specificityBonus + projectBonus)
  };
}

function compareRouteCandidates(left, right) {
  return right.matchRank - left.matchRank || right.score - left.score || left.order - right.order;
}

function findBestTerm(message, terms) {
  const normalizedMessage = normalize(message);
  return terms
    .map((term) => ({
      term,
      score: Math.max(...[term.term, ...(term.aliases || [])].map((key) => keywordScore(normalizedMessage, key)))
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function keywordScore(normalizedMessage, keyword) {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return 0;
  if (normalizedMessage === normalizedKeyword) return 1;
  if (normalizedMessage.includes(normalizedKeyword)) return Math.min(0.95, 0.72 + normalizedKeyword.length / 80);

  const compactMessage = compact(normalizedMessage);
  const compactKeyword = compact(normalizedKeyword);
  return compactMessage.includes(compactKeyword) ? Math.min(0.9, 0.68 + compactKeyword.length / 90) : 0;
}

function hasExplicitNavigation(normalizedMessage) {
  return hasAny(normalizedMessage, explicitNavigationWords);
}

function isProjectTarget(target) {
  return target?.type === "project";
}

function isGenericSkillExperienceRequest(normalizedMessage, skillMatch, routeMatch) {
  return hasAny(normalizedMessage, skillExperienceWords) &&
    normalizedMessage.includes(normalize(skillMatch.label)) &&
    !hasSpecificRouteContext(normalizedMessage, routeMatch?.target, skillMatch.label);
}

function hasSpecificRouteContext(normalizedMessage, target, genericLabel = "") {
  if (!target) return false;
  if (target.type === "page") return normalizedMessage.includes(normalize(target.label));
  const genericWords = new Set(normalize(genericLabel).split(" "));
  return normalize(target.label)
    .split(" ")
    .filter((word) => word.length >= 2 && !genericWords.has(word))
    .some((word) => normalizedMessage.includes(word));
}

function requiresGroundedPortfolioAnswer(normalizedMessage) {
  return normalizedMessage.includes("비교") ||
    normalizedMessage.includes("근거와 함께") ||
    (normalizedMessage.includes("사용한") && normalizedMessage.includes("경험"));
}

function currentProjectTargetId(targetId, context) {
  if (context.projectByTargetId.has(targetId)) return targetId;
  const target = context.targetById.get(targetId);
  if (target?.type !== "section") return null;
  return context.routes.targets.find((candidate) =>
    candidate.type === "project" && candidate.label === target.project
  )?.id || null;
}

function hasExplicitNamedTarget(normalizedMessage, targets) {
  return targets.some((target) => {
    const keywords = target.type === "project"
      ? [target.label, ...(target.aliases || [])]
      : [target.label, ...(target.aliases || []).filter((alias) => compact(normalize(alias)).length >= 4)];
    return keywords.some((keyword) => normalizedMessage.includes(normalize(keyword)));
  });
}

function findProjectTypo(normalizedMessage, targets) {
  const words = normalizedMessage.match(/[a-z0-9]+/giu) || [];
  for (const word of words) {
    if (word.length < 5) continue;
    for (const target of targets) {
      if (target.type !== "project") continue;
      for (const keyword of [target.label, ...(target.aliases || [])]) {
        const candidate = compact(normalize(keyword));
        if (candidate.length < 5 || compact(normalizedMessage).includes(candidate)) continue;
        if (levenshteinDistance(word, candidate) <= 2) return target;
      }
    }
  }
  return null;
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}
