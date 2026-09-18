// Authorized Qwen timeout amendment: 4s LFM + 16s Qwen + 1s response reserve.
// HTTP body receipt has its own unchanged NLI_REQUEST_TIMEOUT_MS setting.
export const QWEN_TIMEOUT_MS = 16_000;
export const APPLICATION_TIMEOUT_MS = 21_000;
export const EVALUATION_HTTP_TIMEOUT_MS = 25_000;
