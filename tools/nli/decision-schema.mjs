import { readFileSync } from "node:fs";
import { getObligationSourceGroups } from "./obligation-sources.mjs";
import { boundedString } from "./grounded-bounds.mjs";

let schema;
const preparedDecisions = new WeakMap();

export class PreparedDecisionUnavailableError extends Error {
  constructor(coverageImpossible = false) {
    super("No authorized prepared decision branches");
    this.name = "PreparedDecisionUnavailableError";
    this.coverageImpossible = coverageImpossible;
  }
}

// Immutable per-process snapshot. A schema file change requires a fresh process;
// proof producers already reject a disk/runtime snapshot mismatch.
export function getModelDecisionSchema() {
  schema ??= freezeTree(JSON.parse(readFileSync(new URL("../../nli/model-decision.schema.json", import.meta.url), "utf8")));
  return schema;
}

// Internal preparation seam only: call from prepareGroundedRequest, never from
// HTTP/model data. Object identity, not JSON fields, carries this authority.
export function registerPreparedDecision(request, obligations, context) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid prepared decision request");
  preparedDecisions.set(request, null);
  for (const key of ["expectedIntents", "allowedSourceIds", "requiredProjectIds", "requiredSubjectIds"]) {
    if (!Array.isArray(obligations?.[key]) || obligations[key].some((id) => typeof id !== "string" || !id) ||
      new Set(obligations[key]).size !== obligations[key].length) throw new Error("Invalid prepared decision obligations");
  }
  for (const key of ["targets", "terms", "candidateSources"]) {
    if (!Array.isArray(request[key])) throw new Error("Invalid prepared decision pools");
  }
  const registered = new Map(context.routes.targets.map((target) => [target.id, target]));
  const terms = new Map(context.glossary.terms.map((entry) => [entry.term, entry]));
  if (obligations.allowedSourceIds.some((id) => !registered.has(id))) throw new Error("Invalid prepared decision source scope");
  const allowed = new Set(obligations.allowedSourceIds);
  const groups = getObligationSourceGroups(obligations, context);
  const sourceIds = unique(request.candidateSources.map((card) => card?.id).filter((id) => registered.has(id) && allowed.has(id)));
  const targetIds = unique(request.targets.map((target) => target?.id).filter((id) => registered.has(id) && allowed.has(id) &&
    groups.every((group) => group.sourceIds.includes(id))));
  const canonicalTerms = unique(request.terms.map((entry) => entry?.term).filter((term) => terms.has(term)));
  const label = (id, project = false) => {
    const target = registered.get(id);
    const term = [...terms.keys()].find((term) => `glossary:${term}` === id);
    if (project ? target?.type !== "project" : !target && !term) throw new Error("Invalid prepared decision subject");
    return { id, label: boundedString(target?.label || term, 256) };
  };
  const coverage = {
    requiredProjects: obligations.requiredProjectIds.map((id) => label(id, true)),
    requiredSubjects: obligations.requiredSubjectIds.map((id) => label(id)),
    sourceGroups: groups.map(({ id, sourceIds: alternatives }) => ({ id, sourceIds: alternatives.filter((id) => sourceIds.includes(id)) })),
    perProjectClause: obligations.kind === "comparison"
  };
  preparedDecisions.set(request, freezeTree({ expectedIntents: [...obligations.expectedIntents], targetIds,
    terms: canonicalTerms, sourceIds, coverage, coverageImpossible: obligations.coveragePossible === false }));
  // Empty authorization is a preparation error, even in plain mode. It is not
  // the compatibility case (an object never registered by internal preparation).
  specializeDecisionSchema(getModelDecisionSchema(), request);
}

export function specializeDecisionSchema(base, request) {
  if (!preparedDecisions.has(request)) return base;
  const projection = preparedDecisions.get(request);
  if (!projection) throw new Error("Invalid prepared decision projection");
  const answerPattern = buildRequiredSubjectPattern(projection.coverage.requiredSubjects);
  const oneOf = [];
  for (const original of base.oneOf) {
    if (!projection.expectedIntents.includes(original.properties.intent.const)) continue;
    const branch = structuredClone(original);
    const pools = [[branch.properties.targetId, projection.targetIds], [branch.properties.term, projection.terms],
      [branch.properties.sourceIds?.items, projection.sourceIds]];
    if (pools.some(([field, values]) => field && !values.length)) continue;
    for (const [field, values] of pools) if (field) field.enum = [...values];
    if (branch.properties.intent.const === "answer_portfolio" && answerPattern !== undefined) {
      branch.properties.answer.pattern = answerPattern;
    }
    oneOf.push(branch);
  }
  if (!oneOf.length) throw new PreparedDecisionUnavailableError(projection.coverageImpossible);
  return freezeTree({ ...structuredClone(base), oneOf });
}

export function buildPreparedCoverageBlock(request) {
  if (!preparedDecisions.has(request)) return "";
  const projection = preparedDecisions.get(request);
  if (!projection) throw new Error("Invalid prepared decision projection");
  const { coverage, expectedIntents } = projection;
  if (!expectedIntents.includes("answer_portfolio") || !coverage.sourceGroups.length) return "";
  return `\nTrusted coverage: ${JSON.stringify(coverage)}\nCover each required subject with matching evidence; select at least one source per group. ` +
    (coverage.perProjectClause ? "Include a separate grounded clause naming each required project and its subject. " : "") +
    "Use every requiredSubjects.label verbatim in the answer clause about that subject; sourceIds alone do not count as mention. Keep each project label with its own subject/evidence. " +
    "Use a SINGLELINE answer with requiredSubjects.label values in their given order. " +
    "These registry labels and source groups are constraints, not additional evidence.";
}

// Only the private prepared projection supplies these already bounded registry labels.
export function buildRequiredSubjectPattern(subjects) {
  if (!Array.isArray(subjects) || subjects.some((subject) => typeof subject?.label !== "string" ||
    !subject.label.trim() || /[\r\n\u2028\u2029]/u.test(subject.label))) return undefined;
  const labels = unique(subjects.map((subject) => subject.label));
  if (!labels.length || labels.length > 2) return undefined;
  const pattern = `^.*${labels.map(escapeRegex).join(".*")}.*$`;
  return pattern.length <= 2048 ? pattern : undefined;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function unique(values) { return [...new Set(values)]; }
function freezeTree(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
