import { clampConfidence } from "./text.mjs";
import { findSkillExperienceEntries, findSkillExperienceMatch } from "./skills.mjs";

export const SAFE_REJECT_MESSAGE = "이 포트폴리오의 프로젝트 이동, 프로젝트 요약, 등록된 용어 설명만 도와드릴 수 있습니다.";

export function navigateResponse(targetId, confidence = 0.85) {
  return {
    intent: "navigate",
    confidence: clampConfidence(confidence),
    targetId,
    message: "해당 위치로 이동합니다."
  };
}

export function defineTermResponse(term, confidence = 0.88) {
  return {
    intent: "define_term",
    confidence: clampConfidence(confidence),
    term: term.term,
    message: `${term.term} 용어를 설명합니다.`,
    answer: term.answer,
    relatedTargets: term.relatedTargets || []
  };
}

export function summarizeSectionResponse(targetId, context, confidence = 0.84) {
  const section = context.sectionById.get(targetId);
  const target = context.targetById.get(targetId);
  if (!section || !target) return navigateResponse(targetId, confidence);

  return {
    intent: "summarize_section",
    confidence: clampConfidence(confidence),
    targetId,
    message: `${target.label} 사례를 요약합니다.`,
    answer: `${section.projectTitle}의 ${section.title} 사례입니다. ${section.result}`
  };
}

export function introduceProfileResponse(context, confidence = 0.94) {
  const profile = context.portfolio.profile;
  return {
    intent: "introduce_profile",
    confidence: clampConfidence(confidence),
    message: "이은성을 소개합니다.",
    answer: `${profile.name}은 ${profile.role}입니다. ${profile.headline}. ${profile.summary}`
  };
}

export function summarizeProjectResponse(targetId, context, confidence = 0.86) {
  const project = context.projectByTargetId.get(targetId);
  const target = context.targetById.get(targetId);
  if (!project || !target) return navigateResponse(targetId, confidence);

  const tags = project.tags.slice(0, 5).join(", ");
  const results = project.sections
    .slice(0, 3)
    .map((section) => section.result)
    .join(" ");

  return {
    intent: "summarize_project",
    confidence: clampConfidence(confidence),
    targetId,
    message: `${project.title} 프로젝트를 요약합니다.`,
    answer: `${project.title}는 ${project.description}입니다. 주요 기술은 ${tags}이며, ${results}`
  };
}

export function listCapabilitiesResponse(confidence = 0.96) {
  return {
    intent: "list_capabilities",
    confidence: clampConfidence(confidence),
    message: "도우미가 할 수 있는 일을 안내합니다.",
    answer:
      "저는 이 포트폴리오 안에서 전체 요약, 목차, 연락처, 주요 성과, 기술별 경험을 안내하고, 프로젝트나 섹션으로 이동하거나 특정 프로젝트와 내부 사례를 요약할 수 있습니다. 예를 들어 '포트폴리오 전체 요약해줘', '주요 성과 알려줘', 'AWS 경험 있어?', 'CateQuest 요약해줘'처럼 물어보면 됩니다."
  };
}

export function listProjectsResponse(context, confidence = 0.93) {
  const answer = context.portfolio.projects
    .map((project) => {
      const highlights = project.sections
        .slice(0, 2)
        .map((section) => section.result)
        .join(" ");
      return `- ${project.title}: ${project.description}. ${highlights}`;
    })
    .join("\n");

  return { intent: "list_projects", confidence: clampConfidence(confidence), message: "진행한 프로젝트 목록을 정리합니다.", answer };
}

export function summarizePortfolioResponse(context, confidence = 0.92) {
  const { profile, projects, metrics } = context.portfolio;
  const projectTitles = projects.map((project) => project.title).join(", ");
  const topMetrics = metrics.slice(0, 3).map(formatMetric).join(", ");

  return {
    intent: "summarize_portfolio",
    confidence: clampConfidence(confidence),
    message: "포트폴리오 전체를 요약합니다.",
    answer: `${profile.name}은 ${profile.role}입니다. ${profile.summary} 대표 프로젝트는 ${projectTitles}이며, 주요 성과는 ${topMetrics}입니다.`
  };
}

export function listTocResponse(context, confidence = 0.93) {
  const projectLines = context.portfolio.projects.map((project) => {
    const sectionTitles = project.sections.map((section) => section.title).join(", ");
    return `- ${project.title}: ${sectionTitles}`;
  });

  return {
    intent: "list_toc",
    confidence: clampConfidence(confidence),
    message: "포트폴리오 목차를 정리합니다.",
    answer: ["홈/프로필, 성과 지표, 프로젝트, About으로 구성되어 있습니다.", ...projectLines].join("\n")
  };
}

export function listContactsResponse(context, confidence = 0.95) {
  return {
    intent: "list_contacts",
    confidence: clampConfidence(confidence),
    message: "연락처를 안내합니다.",
    answer: context.portfolio.profile.contacts.map((contact) => `- ${contact.label}: ${contact.value}`).join("\n")
  };
}

export function listAchievementsResponse(context, confidence = 0.93) {
  return {
    intent: "list_achievements",
    confidence: clampConfidence(confidence),
    message: "주요 성과를 정리합니다.",
    answer: context.portfolio.metrics.map((metric) => `- ${metric.label}: ${formatMetric(metric)}`).join("\n")
  };
}

export function listSkillExperienceResponse(context, match, confidence = 0.88) {
  const skillMatch = typeof match === "string" ? findSkillExperienceMatch(match, context) : match;
  const label = skillMatch?.label || String(match || "").trim();
  const entries = skillMatch ? findSkillExperienceEntries(context, skillMatch) : [];
  if (!label || entries.length === 0) {
    return rejectResponse("이 포트폴리오에서 해당 기술이나 역량과 연결된 경험을 찾지 못했습니다.", 0.5);
  }

  const shownEntries = entries.slice(0, 5);
  const hiddenCount = entries.length - shownEntries.length;
  const lines = shownEntries.map((entry) => {
    if (!entry.section) {
      return `- ${entry.project.title}: ${entry.project.description}. 주요 기술은 ${entry.project.tags.join(", ")}입니다.`;
    }
    return `- ${entry.project.title} / ${entry.section.title}: ${entry.section.result}`;
  });
  const suffix = hiddenCount > 0 ? `\n그 외 ${hiddenCount}개 관련 사례가 더 있습니다.` : "";

  return {
    intent: "list_skill_experience",
    confidence: clampConfidence(confidence),
    term: label,
    message: `${label} 관련 경험을 정리합니다.`,
    answer: `${label} 관련 경험은 다음과 같습니다.\n${lines.join("\n")}${suffix}`
  };
}

export function assistantIdentityResponse(confidence = 0.96) {
  return {
    intent: "list_capabilities",
    confidence: clampConfidence(confidence),
    message: "포트폴리오 도우미를 소개합니다.",
    answer: "저는 포트폴리오 도우미에요. 원하는 자료를 말하시면 이동을 해드리거나, 해당 프로젝트 내용 요약, 등록된 용어를 설명해드릴 수 있어요."
  };
}

export function rejectResponse(message = SAFE_REJECT_MESSAGE, confidence = 1) {
  return { intent: "reject_out_of_scope", confidence: clampConfidence(confidence), message };
}

function formatMetric(metric) {
  return `${metric.value} (${metric.caption})`;
}
