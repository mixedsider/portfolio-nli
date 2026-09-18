import { assistantIdentityWords, contactWords, profileWords } from "./routing-vocabulary.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { hasSignal, mentionSpans, PARTICLES } from "./obligation-vocabulary.mjs";

const pageModifiers = new Set(["이", "그", "현재", "지금", "보고", "있는", "어떤", "무슨", "전체", "모든",
  "주요", "했던", "진행한", "개발한", "참여한", "내가", "본", "해당", "각", "좀", "the", "all", "this", "current"]);
const anchorSuffixes = [...PARTICLES, "로", "으로", "야", "니", "세요", "해줘", "해주세요"];

// Generic page nouns can stand alone or follow known grammatical modifiers.
// Other prefix words need their own authoritative subject anchor; never a blocklist.
export function isUnqualifiedPageMention(text, match) {
  const words = text.slice(0, match.start).match(/[\p{L}\p{N}_+#]+(?:[.-][\p{L}\p{N}_+#]+)*/gu) || [];
  return words.every((word) => pageModifiers.has(word));
}

export function hasUnknownPageQualifier(text, matches) {
  return [...matches.filter((match) => match.type === "page"), ...anchorMentions(text, ["포트폴리오", "도우미"])]
    .some((match) => !isUnqualifiedPageMention(text, match));
}

function anchorMentions(text, names) {
  return mentionSpans(text, names.map((name) => ({ names: [name] })), anchorSuffixes);
}

function hasUnqualifiedAnchor(text, names) {
  return anchorMentions(text, names).some((match) => isUnqualifiedPageMention(text, match));
}

// Intent authority only: never invent scope IDs or infer authority from retrieved
// cards alone. Generic summary/explanation verbs say how to answer, not what about.
export function hasPortfolioIntentAnchor(text, context, matches, evidenceIndex) {
  const targets = new Map((context.routes?.targets || []).map((target) => [target.id, target]));
  const cards = evidenceIndex.filter((card) => targets.has(card.targetId || card.id) &&
    typeof card.evidence === "string" && card.evidence.trim());
  const available = new Set(cards.map((card) => card.targetId || card.id));
  if (matches.some((match) => available.has(match.id) && (match.type !== "page" || isUnqualifiedPageMention(text, match)))) return true;
  if (available.has("about") && (hasSignal(text, [context.portfolio?.profile?.name, context.portfolio?.profile?.englishName]) ||
    hasUnqualifiedAnchor(text, [...profileWords, ...contactWords]))) return true;
  if (available.has("top") && hasUnqualifiedAnchor(text, ["포트폴리오", "도우미", ...assistantIdentityWords])) return true;

  // A display title's terminal sentence punctuation may be omitted in prose.
  // This recognizes its topic only; strict registered scope matching is unchanged.
  const projectTitles = [...targets.values()].filter((target) => target.type === "project" && available.has(target.id))
    .map((target) => ({ names: [target.label.replace(/[.!?]+$/u, "")] }));
  if (mentionSpans(text, projectTitles).length) return true;
  if (!context.portfolio?.projects || !context.glossary?.terms) return false;
  const skill = findSkillExperienceMatch(text, context);
  if (!skill || !mentionSpans(text, [{ names: skill.matchedKeys }]).length) return false;
  const keys = skill.entryKeys || skill.keys;
  return cards.some((card) => ["project", "section"].includes(targets.get(card.targetId || card.id).type) &&
    hasSignal(card.evidence, keys));
}
