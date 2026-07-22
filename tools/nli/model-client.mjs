import { buildGroundedRequestBlock } from "./context.mjs";

export function createModelClient(config) {
  const limiter = new ConcurrencyLimiter(config.model.maxConcurrentRequests);

  return async function askModel(message, context, groundedRequest = {}) {
    return limiter.run(() => requestModel(message, context, config, groundedRequest));
  };
}

export function buildLmStudioChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("LM Studio URL must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("LM Studio URL must not include credentials, query, or fragment");

  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  return url.toString();
}

async function requestModel(message, context, config, groundedRequest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.model.timeoutMs);
  const payload = {
    model: config.model.name,
    temperature: 0,
    max_tokens: config.model.maxTokens,
    reasoning_effort: config.model.reasoningEffort || "none",
    messages: [
      { role: "system", content: context.prompt },
      { role: "system", content: buildGroundedRequestBlock(groundedRequest) },
      { role: "user", content: message }
    ]
  };

  try {
    const response = await fetch(buildLmStudioChatCompletionsUrl(config.model.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error"
    });
    if (!response.ok) throw new Error(`LM Studio responded with ${response.status}`);

    const rawBody = await readBodyWithLimit(response, config.model.maxResponseBytes, controller);
    const data = JSON.parse(rawBody);
    return parseJsonObject(data?.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyWithLimit(response, maxBytes, controller) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error(`LM Studio response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, totalBytes));
}

function concatChunks(chunks, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJsonObject(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  const parsed = JSON.parse(trimmed);
  return isPlainObject(parsed) ? parsed : null;
}

class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
  }

  async run(task) {
    if (this.active >= this.limit) throw new Error("LM Studio is busy");
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
