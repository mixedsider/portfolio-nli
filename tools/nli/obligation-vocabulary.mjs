export const PARTICLES = ["에서", "은", "는", "이", "가", "을", "를", "와", "과", "의"];
export const COMPARISON = ["비교", "차이", "공통점", "대조", "compare", "difference", "versus", "vs"];
export const COMPOSITION = ["종합", "연결", "연관", "통합", "트레이드오프", "trade-off", "synthesize", "combine"];
export const ALL_INTENTS = ["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"];
const WORD = /[\p{L}\p{N}_+#]/u;
const SIGNAL_ENDINGS = [...PARTICLES, "해줘", "해주세요", "해", "하기", "하여", "하고", "해서", "해줄래", "점"];

export function normalizeObligationText(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ") : "";
}

export function mentionSpans(message, entries, suffixes = PARTICLES) {
  const text = normalizeObligationText(message);
  const matches = [];
  for (const entry of entries) {
    for (const name of new Set(entry.names.map(normalizeObligationText).filter(Boolean))) {
      let start = text.indexOf(name);
      while (start !== -1) {
        const end = start + name.length;
        const rest = text.slice(end);
        const right = !WORD.test(rest[0] || "") || suffixes.some((suffix) => rest.startsWith(suffix) && !WORD.test(rest[suffix.length] || ""));
        if (!WORD.test(text[start - 1] || "") && right) matches.push({ ...entry, start, end });
        start = text.indexOf(name, start + 1);
      }
    }
  }
  return matches.filter((match) => !matches.some((other) => other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
}

export function hasSignal(text, words) {
  return mentionSpans(text, words.map((name) => ({ names: [name] })), SIGNAL_ENDINGS).length > 0;
}

export function requestWording(text) {
  return {
    reference: /(?:^|\s)(?:그(?:\s|것|거)|이 프로젝트|현재 프로젝트|지금 보고 있는|현재 보고 있는)/u.test(text),
    current: /(?:현재 프로젝트|지금 보고 있는|현재 보고 있는|이 프로젝트)/u.test(text),
    section: /섹션/u.test(text),
    navigation: /(?:이동|보여줘|보여주세요|열어줘|\b(?:navigate|open|show|go to)\b)/u.test(text),
    definition: /(?:뭐야|무엇|뜻|의미|설명|정의|\b(?:define|meaning|what is)\b)/u.test(text),
    contextual: /(?:왜|어떻게|줄였|개선|사용|적용|구현|해결|경험|사례|요약|정리|프로필|자기소개|이은성|연락|메일|목록|리스트|성과|기술|스택|할 수|\b(?:why|how|summary|experience|list)\b)/u.test(text),
    fabrication: /(?:지어내|날조|조작해|없는.{0,20}(?:만들어|꾸며)|\b(?:fabricate|invent unsupported)\b)/u.test(text)
  };
}
