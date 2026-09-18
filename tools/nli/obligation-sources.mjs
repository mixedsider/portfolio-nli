export function obligationCatalog(context) {
  const targets = context?.routes?.targets || [];
  const parents = new Map();
  for (const project of context?.portfolio?.projects || []) {
    const id = `project-${project.id}`;
    if (targets.some((target) => target.id === id)) parents.set(id, id);
    for (const section of project.sections || []) parents.set(section.id, id);
  }
  for (const target of targets) {
    if (target.type === "project") parents.set(target.id, target.id);
    if (target.type === "section" && !parents.has(target.id)) {
      const parent = targets.find((candidate) => candidate.type === "project" && candidate.label === target.project);
      if (parent) parents.set(target.id, parent.id);
    }
  }
  const entries = targets.map((target) => ({ id: target.id, type: target.type, names: [target.label, ...(target.aliases || [])] }));
  const terms = context?.glossary?.terms || [];
  for (const term of terms) entries.push({ id: `glossary:${term.term}`, type: "glossary", names: [term.term, ...(term.aliases || [])] });
  return { targets, parents, entries, terms };
}

// Groups are AND obligations; each group's sourceIds are OR alternatives.
export function getObligationSourceGroups(obligations, context) {
  const { parents, terms, targets } = obligationCatalog(context);
  const allowed = new Set(obligations.allowedSourceIds);
  const groups = obligations.requiredProjectIds.map((id) => ({ id, sourceIds: targets.filter((target) => parents.get(target.id) === id && allowed.has(target.id)).map((target) => target.id) }));
  for (const id of obligations.requiredSubjectIds) {
    const term = terms.find((entry) => `glossary:${entry.term}` === id);
    const ids = term ? term.relatedTargets || [] : [id];
    groups.push({ id, sourceIds: [...new Set(ids.filter((sourceId) => allowed.has(sourceId)))] });
  }
  return groups;
}

export function coverageFits(groups, availableIds) {
  const candidates = groups.map((group) => group.sourceIds.filter((id) => availableIds.has(id)));
  if (candidates.some((ids) => ids.length === 0)) return false;
  function search(remaining, slots) {
    if (!remaining.length) return true;
    if (!slots) return false;
    const smallest = remaining.reduce((left, right) => left.length <= right.length ? left : right);
    return smallest.some((id) => search(remaining.filter((ids) => !ids.includes(id)), slots - 1));
  }
  return search(candidates, 6);
}
