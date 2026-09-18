import { reasoningMetadata } from "./reasoning-metadata.mjs";

export const MODEL_FAILURE_KINDS = Object.freeze([
  "timeout", "aborted", "busy", "http_error", "body_limit", "invalid_envelope",
  "invalid_json", "truncated", "reasoning_violation"
]);

export function modelFailure(kind, metadata) {
  if (!MODEL_FAILURE_KINDS.includes(kind)) throw new Error("Unknown model failure kind");
  return { tag: "failure", kind, metadata };
}

export function inspectModelCompletion(data, endpoint) {
  const choices = data?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  const message = choice?.message;
  const content = message?.content;
  const metadata = completionMetadata(data, choice, message);
  const fail = (kind) => modelFailure(kind, metadata);
  if (endpoint === "qwen" && (metadata.reasoningBytes > 0 || ["positive", "invalid"].includes(metadata.reasoningAccounting) ||
    (typeof content === "string" && /<\/?think\b/i.test(content)))) return fail("reasoning_violation");
  if (!isObject(choice) || !isObject(message) || message.role !== "assistant") return fail("invalid_envelope");
  if (choice.finish_reason === "length") return fail("truncated");
  if (choice.finish_reason !== "stop" ||
    (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
    message.function_call != null) return fail("invalid_envelope");
  if (typeof content !== "string" || !content.trim()) return fail("invalid_json");
  let candidate;
  try { candidate = JSON.parse(content.trim()); }
  catch { return fail("invalid_json"); }
  if (!isObject(candidate)) return fail("invalid_json");
  return { tag: "success", candidate, metadata };
}

function completionMetadata(data, choice, message) {
  const usage = isObject(data?.usage) ? data.usage : null;
  return {
    modelId: typeof data?.model === "string" ? data.model.slice(0, 256) : null,
    finishReason: ["stop", "length", "tool_calls", "content_filter", "function_call"].includes(choice?.finish_reason)
      ? choice.finish_reason : null,
    usageAvailable: usage !== null,
    promptTokens: tokenCount(usage?.prompt_tokens), completionTokens: tokenCount(usage?.completion_tokens),
    totalTokens: tokenCount(usage?.total_tokens), ...reasoningMetadata(data, message)
  };
}

function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
