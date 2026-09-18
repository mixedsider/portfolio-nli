import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayConfig, loadDotEnv } from "./config.mjs";

test("배포된 Qwen 모델이 기본값이고 환경 모델 설정이 이를 재정의한다", () => {
  const defaults = createGatewayConfig({});
  const override = createGatewayConfig({
    LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    LM_STUDIO_MODEL: "local-test-model"
  });

  assert.equal(defaults.model.baseUrl, "http://192.168.0.57:1234/v1");
  assert.equal(defaults.model.name, "Qwen3.8-27B-UD-Q4_K_M");
  assert.equal(defaults.model.timeoutMs, 16_000);
  assert.equal(defaults.model.reasoningEffort, "none");
  assert.equal(override.model.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(override.model.name, "local-test-model");
});

test("dotenv preserves nonempty environment values and its existing literal parsing", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nli-config-"));
  try {
    const env = { EXISTING: "process", EMPTY: "" };
    await loadDotEnv(root, env);
    assert.deepEqual(env, { EXISTING: "process", EMPTY: "" });
    await writeFile(resolve(root, ".env"), [
      "# ignored", "invalid", "=invalid", "EXISTING=dotenv", "EMPTY=filled",
      ' QUOTED = "hello=world" ', "SINGLE='literal'", "INLINE=value # literal",
      "DUP=first", "DUP=second", "export NAME=literal-key", ""
    ].join("\r\n"));
    await loadDotEnv(root, env);
    assert.deepEqual(env, {
      EXISTING: "process", EMPTY: "filled", QUOTED: "hello=world", SINGLE: "literal",
      INLINE: "value # literal", DUP: "first", "export NAME": "literal-key"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing numeric coercion, fallback, port and proxy semantics stay unchanged", () => {
  for (const value of [undefined, "", " ", "0", "-1", "1.5", "NaN", "Infinity", "1e309", "12ms"]) {
    const config = createGatewayConfig({ LM_STUDIO_MAX_TOKENS: value, NLI_MAX_MESSAGE_LENGTH: value });
    assert.equal(config.model.maxTokens, 768);
    assert.equal(config.maxMessageLength, 500);
  }
  for (const value of ["16", " 16 ", "0x10", "1.6e1"]) {
    assert.equal(createGatewayConfig({ LM_STUDIO_MAX_TOKENS: value }).model.maxTokens, 16);
  }
  assert.equal(createGatewayConfig({ NLI_PORT: " " }).port, 0);
  assert.equal(createGatewayConfig({ NLI_PORT: "65536" }).port, 8787);
  assert.equal(createGatewayConfig({ NLI_TRUST_PROXY: "TRUE" }).trustProxy, false);
  assert.equal(createGatewayConfig({ NLI_TRUST_PROXY: "true" }).trustProxy, true);
  assert.deepEqual([...createGatewayConfig({ NLI_ALLOWED_ORIGINS: " a, b,a, " }).allowedOrigins], ["a", "b"]);
});

test("independent LFM, Qwen and cascade defaults match the amended settings", () => {
  const config = createGatewayConfig({});
  assert.deepEqual(config.model, {
    baseUrl: "http://192.168.0.57:1234/v1", name: "Qwen3.8-27B-UD-Q4_K_M",
    timeoutMs: 16000, maxTokens: 768, reasoningEffort: "none",
    chatTemplateKwargs: { enable_thinking: false }, outputMode: "json_schema",
    maxResponseBytes: 65536, maxConcurrentRequests: 4
  });
  assert.deepEqual(config.lfm, {
    baseUrl: "http://192.168.0.106:1234/v1", name: "lfm2.5-2.6b",
    timeoutMs: 4000, maxTokens: 512, maxResponseBytes: 65536,
    maxConcurrentRequests: 4, outputMode: "json_schema"
  });
  assert.deepEqual(config.cascade, {
    timeoutMs: 21000, maxConcurrentRequests: 4, qwenEnabled: true,
    qwenVerificationFile: fileURLToPath(new URL("../../.nli/qwen-no-thinking.json", import.meta.url))
  });
});

test("endpoint and cascade overrides are isolated and cannot enable thinking or verification", () => {
  const qwenEnv = {
    LM_STUDIO_BASE_URL: "https://qwen.example/v1", LM_STUDIO_MODEL: "qwen-test",
    LM_STUDIO_TIMEOUT_MS: "7000", LM_STUDIO_MAX_TOKENS: "700",
    LM_STUDIO_MAX_RESPONSE_BYTES: "70000", LM_STUDIO_MAX_CONCURRENT_REQUESTS: "2",
    LM_STUDIO_OUTPUT_MODE: "plain", LM_STUDIO_REASONING_EFFORT: "high",
    LM_STUDIO_ENABLE_THINKING: "true", NLI_QWEN_VERIFIED: "true"
  };
  const lfmEnv = {
    LFM_BASE_URL: "http://lfm.example/v1", LFM_MODEL: "lfm-test", LFM_TIMEOUT_MS: "3000",
    LFM_MAX_TOKENS: "300", LFM_MAX_RESPONSE_BYTES: "30000",
    LFM_MAX_CONCURRENT_REQUESTS: "3", LFM_OUTPUT_MODE: "plain"
  };
  const config = createGatewayConfig({ ...qwenEnv, ...lfmEnv,
    NLI_CASCADE_TIMEOUT_MS: "12000", NLI_CASCADE_MAX_CONCURRENT_REQUESTS: "1", NLI_QWEN_ENABLED: "false"
  });
  assert.deepEqual(createGatewayConfig(qwenEnv).lfm, createGatewayConfig({}).lfm);
  assert.deepEqual(createGatewayConfig(lfmEnv).model, createGatewayConfig({}).model);
  assert.deepEqual(config.model, { baseUrl: "https://qwen.example/v1", name: "qwen-test",
    timeoutMs: 7000, maxTokens: 700, maxResponseBytes: 70000, maxConcurrentRequests: 2,
    outputMode: "plain", reasoningEffort: "none", chatTemplateKwargs: { enable_thinking: false } });
  assert.deepEqual(config.lfm, { baseUrl: "http://lfm.example/v1", name: "lfm-test",
    timeoutMs: 3000, maxTokens: 300, maxResponseBytes: 30000, maxConcurrentRequests: 3, outputMode: "plain" });
  assert.equal(config.cascade.timeoutMs, 12000);
  assert.equal(config.cascade.maxConcurrentRequests, 1);
  assert.equal(config.cascade.qwenEnabled, false);
  assert.equal("qwenVerified" in config.cascade, false);
});

test("new flags and modes reject malformed values, including explicit empty values", () => {
  for (const name of ["NLI_QWEN_ENABLED", "LFM_OUTPUT_MODE", "LM_STUDIO_OUTPUT_MODE"]) {
    for (const value of ["", " ", "TRUE", "False", "1", "0", "yes", "auto", "JSON_SCHEMA", "plain ", true, null]) {
      assert.throws(() => createGatewayConfig({ [name]: value }), { message: new RegExp(name) });
    }
  }
  assert.equal(createGatewayConfig({ NLI_QWEN_ENABLED: "true" }).cascade.qwenEnabled, true);
  for (const outputMode of ["json_schema", "plain"]) {
    const config = createGatewayConfig({ LFM_OUTPUT_MODE: outputMode, LM_STUDIO_OUTPUT_MODE: outputMode });
    assert.equal(config.lfm.outputMode, outputMode);
    assert.equal(config.model.outputMode, outputMode);
  }
});

test("all new numeric limits preserve the existing finite positive integer parser", () => {
  const settings = [
    ["LFM_TIMEOUT_MS", "lfm", "timeoutMs", 4000], ["LFM_MAX_TOKENS", "lfm", "maxTokens", 512],
    ["LFM_MAX_RESPONSE_BYTES", "lfm", "maxResponseBytes", 65536],
    ["LFM_MAX_CONCURRENT_REQUESTS", "lfm", "maxConcurrentRequests", 4],
    ["NLI_CASCADE_TIMEOUT_MS", "cascade", "timeoutMs", 21000],
    ["NLI_CASCADE_MAX_CONCURRENT_REQUESTS", "cascade", "maxConcurrentRequests", 4]
  ];
  for (const [name, group, key, fallback] of settings) {
    for (const value of [undefined, "", " ", "0", "-1", "1.5", "NaN", "Infinity", "1e309", "12ms"]) {
      assert.equal(createGatewayConfig({ [name]: value })[group][key], fallback, `${name}: ${value}`);
    }
    for (const value of ["16", " 16 ", "0x10", "1.6e1"]) {
      assert.equal(createGatewayConfig({ [name]: value })[group][key], 16);
    }
  }
});

test("receipt paths resolve against the module workspace even from another cwd", () => {
  const moduleUrl = new URL("./config.mjs", import.meta.url).href;
  const config = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { createGatewayConfig } from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify(createGatewayConfig({NLI_QWEN_VERIFICATION_FILE:'.nli/missing.json'})));`
  ], { cwd: tmpdir(), encoding: "utf8" }));
  assert.equal(config.cascade.qwenVerificationFile, fileURLToPath(new URL("../../.nli/missing.json", import.meta.url)));
  assert.equal(config.cascade.qwenEnabled, true);
  assert.equal("qwenVerified" in config.cascade, false);
  const absolute = resolve(tmpdir(), "missing-qwen-receipt.json");
  assert.equal(createGatewayConfig({ NLI_QWEN_VERIFICATION_FILE: absolute }).cascade.qwenVerificationFile, absolute);
});

test("env example matches model defaults and preserves process-env precedence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nli-config-example-"));
  try {
    await writeFile(resolve(root, ".env"), await readFile(new URL("../../.env.example", import.meta.url)));
    const env = {};
    await loadDotEnv(root, env);
    const example = createGatewayConfig(env);
    const defaults = createGatewayConfig({});
    for (const key of ["model", "lfm", "cascade"]) assert.deepEqual(example[key], defaults[key]);
    const overrides = { LFM_MODEL: "process-lfm", LM_STUDIO_MODEL: "process-qwen", NLI_QWEN_ENABLED: "false" };
    await loadDotEnv(root, overrides);
    assert.equal(createGatewayConfig(overrides).lfm.name, "process-lfm");
    assert.equal(createGatewayConfig(overrides).model.name, "process-qwen");
    assert.equal(createGatewayConfig(overrides).cascade.qwenEnabled, false);
    assert.match(await readFile(new URL("../../.gitignore", import.meta.url), "utf8"), /^\.nli\/$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
