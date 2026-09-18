export const MAX_GROUNDED_CANDIDATES = 8;
export const MAX_GROUNDED_SOURCES = 6;
export const MAX_GROUNDED_CARD_EVIDENCE_BYTES = 3_000;

export function boundedCandidateSources(value) {
  if (!Array.isArray(value)) return [];
  const candidates = [];
  for (const candidate of value) {
    const card = boundEvidenceCard(candidate);
    if (!card || candidates.some((item) => item.id === card.id)) continue;
    candidates.push(card);
    if (candidates.length === MAX_GROUNDED_CANDIDATES) break;
  }
  return candidates;
}

export function boundEvidenceCard(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const targetId = boundedString(candidate.targetId || candidate.id, 128);
  if (!targetId) return null;
  return {
    id: targetId, targetId,
    label: boundedString(candidate.label, 256),
    type: boundedString(candidate.type, 64),
    evidence: boundedUtf8String(candidate.evidence, MAX_GROUNDED_CARD_EVIDENCE_BYTES)
  };
}

export function boundedConversation(value) {
  if (!Array.isArray(value)) return [];
  const conversation = [];
  let remainingBytes = 2_400;
  for (const entry of value.slice(-6)) {
    if (!entry || !["user", "assistant"].includes(entry.role)) continue;
    const text = boundedUtf8String(entry.text, Math.min(480, remainingBytes));
    if (!text) continue;
    conversation.push({ role: entry.role, text });
    remainingBytes -= Buffer.byteLength(text, "utf8");
    if (remainingBytes <= 0) break;
  }
  return conversation;
}

export function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  let result = "";
  for (const character of value.trim()) {
    if (result.length + character.length > maxLength) break;
    result += character;
  }
  return result;
}

export function boundedUtf8String(value, maxBytes) {
  if (typeof value !== "string" || maxBytes <= 0) return "";
  let result = "";
  let usedBytes = 0;
  for (const character of value.trim()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result.trimEnd();
}
