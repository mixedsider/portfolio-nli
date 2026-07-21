import { isPromptInjectionAttempt } from "./router.mjs";

export const MAX_HISTORY_ITEMS = 6;
export const MAX_HISTORY_ENTRY_BYTES = 480;
export const MAX_HISTORY_BYTES = 2_400;

export class HttpRequestError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export function createRateLimiter(config) {
  const buckets = new Map();

  return {
    consume(request) {
      if (config.rateLimitMax <= 0) return true;

      const now = Date.now();
      const key = getClientIp(request, config.trustProxy);
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        evictBuckets(buckets, now, config.maxRateLimitBuckets);
        buckets.set(key, { count: 1, resetAt: now + config.rateLimitWindowMs, lastSeenAt: now });
        return true;
      }

      bucket.lastSeenAt = now;
      if (bucket.count >= config.rateLimitMax) return false;
      bucket.count += 1;
      return true;
    },
    size() {
      return buckets.size;
    }
  };
}

export function assertJsonContentType(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpRequestError(415, "Content-Type은 application/json이어야 합니다.");
  }
}

export async function readRequestJson(request, maxRequestBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxRequestBytes) {
      throw new HttpRequestError(413, `요청 본문은 ${maxRequestBytes}바이트 이하로 보내주세요.`);
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpRequestError(400, "JSON 요청 본문이 올바르지 않습니다.");
  }
}

export function readNliRequest(body, maxMessageLength) {
  if (!isPlainObject(body) || typeof body.message !== "string") {
    throw new HttpRequestError(400, "질문을 문자열로 입력해주세요.");
  }
  if (body.message.length > maxMessageLength) {
    throw new HttpRequestError(413, `질문은 ${maxMessageLength}자 이하로 입력해주세요.`);
  }
  if (body.currentTargetId !== undefined && (typeof body.currentTargetId !== "string" || body.currentTargetId.length > 128)) {
    throw new HttpRequestError(400, "현재 위치 정보가 올바르지 않습니다.");
  }

  return {
    message: body.message,
    currentTargetId: body.currentTargetId || null,
    history: readNliHistory(body.history)
  };
}

export function isOriginAllowed(request, config) {
  const origin = request.headers.origin;
  if (!origin || config.allowedOrigins.has("*")) return true;
  return config.allowedOrigins.has(origin);
}

export function setCorsHeaders(request, response, config) {
  const origin = request.headers.origin;
  if (!origin) return;

  if (config.allowedOrigins.has("*")) {
    response.setHeader("Access-Control-Allow-Origin", "*");
  } else if (config.allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

function getClientIp(request, trustProxy) {
  if (trustProxy) {
    const forwardedFor = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwardedFor) return forwardedFor;
  }
  return request.socket.remoteAddress || "unknown";
}

function evictBuckets(buckets, now, maxBuckets) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }

  while (buckets.size >= maxBuckets) {
    let oldestKey = null;
    let oldestSeenAt = Infinity;
    for (const [key, bucket] of buckets) {
      if (bucket.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = bucket.lastSeenAt;
      }
    }
    if (!oldestKey) return;
    buckets.delete(oldestKey);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readNliHistory(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpRequestError(400, "Invalid conversation history.");
  if (value.length > MAX_HISTORY_ITEMS) {
    throw new HttpRequestError(413, "Conversation history has too many entries.");
  }

  const history = [];
  let totalBytes = 0;
  for (const entry of value) {
    if (!isPlainObject(entry) || !hasExactHistoryKeys(entry) || !isHistoryRole(entry.role)) {
      throw new HttpRequestError(400, "Invalid conversation history entry.");
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      throw new HttpRequestError(400, "Invalid conversation history entry.");
    }
    if (isPromptInjectionAttempt(entry.text)) {
      throw new HttpRequestError(400, "Conversation history contains an unsupported instruction.");
    }

    const text = entry.text.trim();
    const entryBytes = Buffer.byteLength(text, "utf8");
    if (entryBytes > MAX_HISTORY_ENTRY_BYTES) {
      throw new HttpRequestError(413, "Conversation history entry is too large.");
    }
    totalBytes += entryBytes;
    if (totalBytes > MAX_HISTORY_BYTES) {
      throw new HttpRequestError(413, "Conversation history is too large.");
    }
    history.push({ role: entry.role, text });
  }

  return history;
}

function hasExactHistoryKeys(entry) {
  const keys = Object.keys(entry);
  return keys.length === 2 && keys.includes("role") && keys.includes("text");
}

function isHistoryRole(value) {
  return value === "user" || value === "assistant";
}
