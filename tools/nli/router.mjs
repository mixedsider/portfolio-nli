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

const navigateWords = ["보여", "이동", "열어", "가줘", "보고", "찾아", "섹션", "어디"];
const defineWords = ["뭐야", "뜻", "설명", "의미", "알려줘", "무슨"];
const summarizeWords = ["요약", "정리", "뭘 했", "무슨 프로젝트", "간단히"];
const portfolioSummaryWords = ["포트폴리오 전체", "포트폴리오 요약", "포트폴리오를 요약", "포트폴리오 한눈에"];
const projectSummaryWords = ["요약", "정리", "뭐야", "무슨", "어떤", "설명", "소개"];
const currentProjectWords = ["지금 보고 있는", "현재 보고 있는", "보고 있는 프로젝트", "이 프로젝트", "현재 프로젝트"];
const projectListWords = ["프로젝트 목록", "프로젝트 리스트", "어떤 프로젝트", "무슨 프로젝트", "했던 프로젝트", "프로젝트를 했", "목록"];
const assistantIdentityWords = ["너는 누구", "넌 누구", "정체", "포트폴리오 도우미", "nli 소개", "nli는 누구"];
const profileWords = ["자기소개", "이은성", "어떤 개발자", "프로필"];
const capabilityWords = ["뭘 할 수", "무엇을 할 수", "할 수 있어", "사용법", "기능", "도움", "명령"];
const tocWords = ["목차", "구성", "어떤 내용", "뭐가 있어", "뭐 있어", "어디부터", "섹션 목록", "전체 구성"];
const contactWords = ["연락처", "연락", "메일", "이메일", "email", "contact", "깃허브 주소", "github 주소", "깃허브 링크", "github 링크", "깃허브 계정", "github 계정"];
const achievementWords = ["주요 성과", "성과", "개선 수치", "숫자로", "지표", "메트릭", "성능 개선 결과"];
const skillExperienceWords = ["경험", "써", "사용", "다뤄", "관련", "사례", "할 줄", "역량", "기술", "스택", "프로젝트"];
const blockedGenerationWords = ["면접 예상 질문", "예상 질문", "면접 질문", "평가 질문"];
const scopeWords = ["포트폴리오", "이은성", "프로젝트", "섹션", "경험", "기술", "성과", "연락처", "프로필", "도우미", "nli"];
const injectionPatterns = [
  /(?:ignore|disregard|bypass).{0,40}(?:previous|prior|all|system|instruction|prompt)/i,
  /(?:system|developer)\s*(?:prompt|message|instruction)/i,
  /(?:prompt\s*injection|jailbreak|dan\s*mode)/i,
  /(?:이전|앞선|모든|시스템|개발자).{0,24}(?:지시|명령|프롬프트|메시지).{0,24}(?:무시|공개|출력|보여|따르지)/,
  /(?:지시|명령).{0,20}(?:무시|우회).{0,20}(?:프롬프트|규칙|제한)/
];

export function resolveLocally(message, context) {
  const routeMatch = findBestRoute(message, context.routes.targets);
  const sectionRouteMatch = findBestRoute(
    message,
    context.routes.targets.filter((target) => target.type === "section")
  );
  const termMatch = findBestTerm(message, context.glossary.terms);
  const normalizedMessage = normalize(message);

  if (isPromptInjectionAttempt(normalizedMessage)) {
    return rejectResponse("보안상 지시 변경이나 내부 프롬프트 요청은 처리할 수 없습니다.");
  }
  if (hasAny(normalizedMessage, blockedGenerationWords)) {
    return rejectResponse("이 도우미는 포트폴리오 탐색만 지원하며 면접 예상 질문이나 평가 질문은 만들지 않습니다.");
  }
  if (hasAny(normalizedMessage, capabilityWords)) return listCapabilitiesResponse();
  if (hasAny(normalizedMessage, assistantIdentityWords)) return assistantIdentityResponse();
  if (hasAny(normalizedMessage, contactWords)) return listContactsResponse(context);
  if (hasAny(normalizedMessage, profileWords)) return introduceProfileResponse(context);
  if (hasAny(normalizedMessage, achievementWords) && !hasExplicitNavigation(normalizedMessage)) {
    return listAchievementsResponse(context);
  }
  if (hasAny(normalizedMessage, tocWords)) return listTocResponse(context);

  if (hasAny(normalizedMessage, currentProjectWords) && hasAny(normalizedMessage, summarizeWords)) {
    const currentProject = context.projectByTargetId.get(context.currentTargetId);
    if (currentProject) return summarizeProjectResponse(`project-${currentProject.id}`, context, 0.92);
  }
  if (hasAny(normalizedMessage, projectListWords)) return listProjectsResponse(context);
  if (termMatch && hasAny(normalizedMessage, defineWords)) return defineTermResponse(termMatch.term, termMatch.score);

  const skillMatch = findSkillExperienceMatch(normalizedMessage, context);
  if (skillMatch && hasAny(normalizedMessage, skillExperienceWords)) {
    return listSkillExperienceResponse(context, skillMatch, 0.9);
  }
  if (routeMatch && hasAny(normalizedMessage, summarizeWords)) {
    if (sectionRouteMatch && sectionRouteMatch.score >= 0.72) {
      return summarizeSectionResponse(sectionRouteMatch.target.id, context, sectionRouteMatch.score);
    }
    if (routeMatch.target.type === "page") {
      return rejectResponse("요약할 포트폴리오 프로젝트나 사례를 구체적으로 알려주세요.", 0);
    }
    return isProjectTarget(routeMatch.target)
      ? summarizeProjectResponse(routeMatch.target.id, context, routeMatch.score)
      : summarizeSectionResponse(routeMatch.target.id, context, routeMatch.score);
  }
  if (hasAny(normalizedMessage, portfolioSummaryWords)) return summarizePortfolioResponse(context);
  if (routeMatch && isProjectTarget(routeMatch.target) && hasAny(normalizedMessage, projectSummaryWords)) {
    return summarizeProjectResponse(routeMatch.target.id, context, routeMatch.score);
  }
  if (routeMatch && (routeMatch.score >= 0.86 || hasAny(normalizedMessage, navigateWords))) {
    if (routeMatch.target.type === "page" && !hasAny(normalizedMessage, navigateWords)) {
      return rejectResponse("이동할 포트폴리오 위치를 구체적으로 알려주세요.", 0);
    }
    return navigateResponse(routeMatch.target.id, routeMatch.score);
  }
  if (termMatch && termMatch.score >= 0.9) return defineTermResponse(termMatch.term, termMatch.score);
  if (routeMatch) return navigateResponse(routeMatch.target.id, Math.min(routeMatch.score, 0.72));

  return rejectResponse("이 포트폴리오에서 이동하거나 설명할 수 있는 내용을 찾지 못했습니다.", 0);
}

export function isModelEligible(message, context, localResult) {
  const normalizedMessage = normalize(message);
  if (isPromptInjectionAttempt(normalizedMessage)) return false;
  if (localResult.intent !== "reject_out_of_scope" || localResult.confidence > 0) return true;

  return (
    hasAny(normalizedMessage, scopeWords) ||
    Boolean(findBestRoute(message, context.routes.targets)) ||
    Boolean(findBestTerm(message, context.glossary.terms)) ||
    Boolean(findSkillExperienceMatch(message, context))
  );
}

export function isModelIntentGrounded(message, modelResponse, context) {
  const normalizedMessage = normalize(message);
  if (isPromptInjectionAttempt(normalizedMessage)) return false;

  const routeMatch = findBestRoute(message, context.routes.targets);
  const termMatch = findBestTerm(message, context.glossary.terms);
  const skillMatch = findSkillExperienceMatch(message, context);

  switch (modelResponse.intent) {
    case "navigate":
      return Boolean(routeMatch && routeMatch.target.id === modelResponse.targetId && hasAny(normalizedMessage, navigateWords));
    case "define_term":
      return Boolean(termMatch && normalize(termMatch.term.term) === normalize(modelResponse.term) && hasAny(normalizedMessage, defineWords));
    case "summarize_section":
      return Boolean(
        routeMatch && routeMatch.target.id === modelResponse.targetId && hasAny(normalizedMessage, summarizeWords)
      );
    case "summarize_project":
      return Boolean(
        routeMatch &&
          routeMatch.target.id === modelResponse.targetId &&
          isProjectTarget(routeMatch.target) &&
          hasAny(normalizedMessage, projectSummaryWords)
      );
    case "introduce_profile":
      return hasAny(normalizedMessage, profileWords);
    case "list_projects":
      return hasAny(normalizedMessage, projectListWords);
    case "summarize_portfolio":
      return hasAny(normalizedMessage, portfolioSummaryWords);
    case "list_toc":
      return hasAny(normalizedMessage, tocWords);
    case "list_contacts":
      return hasAny(normalizedMessage, contactWords);
    case "list_achievements":
      return hasAny(normalizedMessage, achievementWords);
    case "list_skill_experience":
      return Boolean(
        skillMatch &&
          normalize(skillMatch.label) === normalize(modelResponse.term) &&
          hasAny(normalizedMessage, skillExperienceWords)
      );
    case "list_capabilities":
      return hasAny(normalizedMessage, capabilityWords) || hasAny(normalizedMessage, assistantIdentityWords);
    case "reject_out_of_scope":
      return true;
    default:
      return false;
  }
}

function findBestRoute(message, targets) {
  const normalizedMessage = normalize(message);
  return targets
    .map((target) => ({ target, score: routeScore(normalizedMessage, target) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function routeScore(normalizedMessage, target) {
  const labelScore = keywordScore(normalizedMessage, target.label);
  const aliasScores = (target.aliases || []).map((alias) => keywordScore(normalizedMessage, alias));
  const projectScore = keywordScore(normalizedMessage, target.project) * 0.35;
  const strongScores = [labelScore, ...aliasScores].filter((score) => score > 0);
  const base = Math.max(labelScore, projectScore, ...aliasScores, 0);
  const specificityBonus = strongScores.length > 1 ? 0.12 : 0;
  const projectBonus = projectScore > 0 && strongScores.length ? 0.08 : 0;
  return Math.min(0.98, base + specificityBonus + projectBonus);
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
  return hasAny(normalizedMessage, ["이동", "페이지", "영역", "섹션으로", "위치"]);
}

function isPromptInjectionAttempt(normalizedMessage) {
  return injectionPatterns.some((pattern) => pattern.test(normalizedMessage));
}

function isProjectTarget(target) {
  return target?.type === "project";
}
