import { COMPARISON, COMPOSITION, PARTICLES, hasSignal, mentionSpans, normalizeObligationText, requestWording } from "./obligation-vocabulary.mjs";
import { coverageFits, getObligationSourceGroups, obligationCatalog } from "./obligation-sources.mjs";
import { findSkillExperienceMatch } from "./skills.mjs";
import { hasAssistantIdentityAnchor, hasPortfolioIntentAnchor, hasUnknownPageQualifier, isUnqualifiedPageMention } from "./obligation-intent-anchors.mjs";

export { getObligationSourceGroups } from "./obligation-sources.mjs";

export function analyzeRequestObligations(message, context = {}, evidenceIndex = []) {
  const text = normalizeObligationText(message);
  const wording = requestWording(text);
  const catalog = obligationCatalog(context);
  const available = new Set(evidenceIndex.filter((card) => typeof card.evidence === "string" && card.evidence.trim()).map((card) => card.targetId || card.id));
  const suffixes = wording.navigation ? [...PARTICLES, "로", "으로"] : PARTICLES;
  let matches = mentionSpans(text, catalog.entries, suffixes);
  const projectMatches = matches.filter((match) => match.type === "project");
  const namedProjects = unique(projectMatches.map((match) => match.id));
  // Named projects disambiguate shared aliases, not independent section mentions.
  if (namedProjects.length) matches = matches.filter((match) => match.type !== "section" ||
    namedProjects.includes(catalog.parents.get(match.id)) || !matches.some((other) =>
      other.type === "section" && other.start === match.start && other.end === match.end &&
      namedProjects.includes(catalog.parents.get(other.id))));
  let routeMatches = matches.filter((match) => match.type !== "glossary" &&
    (match.type !== "page" || isUnqualifiedPageMention(text, match)));
  // A glossary mention and a section alias on the same span are one subject,
  // not two. Navigation, however, must resolve actual registered targets.
  const sectionSummary = /(?:요약|정리|\bsummary\b)/u.test(text);
  const hasGlossaryPeer = (match) => matches.some((term) => term.type === "glossary" && term.start === match.start && term.end === match.end);
  if (!wording.navigation && !sectionSummary) routeMatches = routeMatches.filter((match) => !hasGlossaryPeer(match));
  routeMatches = routeMatches.filter((match) => !isCategoryExperienceAlias(match, text, wording, context));
  const collisions = ambiguousMatches(routeMatches);
  const resolved = routeMatches.filter((match) => !collisions.includes(match.id));
  const explicit = resolved.filter((match) => match.type !== "page");
  let scopeIds = unique(explicit.map((match) => match.id));
  if (sectionSummary) scopeIds = scopeIds.filter((id) => !scopeIds.some((other) => other !== id && catalog.parents.get(other) === id));
  let scopeSource = scopeIds.length ? "explicit" : "none";
  if (!scopeIds.length && wording.reference && !hasUnknownPageQualifier(text, matches)) {
    const historyId = wording.current ? null : historyReferent(context.history, catalog);
    const currentId = catalog.targets.some((target) => target.id === context.currentTargetId) ? context.currentTargetId : null;
    const referent = historyId || currentId;
    if (referent) {
      scopeIds = [wording.section ? referent : catalog.parents.get(referent) || referent];
      scopeSource = historyId ? "user_history" : "current_target";
    }
  }
  const requiredProjectIds = unique(scopeIds.map((id) => catalog.parents.get(id)).filter(Boolean));
  const glossaryMatches = matches.filter((match) => match.type === "glossary");
  const glossaryCollisions = ambiguousMatches(glossaryMatches);
  const subjects = unique(glossaryMatches.filter((match) => !glossaryCollisions.includes(match.id)).map((match) => match.id));
  const requiredSubjectIds = unique([...scopeIds.filter((id) => catalog.targets.some((target) => target.id === id && target.type === "section") && !explicit.some((match) => match.id === id && hasGlossaryPeer(match))), ...subjects]);
  const scopedTargets = scopeIds.length ? catalog.targets.filter((target) => scopeIds.some((id) => target.id === id || (catalog.parents.get(id) === id && catalog.parents.get(target.id) === id))) : catalog.targets;
  const allowedSourceIds = scopedTargets.map((target) => target.id);
  const ambiguousTargetIds = unique(collisions.filter((id) => allowedSourceIds.includes(id)));
  const difficultyReasons = [];
  // Signal words inside registered names do not describe the requested operation.
  const operation = text.split("").map((char, offset) => matches.some((match) => offset >= match.start && offset < match.end) ? " " : char).join("");
  if (requiredProjectIds.length >= 2 && hasSignal(operation, COMPARISON)) difficultyReasons.push("comparison");
  if (requiredSubjectIds.length >= 2 && hasSignal(operation, COMPOSITION)) difficultyReasons.push("synthesis");
  const referential = wording.reference || wording.navigation || wording.definition;
  if (referential && ambiguousTargetIds.length >= 2 && ambiguousTargetIds.every((id) => available.has(id))) difficultyReasons.push("ambiguity");
  if (wording.fabrication) difficultyReasons.length = 0;
  const kind = difficultyReasons[0] || "ordinary";
  const anchored = scopeIds.length > 0 || subjects.length > 0 || hasPortfolioIntentAnchor(text, context, matches, evidenceIndex);
  let expectedIntents = ["reject_out_of_scope"];
  if (wording.fabrication || wording.external) expectedIntents = ["reject_out_of_scope"];
  else if (!anchored) expectedIntents = ["reject_out_of_scope"];
  else if (kind === "comparison" || kind === "synthesis") expectedIntents = ["answer_portfolio"];
  else if (anchored && (wording.contextual || hasSignal(operation, COMPOSITION) || hasSignal(operation, COMPARISON))) expectedIntents = ["answer_portfolio"];
  else if (wording.navigation && unique(resolved.map((match) => match.id)).length > 0 && !ambiguousTargetIds.length) expectedIntents = ["navigate"];
  else if (anchored && hasAssistantIdentityAnchor(text)) expectedIntents = ["answer_portfolio"];
  else if (subjects.length && wording.definition && !scopeIds.length && !wording.reference) expectedIntents = ["define_term"];
  else if (anchored && (scopeIds.length || wording.definition || !subjects.length)) expectedIntents = ["answer_portfolio"];
  const result = { kind, difficultyReasons, requiredProjectIds, requiredSubjectIds, allowedSourceIds, expectedIntents, ambiguousTargetIds, coveragePossible: true, scopeSource };
  const groups = getObligationSourceGroups(result, context);
  result.coveragePossible = coverageFits(groups, available) && (ambiguousTargetIds.length === 0 || ambiguousTargetIds.every((id) => available.has(id)));
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function ambiguousMatches(matches) {
  return unique(matches.filter((match) => matches.some((other) => other.id !== match.id && other.start === match.start && other.end === match.end)).map((match) => match.id));
}

function isCategoryExperienceAlias(match, text, wording, context) {
  if (match.type !== "section" || wording.section || !hasSignal(text, ["경험", "사례", "목록", "리스트", "experience", "list"])) return false;
  const mention = text.slice(match.start, match.end);
  const target = context.routes.targets.find((entry) => entry.id === match.id);
  if (normalizeObligationText(target?.label) === mention || !context.portfolio?.projects || !context.glossary?.terms) return false;
  const skill = findSkillExperienceMatch(mention, context);
  return skill?.keys.length > 1 && normalizeObligationText(skill.label) === mention;
}

function historyReferent(history, catalog) {
  let remaining = 2400;
  const bounded = [];
  for (const entry of (Array.isArray(history) ? history : []).slice(-6)) {
    if (!["user", "assistant"].includes(entry?.role) || typeof entry.text !== "string") continue;
    let text = "";
    const limit = Math.min(480, remaining);
    for (const character of entry.text.trim()) {
      if (Buffer.byteLength(text + character, "utf8") > limit) break;
      text += character;
    }
    remaining -= Buffer.byteLength(text, "utf8");
    if (entry.role === "user") bounded.push(text);
  }
  for (const text of bounded.reverse()) {
    const suffixes = requestWording(normalizeObligationText(text)).navigation ? [...PARTICLES, "로", "으로"] : PARTICLES;
    const matches = mentionSpans(text, catalog.entries.filter((entry) => entry.type !== "glossary" && entry.type !== "page"), suffixes);
    if (ambiguousMatches(matches).length) continue;
    const ids = unique(matches.map((match) => match.id));
    if (ids.length === 1) return ids[0];
  }
  return null;
}
