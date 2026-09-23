import { isAnswerSupportedBySelectedEvidence } from "./answer-evidence-support.mjs";
import { getObligationSourceGroups, obligationCatalog } from "./obligation-sources.mjs";
import { mentionSpans, normalizeObligationText, PARTICLES, requestedQuantityCount, requestedQuantityUnits } from "./obligation-vocabulary.mjs";
import { readFractionAtom } from "./fraction-atom.mjs";

const ANSWER_SUFFIXES = [...PARTICLES, "에서는", "에서도", "에는", "에선", "도", "로", "으로", "입니다", "이다"];

// Pure lexical checks over the selected, already bounded strings; never retrieve.
export function checkAnswerObligations(answer, sourceIds, context, prepared, originalMessage = "") {
  const { obligations, candidateSources } = prepared;
  const selected = candidateSources.filter((card) => sourceIds.includes(card.id));
  const groups = getObligationSourceGroups(obligations, context);
  const requestedCount = requestedQuantityCount(originalMessage);
  const requestedUnits = requestedQuantityUnits(originalMessage);
  const answerQuantities = parseQuantities(answer).filter((quantity) => quantity.valid &&
    (!requestedUnits.length || requestedUnits.includes(quantity.unit)));
  if (answerQuantities.length < requestedCount)
    return "requested_quantity_missing";
  if (groups.some((group) => !selected.some((card) => group.sourceIds.includes(card.id)))) return "source_group_missing";
  const catalog = obligationCatalog(context);
  const projects = catalog.entries.filter((entry) => entry.type === "project");
  const clauses = splitAttributedClauses(answer, projects);
  const pageAnswer = obligations.kind === "ordinary" && !obligations.requiredProjectIds.length &&
    selected.every((card) => context.targetById.get(card.id)?.type === "page");
  const checked = [];
  for (const clause of clauses) {
    const mentions = answerMentions(clause, projects);
    const projectIds = [...new Set(mentions.map((match) => match.id))];
    if (!pageAnswer && projectIds.length > 1) return "ambiguous_attribution";
    if (obligations.kind === "comparison" && !projectIds.length) return "project_clause_missing";
    const projectId = pageAnswer ? null : projectIds[0] ||
      (obligations.requiredProjectIds.length === 1 ? obligations.requiredProjectIds[0] : null);
    const cards = projectId ? selected.filter((card) => catalog.parents.get(card.id) === projectId) : selected;
    const evidence = cards.map((card) => card.evidence).join("\n");
    const body = pageAnswer ? clause : withoutMentions(clause, mentions);
    if (!hasBody(body) || !supportedClause(body, evidence)) return "clause_unsupported";
    if (!quantitiesSupported(clause, evidence)) return "quantity_unsupported";
    checked.push({ clause, body, projectIds, cards });
  }
  if (!checked.length) return "clause_unsupported";
  if (obligations.kind === "comparison" && obligations.requiredProjectIds.some((id) =>
    !checked.some((entry) => entry.projectIds.includes(id)))) return "project_clause_missing";
  for (const id of obligations.requiredSubjectIds) {
    const subject = catalog.entries.find((entry) => entry.id === id);
    const group = groups.find((entry) => entry.id === id);
    if (!subject || !checked.some(({ clause, cards }) => {
      if (!answerMentions(clause, [subject]).length) return false;
      const evidence = cards.filter((card) => group.sourceIds.includes(card.id)).map((card) => card.evidence).join("\n");
      return evidence.length > 0 && isAnswerSupportedBySelectedEvidence(clause, evidence) && quantitiesSupported(clause, evidence);
    })) return "subject_clause_missing";
  }
  return null;
}

export function quantitiesSupported(claim, evidence) {
  const available = parseQuantities(evidence);
  return parseQuantities(claim).every(({ valid, number, unit }) => valid && available.some((quantity) =>
    quantity.valid && quantity.number === number && (!unit || quantity.unit === unit)));
}

function parseQuantities(value) {
  const ranges = [];
  // Only standalone or explicitly temporal YYYY.MM ~ YYYY.MM ranges are dates.
  // Preserve newlines here: following prose is not a unit, but "2025.11 ms" is.
  const dated = (typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim() : "").replace(
    /(?<![\p{L}\p{N}_.,]|[+\p{Pd}−]\s*)\d{4}\.(?:0[1-9]|1[0-2])\s*~\s*\d{4}\.(?:0[1-9]|1[0-2])(?=$|[\r\n;!?。)\]]|[.,](?:\s|$)|[ \t]+기간(?:에|에는|은|동안)?(?=\s|$|[.,;!?。]))/gu,
    (range) => {
      ranges.push({ valid: true, number: range.replace(/\s+/gu, ""), unit: "calendar-month-range" });
      return " ";
    });
  // Exempt whole technical identifiers, never all digits adjacent to letters/signs.
  const text = normalizeObligationText(dated).replace(
    /(?<![a-z0-9_])(?:p(?:50|90|95|99)|n\+1|1\+n)(?![a-z0-9_%٪‰‱/]|[.+−-]\d)/gu, " ");
  // Scan maximal numeric-looking atoms first. Invalid atoms remain failed obligations
  // instead of disappearing or being retried as unsigned/numeric substrings.
  const starts = /(?:[+\p{Pd}−/⁄∕]\s*)*\.*\p{N}[\p{N}.,]*/gu;
  const scalar = /((?:[+\p{Pd}−]\s*)*\.*\p{N}[\p{N}.,]*)(\s*(?:[a-zμ%٪‰‱][a-zμ0-9%٪‰‱/]*|\/\s*[a-zμ0-9%٪‰‱/]*|[가-힣]+)(?:\s*\/\s*[a-zμ0-9%٪‰‱/]+)*)?/gu;
  const quantities = [...ranges];
  for (let start; (start = starts.exec(text));) {
    const fraction = readFractionAtom(text, start.index);
    if (fraction) {
      quantities.push(fraction);
      starts.lastIndex = fraction.end;
      continue;
    }
    scalar.lastIndex = start.index;
    const match = scalar.exec(text);
    starts.lastIndex = scalar.lastIndex;
    let number = match[1].replace(/\s+/gu, "");
    let unit = (match[2] || "").replace(/\s+/gu, "").replace(/(?:에서|부터|까지|으로|로|의|은|는|을|를)$/u, "");
    // A single sentence/list delimiter is punctuation, not a decimal/group separator.
    if (/[.,]$/u.test(number) && /^(?:\s|$)/u.test(text.slice(match.index + match[1].length))) {
      number = number.slice(0, -1);
      unit = "";
    }
    const valid = /^[+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/u.test(number) &&
      /^(?:[%٪‰‱]|[a-zμ]+(?:\/[a-zμ]+)?|\/[a-zμ]+|[가-힣]+)?$/u.test(unit);
    quantities.push({ valid, number, unit });
  }
  return quantities;
}

function splitAttributedClauses(answer, projects) {
  const text = normalizeObligationText(answer.replace(/[\r\n]/gu, ";"));
  const names = answerMentions(text, projects);
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(/[;；!?。！？]+|\.(?=\s|$)/gu)) {
    if (names.some((name) => match.index >= name.start && match.index < name.end)) continue;
    sentences.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  sentences.push(text.slice(start));
  return sentences.flatMap((sentence) => splitJoinedProjects(sentence, projects)).map((clause) => clause.trim()).filter(Boolean);
}

function splitJoinedProjects(sentence, projects) {
  const pieces = [];
  let start = 0;
  for (const match of sentence.matchAll(/[,，]\s*|\s+(?:and|while|whereas|but|그리고|반면|또한)\s+/gu)) {
    const left = sentence.slice(start, match.index);
    const right = sentence.slice(match.index + match[0].length);
    const leftNames = answerMentions(left, projects);
    if (!leftNames.length || !answerMentions(right, projects).length || !hasBody(withoutMentions(left, leftNames))) continue;
    pieces.push(left);
    start = match.index + match[0].length;
  }
  pieces.push(sentence.slice(start));
  return pieces;
}

function withoutMentions(clause, mentions) {
  return clause.split("").map((char, offset) => mentions.some((name) => offset >= name.start && offset < name.end) ? " " : char)
    .join("").trim().replace(new RegExp(`^(?:${ANSWER_SUFFIXES.join("|")})(?=\\s|$)`, "u"), "").trim();
}

function answerMentions(clause, entries) {
  return mentionSpans(clause, entries, ANSWER_SUFFIXES);
}

function hasBody(body) {
  return /[\p{L}\p{N}]{2}/u.test(body);
}

function supportedClause(clause, evidence) {
  if (isAnswerSupportedBySelectedEvidence(clause, evidence)) return true;
  // Legacy canonical summaries contain comma-separated exact tags (e.g. JPA).
  // Model answers still pass the unchanged strict validator before this helper.
  const parts = clause.split(/[,，]/u).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((part) => {
    const tag = part.replace(/(?:이며|이고)$/u, "");
    return isAnswerSupportedBySelectedEvidence(part, evidence) ||
      (/^[\p{L}\p{N}+# -]+$/u.test(tag) && hasBody(tag) &&
        new RegExp(`(?<![\\p{L}\\p{N}])${escape(tag)}(?![\\p{L}\\p{N}])`, "u").test(normalizeObligationText(evidence)));
  });
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
