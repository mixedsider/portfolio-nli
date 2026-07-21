import { normalize } from "./text.mjs";

export function buildEvidenceIndex(context) {
  const targets = uniqueTargets(context?.routes?.targets);
  if (targets.length === 0) return [];

  const targetIds = new Set(targets.map((target) => target.id));
  const portfolio = asRecord(context?.portfolio);
  const projects = asArray(portfolio.projects).filter(isRecord);
  const metricsByTargetId = groupMetrics(portfolio.metrics, targetIds);
  const glossaryByTargetId = groupGlossary(context?.glossary?.terms, targetIds);
  const partsByTargetId = new Map();
  const scopeByTargetId = new Map(targets.map((target) => [target.id, target.id]));

  for (const target of targets) {
    partsByTargetId.set(target.id, [routeEvidence(target)]);
  }

  appendProfile(partsByTargetId, portfolio.profile, targetIds);
  appendMetricsPage(partsByTargetId, portfolio.metrics, targetIds);

  for (const project of projects) {
    const projectTargetId = `project-${stringValue(project.id)}`;
    const projectText = projectEvidence(project);

    if (targetIds.has(projectTargetId)) {
      appendEvidence(partsByTargetId, projectTargetId, projectText);
      scopeByTargetId.set(projectTargetId, projectTargetId);
    }

    for (const section of asArray(project.sections).filter(isRecord)) {
      const sectionId = stringValue(section.id);
      if (!targetIds.has(sectionId)) continue;

      appendEvidence(partsByTargetId, sectionId, projectText, sectionEvidence(section));
      scopeByTargetId.set(sectionId, projectTargetId || sectionId);
    }
  }

  for (const [targetId, metrics] of metricsByTargetId) {
    appendEvidence(partsByTargetId, targetId, metrics.map(metricEvidence));
  }

  for (const [targetId, terms] of glossaryByTargetId) {
    appendEvidence(partsByTargetId, targetId, terms.map(glossaryEvidence));
  }

  return targets.map((target, order) => createEvidenceCard({
    target,
    order,
    evidence: joinEvidence(partsByTargetId.get(target.id)),
    metricCount: metricsByTargetId.get(target.id)?.length || 0,
    scopeKey: scopeByTargetId.get(target.id) || target.id
  }));
}

export function tokenizeEvidence(value) {
  return (normalize(value).match(/[\p{L}\p{N}+#.]+/gu) || []).filter((token) => Array.from(token).length >= 2);
}

function createEvidenceCard({ target, order, evidence, metricCount, scopeKey }) {
  const card = {
    id: target.id,
    targetId: target.id,
    label: stringValue(target.label),
    type: stringValue(target.type),
    evidence
  };

  Object.defineProperties(card, {
    metricCount: { value: metricCount, enumerable: false },
    order: { value: order, enumerable: false },
    scopeKey: { value: scopeKey, enumerable: false },
    searchText: { value: normalize(evidence), enumerable: false },
    tokenSet: { value: new Set(tokenizeEvidence(evidence)), enumerable: false }
  });

  return Object.freeze(card);
}

function uniqueTargets(value) {
  const seen = new Set();
  const targets = [];

  for (const target of asArray(value).filter(isRecord)) {
    const id = stringValue(target.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    targets.push({ ...target, id });
  }

  return targets;
}

function groupMetrics(value, targetIds) {
  const grouped = new Map();

  for (const metric of asArray(value).filter(isRecord)) {
    const targetId = stringValue(metric.target);
    if (!targetIds.has(targetId)) continue;
    const metrics = grouped.get(targetId) || [];
    metrics.push(metric);
    grouped.set(targetId, metrics);
  }

  return grouped;
}

function groupGlossary(value, targetIds) {
  const grouped = new Map();

  for (const term of asArray(value).filter(isRecord)) {
    for (const targetId of asArray(term.relatedTargets).map(stringValue)) {
      if (!targetIds.has(targetId)) continue;
      const terms = grouped.get(targetId) || [];
      terms.push(term);
      grouped.set(targetId, terms);
    }
  }

  return grouped;
}

function appendProfile(partsByTargetId, profile, targetIds) {
  if (!isRecord(profile) || !targetIds.has("about")) return;
  appendEvidence(partsByTargetId, "about", profile.name, profile.englishName, profile.role, profile.headline, profile.summary);
}

function appendMetricsPage(partsByTargetId, metrics, targetIds) {
  if (!targetIds.has("metrics")) return;
  appendEvidence(partsByTargetId, "metrics", asArray(metrics).filter(isRecord).map(metricEvidence));
}

function appendEvidence(partsByTargetId, targetId, ...parts) {
  const existing = partsByTargetId.get(targetId);
  if (!existing) return;
  existing.push(...parts);
}

function routeEvidence(target) {
  return joinEvidence(target.label, target.aliases, target.description, target.project);
}

function projectEvidence(project) {
  return joinEvidence(project.title, project.period, project.description, project.tags, project.focus);
}

function sectionEvidence(section) {
  return joinEvidence(
    section.title,
    section.result,
    section.problem,
    section.analyze,
    section.action,
    section.resultDetails,
    asArray(section.tables).flatMap((table) => (isRecord(table) ? [table.caption, table.headers, table.rows] : []))
  );
}

function metricEvidence(metric) {
  return joinEvidence(metric.label, metric.value, metric.caption);
}

function glossaryEvidence(term) {
  return joinEvidence(term.term, term.aliases, term.answer);
}

function joinEvidence(...parts) {
  return parts.flat(Infinity).flatMap(textParts).filter(Boolean).join("\n");
}

function textParts(value) {
  if (typeof value === "string") return [value.trim()];
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textParts);
  return [];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
