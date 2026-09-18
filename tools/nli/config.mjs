import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_TIMEOUT_MS, QWEN_TIMEOUT_MS } from "./timeout-policy.mjs";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function loadDotEnv(root, env = process.env) {
  const source = await readFile(resolve(root, ".env"), "utf8").catch(() => "");
  if (!source) return;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = parseDotEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (!env[key]) env[key] = value;
  }
}

export function createGatewayConfig(env = process.env) {
  return {
    host: env.NLI_HOST || "127.0.0.1",
    port: readPort(env.NLI_PORT, 8787),
    allowedOrigins: readAllowedOrigins(env.NLI_ALLOWED_ORIGINS || ""),
    maxRequestBytes: readPositiveIntegerEnv(env, "NLI_MAX_REQUEST_BYTES", 16_384),
    maxMessageLength: readPositiveIntegerEnv(env, "NLI_MAX_MESSAGE_LENGTH", 500),
    requestTimeoutMs: readPositiveIntegerEnv(env, "NLI_REQUEST_TIMEOUT_MS", 15_000),
    rateLimitWindowMs: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_MAX", 30),
    maxRateLimitBuckets: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_MAX_BUCKETS", 10_000),
    trustProxy: env.NLI_TRUST_PROXY === "true",
    releaseRevision: env.GIT_COMMIT_SHA || null,
    model: {
      baseUrl: env.LM_STUDIO_BASE_URL || "http://192.168.0.57:1234/v1",
      name: env.LM_STUDIO_MODEL || "Qwen3.8-27B-UD-Q4_K_M",
      timeoutMs: readPositiveIntegerEnv(env, "LM_STUDIO_TIMEOUT_MS", QWEN_TIMEOUT_MS),
      maxTokens: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_TOKENS", 768),
      reasoningEffort: "none",
      chatTemplateKwargs: { enable_thinking: false },
      // Provisional until task 1's compatibility probe selects the final mode.
      outputMode: readChoiceEnv(env, "LM_STUDIO_OUTPUT_MODE", ["json_schema", "plain"], "json_schema"),
      maxResponseBytes: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_RESPONSE_BYTES", 65_536),
      maxConcurrentRequests: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_CONCURRENT_REQUESTS", 4)
    },
    lfm: {
      baseUrl: env.LFM_BASE_URL || "http://192.168.0.106:1234/v1",
      name: env.LFM_MODEL || "lfm2.5-2.6b",
      timeoutMs: readPositiveIntegerEnv(env, "LFM_TIMEOUT_MS", 4_000),
      maxTokens: readPositiveIntegerEnv(env, "LFM_MAX_TOKENS", 512),
      maxResponseBytes: readPositiveIntegerEnv(env, "LFM_MAX_RESPONSE_BYTES", 65_536),
      maxConcurrentRequests: readPositiveIntegerEnv(env, "LFM_MAX_CONCURRENT_REQUESTS", 4),
      // Provisional until task 1's compatibility probe selects the final mode.
      outputMode: readChoiceEnv(env, "LFM_OUTPUT_MODE", ["json_schema", "plain"], "json_schema")
    },
    cascade: {
      timeoutMs: readPositiveIntegerEnv(env, "NLI_CASCADE_TIMEOUT_MS", APPLICATION_TIMEOUT_MS),
      maxConcurrentRequests: readPositiveIntegerEnv(env, "NLI_CASCADE_MAX_CONCURRENT_REQUESTS", 4),
      // Enablement is not verification; the runtime gate must validate the receipt.
      qwenEnabled: readChoiceEnv(env, "NLI_QWEN_ENABLED", ["true", "false"], "true") === "true",
      qwenVerificationFile: resolve(workspaceRoot, env.NLI_QWEN_VERIFICATION_FILE || ".nli/qwen-no-thinking.json")
    }
  };
}

function readChoiceEnv(env, name, choices, defaultValue) {
  const value = env[name] === undefined ? defaultValue : env[name];
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  return value;
}

function readPort(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : defaultValue;
}

function readPositiveIntegerEnv(env, name, defaultValue) {
  const value = Number(env[name] || defaultValue);
  if (!Number.isInteger(value) || value <= 0) return defaultValue;
  return value;
}

function readAllowedOrigins(value) {
  return new Set(
    String(value)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function parseDotEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
