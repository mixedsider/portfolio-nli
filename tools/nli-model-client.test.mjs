import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadNliContext } from "./nli/context.mjs";
import { createModelClient } from "./nli/model-client.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const context = await loadNliContext(root);

test("model client accepts trimmed raw JSON but rejects a whole-response JSON fence", async () => {
  const expected = { intent: "reject_out_of_scope", confidence: 1 };
  const rawJson = JSON.stringify(expected);

  assert.deepEqual(await askWithFakeModelContent(`\n  ${rawJson}\n`), expected);
  await assert.rejects(
    askWithFakeModelContent(`\`\`\`json\n${rawJson}\n\`\`\``),
    SyntaxError
  );
});

async function askWithFakeModelContent(content) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await listen(server);

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fake LM server did not expose a TCP port");
    const modelClient = createModelClient({
      model: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        name: "local-test-model",
        timeoutMs: 1_000,
        maxTokens: 64,
        maxResponseBytes: 8_192,
        maxConcurrentRequests: 1
      }
    });
    return await modelClient("strict JSON probe", context);
  } finally {
    await close(server);
  }
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
