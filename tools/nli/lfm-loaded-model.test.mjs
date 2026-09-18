import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "./context.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { createDetailedModelClient, getModelDecisionSchema } from "./model-transport.mjs";
import { buildProbePayload, PROBE_ENDPOINTS } from "./probe-request.mjs";

test("loaded LFM ID and custom override reach HTTP unchanged and match probe payloads", async () => {
  const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
  const message = "자기소개해줘";
  const prepared = prepareGroundedRequest(message, context);
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push({ path: req.url, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ model: bodies.at(-1).body.model, choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ intent: "reject_out_of_scope", confidence: 1 }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const [env, expected] of [[{}, "lfm2.5-2.6b"], [{ LFM_MODEL: "custom-lfm" }, "custom-lfm"]]) {
      const config = createGatewayConfig(env);
      const client = createDetailedModelClient({ ...config.lfm,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, { endpoint: "lfm" });
      await client(message, context, prepared.groundedRequest);
      const captured = bodies.at(-1);
      assert.equal(captured.path, "/v1/chat/completions");
      assert.equal(captured.body.model, expected);
      const probe = buildProbePayload({ message, grounded: {} }, context, getModelDecisionSchema(),
        env.LFM_MODEL ? config.lfm : PROBE_ENDPOINTS.lfm, "json_schema");
      assert.equal(probe.model, expected);
      assert.equal(probe.model, captured.body.model);
      assert.equal(captured.body.max_tokens, 512);
      assert.equal(captured.body.response_format.type, "json_schema");
      assert.equal(captured.body.response_format.json_schema.strict, true);
      assert.equal(captured.body.reasoning_effort, "none");
      assert.deepEqual(captured.body.chat_template_kwargs, { enable_thinking: false });
      assert.equal(config.lfm.timeoutMs, 4000);
      assert.equal(config.model.name, "Qwen3.8-27B-UD-Q4_K_M");
      assert.equal(PROBE_ENDPOINTS.qwen.name, config.model.name);
      assert.deepEqual([config.model.timeoutMs, config.model.maxTokens, config.cascade.timeoutMs,
        config.requestTimeoutMs], [16000, 768, 21000, 15000]);
    }
    assert.equal(bodies.length, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
