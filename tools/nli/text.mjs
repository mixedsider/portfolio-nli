export function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,:;()[\]{}'"`]/g, " ")
    .replace(/\s+/g, " ");
}

export function compact(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function hasAny(message, words) {
  return words.some((word) => message.includes(normalize(word)));
}

export function includesKeyword(normalizedText, keyword) {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedText || !normalizedKeyword) return false;

  if (/^[a-z0-9+#.]{1,2}$/.test(normalizedKeyword)) {
    return new RegExp(`(^|\\s)${escapeRegExp(normalizedKeyword)}($|\\s)`).test(normalizedText);
  }

  if (normalizedText.includes(normalizedKeyword)) return true;
  return compact(normalizedText).includes(compact(normalizedKeyword));
}

export function searchableText(...parts) {
  return normalize(parts.flat(Infinity).filter(Boolean).join(" "));
}

export function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.8;
  return Math.max(0, Math.min(1, number));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
