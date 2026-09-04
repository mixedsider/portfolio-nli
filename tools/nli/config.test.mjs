import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayConfig } from "./config.mjs";

test("배포된 Qwen 모델이 기본값이고 환경 모델 설정이 이를 재정의한다", () => {
  const defaults = createGatewayConfig({});
  const override = createGatewayConfig({
    LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    LM_STUDIO_MODEL: "local-test-model"
  });

  assert.equal(defaults.model.baseUrl, "http://192.168.0.57:1234/v1");
  assert.equal(defaults.model.name, "Qwen3.8-27B-UD-Q4_K_M");
  assert.equal(defaults.model.timeoutMs, 8_000);
  assert.equal(defaults.model.reasoningEffort, "none");
  assert.equal(override.model.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(override.model.name, "local-test-model");
});
