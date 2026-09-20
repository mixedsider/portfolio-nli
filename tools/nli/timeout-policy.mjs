// Issue #6: 6.5s LFM + 16s Qwen (including metadata) + 1s response reserve.
// HTTP body receipt has its own unchanged NLI_REQUEST_TIMEOUT_MS setting.
export const LFM_TIMEOUT_MS = 6_500;
export const QWEN_TIMEOUT_MS = 16_000;
export const RESPONSE_RESERVE_MS = 1_000;
export const APPLICATION_TIMEOUT_MS = LFM_TIMEOUT_MS + QWEN_TIMEOUT_MS + RESPONSE_RESERVE_MS;
export const EVALUATION_HTTP_TIMEOUT_MS = 30_000;
