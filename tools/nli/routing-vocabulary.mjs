export const navigateWords = ["보여", "이동", "열어", "가줘", "보고", "찾아", "섹션", "어디"];
export const explicitNavigationPatterns = [
  /(?:보여|이동(?:해)?|열어|가\s*줘|찾아\s*줘|바로\s*가)(?:줘|요|주세요|라)?/u,
  /\b(?:open|show|navigate|go\s*to|take\s+me)\b/iu
];
export const explicitNavigationWords = ["이동", "페이지", "영역", "섹션으로", "위치", "보고"];
export const defineWords = ["뭐야", "뜻", "설명", "의미", "알려줘", "무슨"];
export const summarizeWords = ["요약", "정리", "뭘 했", "무슨 프로젝트", "간단히"];
export const portfolioSummaryWords = ["포트폴리오 전체", "포트폴리오 요약", "포트폴리오를 요약", "포트폴리오 한눈에"];
export const projectSummaryWords = ["요약", "정리", "뭐야", "무슨", "어떤", "설명", "소개"];
export const currentProjectWords = ["지금 보고 있는", "현재 보고 있는", "보고 있는 프로젝트", "이 프로젝트", "현재 프로젝트"];
export const projectListWords = ["프로젝트 목록", "프로젝트 리스트", "어떤 프로젝트", "무슨 프로젝트", "했던 프로젝트", "프로젝트를 했", "목록"];
export const assistantIdentityWords = ["너는 누구", "넌 누구", "정체", "포트폴리오 도우미", "nli 소개", "nli는 누구"];
export const profileWords = ["자기소개", "이은성", "어떤 개발자", "프로필"];
export const capabilityWords = ["뭘 할 수", "무엇을 할 수", "할 수 있어", "사용법", "기능", "도움", "명령"];
export const tocWords = ["목차", "구성", "어떤 내용", "뭐가 있어", "뭐 있어", "어디부터", "섹션 목록", "전체 구성"];
export const contactWords = ["연락처", "연락", "메일", "이메일", "email", "contact", "깃허브 주소", "github 주소", "깃허브 링크", "github 링크", "깃허브 계정", "github 계정"];
export const achievementWords = ["주요 성과", "성과", "개선 수치", "숫자로", "지표", "메트릭", "성능 개선 결과"];
export const skillExperienceWords = ["경험", "써", "사용", "다뤄", "관련", "사례", "할 줄", "역량", "기술", "스택", "프로젝트"];
export const explanatoryQuestionWords = [
  ...defineWords,
  ...summarizeWords,
  ...skillExperienceWords,
  "어디서",
  "어디에",
  "어떻게",
  "왜",
  "언제",
  "누가",
  "무엇",
  "사례",
  "비교",
  "강점",
  "전체",
  "구체"
];
export const blockedGenerationWords = ["면접 예상 질문", "예상 질문", "면접 질문", "평가 질문"];
export const scopeWords = ["포트폴리오", "이은성", "프로젝트", "섹션", "경험", "기술", "성과", "연락처", "프로필", "도우미", "nli"];
