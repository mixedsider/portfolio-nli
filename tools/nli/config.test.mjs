import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayConfig } from "./config.mjs";

test("Qwen is the local default while environment model settings override it", () => {
  const defaults = createGatewayConfig({});
  const override = createGatewayConfig({
    LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    LM_STUDIO_MODEL: "local-test-model"
  });

  assert.equal(defaults.model.baseUrl, "http://192.168.0.57:1234/v1");
  assert.equal(defaults.model.name, "qwen/qwen3.5-9b");
  assert.equal(defaults.model.timeoutMs, 8_000);
  assert.equal(defaults.model.reasoningEffort, "none");
  assert.equal(override.model.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(override.model.name, "local-test-model");
});
