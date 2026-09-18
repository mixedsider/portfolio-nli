// Receipts from earlier sanitizers cannot establish that unavailable counters were absent.
export const REASONING_ACCOUNTING_POLICY = "strict-present-counters-v2";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function reasoningMetadata(data, message) {
  const counters = [];
  let invalid = false;
  const inspect = (container) => {
    if (!object(container)) { invalid = true; return; }
    if (!Object.hasOwn(container, "reasoning_tokens")) return;
    const value = container.reasoning_tokens;
    if (!Number.isSafeInteger(value) || value < 0) invalid = true;
    else counters.push(value);
  };
  if (object(data) && Object.hasOwn(data, "usage")) {
    inspect(data.usage);
    if (object(data.usage)) for (const key of ["completion_tokens_details", "output_tokens_details"]) {
      if (Object.hasOwn(data.usage, key)) inspect(data.usage[key]);
    }
  }
  const reasoningTokens = !invalid && counters.length ? Math.max(...counters) : null;
  const reasoningBytes = [message?.reasoning_content, message?.reasoning, message?.reasoning_details]
    .reduce((sum, value) => sum + fieldBytes(value), 0);
  return { reasoningTokens, reasoningAccounting: invalid ? "invalid" : reasoningTokens === null ? "unavailable" : reasoningTokens > 0 ? "positive" : "zero",
    reasoningPresent: reasoningBytes > 0, reasoningBytes };
}

function fieldBytes(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "string") return Buffer.byteLength(value.trim());
  if (Array.isArray(value) && value.length === 0) return 0;
  if (object(value) && Object.keys(value).length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(value));
}
