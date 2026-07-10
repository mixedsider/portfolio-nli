import { includesKeyword, normalize, searchableText } from "./text.mjs";

const skillGroups = [
  { label: "AWS", keys: ["AWS", "인프라", "Infra", "ECS", "EC2", "ALB", "Route 53", "ACM", "CloudWatch", "NAT Gateway"] },
  { label: "Redis/Valkey", keys: ["Redis", "Valkey", "Redis Lock", "Redisson"] },
  { label: "성능 최적화", keys: ["성능", "최적화", "Performance", "튜닝", "응답", "지연", "부하 테스트"] },
  { label: "CI/CD", keys: ["CI/CD", "CI", "CD", "배포", "파이프라인", "GitHub Actions", "Runner"] },
  {
    label: "데이터 모델링",
    keys: ["데이터 모델링", "Data Modeling", "데이터 정규화", "중복", "MongoDB", "식별자", "Aggregation"],
    entryKeys: ["Data Modeling", "데이터 정규화", "중복", "MongoDB", "식별자", "Aggregation"]
  },
  { label: "AI/LLM", keys: ["AI", "LLM", "AI 모델", "파인튜닝", "질문 생성", "PyTorch", "Claude"] },
  { label: "Backend", keys: ["Backend", "백엔드", "Spring Boot", "Node.js", "API", "Java"] },
  { label: "JPA/Query Tuning", keys: ["JPA", "쿼리", "N+1", "JPQL", "DTO Projection", "지연 로딩"] },
  { label: "Observability", keys: ["관측", "관측성", "모니터링", "CloudWatch", "Application Signals"] },
  { label: "동시성", keys: ["동시성", "분산 락", "락", "Lock", "재고", "트랜잭션", "Redisson"] }
];

export function findSkillExperienceMatch(message, context) {
  const normalizedMessage = normalize(message);

  for (const group of skillGroups) {
    const matchedKeys = group.keys.filter((key) => includesKeyword(normalizedMessage, key));
    if (matchedKeys.length) return { ...group, matchedKeys };
  }

  for (const term of collectSkillTerms(context)) {
    if (includesKeyword(normalizedMessage, term)) return { label: term, keys: [term], matchedKeys: [term] };
  }

  return null;
}

export function findSkillExperienceEntries(context, skillMatch) {
  const entries = [];
  const keys = skillMatch.entryKeys?.length
    ? skillMatch.entryKeys
    : skillMatch.matchedKeys?.length
      ? skillMatch.matchedKeys
      : [skillMatch.label, ...skillMatch.keys];

  for (const project of context.portfolio.projects) {
    const projectText = searchableText(project.title, project.description, project.tags, project.focus);
    const projectMatches = keys.some((key) => includesKeyword(projectText, key));
    const sectionEntries = [];

    for (const section of project.sections) {
      const sectionText = searchableText(
        section.title,
        section.result,
        section.problem,
        section.analyze,
        section.action,
        section.impact
      );

      if (keys.some((key) => includesKeyword(sectionText, key))) {
        sectionEntries.push({ project, section });
      }
    }

    if (sectionEntries.length) {
      entries.push(...sectionEntries.slice(0, 2));
    } else if (projectMatches) {
      entries.push({ project, section: null });
    }
  }

  return entries;
}

function collectSkillTerms(context) {
  const terms = new Set();

  for (const project of context.portfolio.projects) {
    for (const tag of project.tags || []) terms.add(tag);
    for (const focus of project.focus || []) terms.add(focus);
  }

  for (const glossaryTerm of context.glossary.terms) {
    terms.add(glossaryTerm.term);
    for (const alias of glossaryTerm.aliases || []) terms.add(alias);
  }

  return [...terms].filter((term) => normalize(term).length >= 2);
}
