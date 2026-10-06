// Reviewed exact category equivalence only; not a technology/product synonym table.
const CATEGORIES = Object.freeze([Object.freeze(["backend", "백엔드"])]);
const PARTICLES = "으로|에서|에게|부터|까지|처럼|보다|하고|과|와|을|를|은|는|이|가|의|로|에|도";
const TOKEN = "[\\p{L}\\p{N}_+#.]";

export function categoryTermSupportedByEvidence(term, evidenceText) {
  const category = categoryForTerm(term);
  if (!category) return false;
  return category.some((alias) => new RegExp(
    `(?<!${TOKEN})${alias}(?:\\s*(?:${PARTICLES}))?(?!${TOKEN})`, "iu"
  ).test(evidenceText));
}

export function isTechnicalCategoryTerm(term) {
  return Boolean(categoryForTerm(term));
}

// Guard witnesses only: compare a whole technical token and an approved particle.
// This never changes the answer, support scores, or the evidence token set.
export function technicalAnchorSupportedByEvidence(term, evidenceText) {
  const match = new RegExp(`^([a-z0-9+#.]+)(?:${PARTICLES})?$`, "iu").exec(term);
  if (!match) return false;
  const token = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${TOKEN})${token}(?:${PARTICLES})?(?!${TOKEN})`, "iu").test(evidenceText);
}

function categoryForTerm(term) {
  return CATEGORIES.find((aliases) => aliases.some((alias) =>
    new RegExp(`^${alias}(?:${PARTICLES})?$`, "iu").test(term)));
}

// Applied only to newly alias-supported claims; no words are removed or ignored.
export function hasUnsupportedAliasQualifier(terms, supported) {
  return terms.some((term) => !supported(term) &&
    /^(?:항상|전혀|절대|반드시|무조건|모든|최고|완벽|전문|유일|독점|보장)|(?:아니|않|못)/u.test(term));
}
