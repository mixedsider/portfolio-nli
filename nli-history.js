const historyKey = "portfolio-nli:messages:v1";
const maxStoredMessages = 30;
const maxRequestMessages = 6;
const maxStoredTextLength = 4_000;
const maxHistoryEntryBytes = 480;
const maxSources = 6;
const maxSourceIdLength = 128;
const maxSourceLabelLength = 200;
const textEncoder = new TextEncoder();

export const nliWelcomeText =
  "저는 포트폴리오 도우미에요. 원하는 자료를 말하시면 이동해드리거나, 프로젝트 요약과 등록된 용어 설명을 도와드릴 수 있어요.";

export function createNliMessage(role, text, options = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    sources: normalizeNliSources(options.sources),
    isPending: options.isPending === true,
    isUiOnly: options.isUiOnly === true
  };
}

export function loadNliMessages(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(historyKey) || "[]");
    if (!Array.isArray(parsed)) return [createWelcomeMessage()];

    const messages = parsed.map(normalizeStoredNliMessage).filter(Boolean).slice(-maxStoredMessages);
    return messages.length ? messages : [createWelcomeMessage()];
  } catch {
    return [createWelcomeMessage()];
  }
}

export function saveNliMessages(storage, messages) {
  const storableMessages = messages
    .filter((message) => !message.isPending && !message.isUiOnly)
    .slice(-maxStoredMessages)
    .map(({ role, text, sources }) => ({ role, text, ...(sources.length ? { sources } : {}) }));

  storage.setItem(historyKey, JSON.stringify(storableMessages));
}

export function normalizeNliSources(sources) {
  if (!Array.isArray(sources)) return [];

  const seenSourceIds = new Set();
  return sources.reduce((normalized, source) => {
    if (normalized.length === maxSources || !source || typeof source.id !== "string" || typeof source.label !== "string") {
      return normalized;
    }

    const id = source.id.trim();
    const label = source.label.trim();
    if (!id || !label || id.length > maxSourceIdLength || label.length > maxSourceLabelLength || seenSourceIds.has(id)) {
      return normalized;
    }

    seenSourceIds.add(id);
    normalized.push({ id, label });
    return normalized;
  }, []);
}

export function getNliRequestHistory(messages) {
  return messages
    .filter((message) => !message.isPending && !message.isUiOnly)
    .slice(-maxRequestMessages)
    .map(({ role, text }) => ({ role, text: truncateNliHistoryText(text) }))
    .filter((message) => message.text);
}

function normalizeStoredNliMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role) || typeof message.text !== "string") return null;

  const text = message.text.trim();
  if (!text || text.length > maxStoredTextLength) return null;
  return createNliMessage(message.role, text, { sources: message.sources });
}

function createWelcomeMessage() {
  return createNliMessage("assistant", nliWelcomeText, { isUiOnly: true });
}

function truncateNliHistoryText(text) {
  const normalized = String(text || "").trim();
  if (textEncoder.encode(normalized).length <= maxHistoryEntryBytes) return normalized;

  let byteLength = 0;
  let truncated = "";
  for (const character of normalized) {
    const characterByteLength = textEncoder.encode(character).length;
    if (byteLength + characterByteLength > maxHistoryEntryBytes) break;
    byteLength += characterByteLength;
    truncated += character;
  }

  return truncated.trim();
}
