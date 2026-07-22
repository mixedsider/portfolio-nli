import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "./context.mjs";
import { createModelClient } from "./model-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const context = await loadNliContext(root);

test("model client disables reasoning, ignores reasoning_content, and accepts only visible strict JSON", async () => {
  const receivedPayloads = [];
  const upstream = createServer(async (request, response) => {
    const payload = JSON.parse(await readRequestBody(request));
    receivedPayloads.push(payload);
    const message = payload.messages.at(-1).content;
    const content =
      message === "visible JSON" ? JSON.stringify({ intent: "reject_out_of_scope", confidence: 1 }) : message === "empty" ? "" : "<think>reasoning only</think>";

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content, reasoning_content: "hidden chain-of-thought must be ignored" } }]
      })
    );
  });
  const baseUrl = await listen(upstream);
  const config = createGatewayConfig({
    LM_STUDIO_BASE_URL: baseUrl,
    LM_STUDIO_MODEL: "local-test-model",
    LM_STUDIO_TIMEOUT_MS: "1000",
    LM_STUDIO_MAX_TOKENS: "64",
    LM_STUDIO_MAX_RESPONSE_BYTES: "8192",
    LM_STUDIO_MAX_CONCURRENT_REQUESTS: "1"
  });
  const askModel = createModelClient(config);

  try {
    assert.deepEqual(await askModel("visible JSON", context), { intent: "reject_out_of_scope", confidence: 1 });
    assert.equal(await askModel("empty", context), null);
    await assert.rejects(askModel("reasoning-only", context), SyntaxError);
    assert.deepEqual(receivedPayloads.map((payload) => payload.reasoning_effort), ["none", "none", "none"]);
  } finally {
    await close(upstream);
  }
});

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Fake LM Studio server did not expose a TCP port"));
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
