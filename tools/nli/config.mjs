import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
    allowedOrigins: readAllowedOrigins(env.NLI_ALLOWED_ORIGINS || "*"),
    maxRequestBytes: readPositiveIntegerEnv(env, "NLI_MAX_REQUEST_BYTES", 16_384),
    maxMessageLength: readPositiveIntegerEnv(env, "NLI_MAX_MESSAGE_LENGTH", 500),
    requestTimeoutMs: readPositiveIntegerEnv(env, "NLI_REQUEST_TIMEOUT_MS", 15_000),
    rateLimitWindowMs: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMax: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_MAX", 30),
    maxRateLimitBuckets: readPositiveIntegerEnv(env, "NLI_RATE_LIMIT_MAX_BUCKETS", 10_000),
    trustProxy: env.NLI_TRUST_PROXY === "true",
    model: {
      baseUrl: env.LM_STUDIO_BASE_URL || "http://192.168.0.58:1234/v1",
      name: env.LM_STUDIO_MODEL || "google/gemma-4-e4b",
      timeoutMs: readPositiveIntegerEnv(env, "LM_STUDIO_TIMEOUT_MS", 8_000),
      maxTokens: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_TOKENS", 256),
      maxResponseBytes: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_RESPONSE_BYTES", 65_536),
      maxConcurrentRequests: readPositiveIntegerEnv(env, "LM_STUDIO_MAX_CONCURRENT_REQUESTS", 4)
    }
  };
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
