import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createNliServer, loadNliContext, resolveNliRequest } from "./nli-gateway.mjs";
import { createGatewayConfig } from "./nli/config.mjs";
import { createRequestResolver } from "./nli/request-resolution.mjs";
import { readNliRequest } from "./nli/http.mjs";
import { expectedRouting } from "./nli/eval-routing.mjs";

const context = await loadNliContext();
const config = createGatewayConfig({ LFM_BASE_URL: "http://127.0.0.1:1", LM_STUDIO_BASE_URL: "http://127.0.0.1:1" });
const commands = ["도움말", "CateQuest로 이동"];
const cases = commands.flatMap((command) => [
  { name: `plain ${command}`, message: command },
  { name: `ASCII whitespace ${command}`, message: ` \t${command}\r\n` },
  ...["\uFEFF", "\u200B"].flatMap((character) => [
    { name: `leading U+${character.codePointAt(0).toString(16)} ${command}`, message: character + command },
    { name: `trailing U+${character.codePointAt(0).toString(16)} ${command}`, message: command + character }
  ])
]);

test("evaluator producer independently uses single-LLM qwen routing", () => {
  for (const item of cases) {
    const expected = expectedRouting(item, context);
    assert.ok(expected.some((row) => row.stage === "qwen" && row.lfmCalls === 0 && row.qwenCalls === 1), item.name);
  }
});

for (const item of cases) {
  test(`resolver and evaluator route commands through single-LLM qwen stage: ${item.name}`, async () => {
    const calls = [];
    const events = [];
    const resolver = createRequestResolver(config, { context, observer: (event) => events.push(event),
      qwenClient: async (message) => { calls.push(message);
        return { tag: "failure", kind: "http_error", metadata: { endpoint: "qwen", dispatchCount: 1 } }; } });
    assert.equal(readNliRequest({ message: item.message }, 500).message, item.message);
    await resolver(item.message);
    assert.equal(calls.length, 1);
    assert.equal(events.filter((event) => event.type === "attempt" && event.stage === "qwen").length, 1);
    assert.equal(calls[0], item.message.trim(), "model normalization remains separate and unchanged");
    const expectations = expectedRouting(item, context);
    assert.ok(expectations.some((row) => row.stage === "qwen" && row.lfmCalls === 0 && row.qwenCalls === 1));
  });
}

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

test("actual HTTP boundary routes through single-LLM qwen stage", async (t) => {
  const calls = { lfm: [], qwen: [] };
  const urls = {};
  for (const endpoint of ["lfm", "qwen"]) {
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      calls[endpoint].push(JSON.parse(body));
      response.writeHead(503); response.end();
    });
    urls[endpoint] = await listen(server);
    t.after(() => close(server));
  }
  const events = [];
  const server = await createNliServer({ context,
    config: createGatewayConfig({ LFM_BASE_URL: urls.lfm, LM_STUDIO_BASE_URL: urls.qwen }),
    observer: (event) => events.push(event) });
  const url = await listen(server);
  t.after(() => close(server));
  const post = (message) => fetch(`${url}/api/nli`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }) });
  for (const item of cases) {
    await t.test(item.name, async () => {
      calls.lfm.length = 0; calls.qwen.length = 0; events.length = 0;
      const response = await post(item.message);
      const body = await response.json();
      assert.ok([200, 503].includes(response.status));
      assert.equal(calls.lfm.length, 0);
      assert.equal(calls.qwen.length, 1);
      assert.equal(events.filter((event) => event.type === "attempt" && event.stage === "qwen").length, 1);
      assert.equal("stage" in body || "model" in body, false);
    });
  }
  calls.qwen.length = 0;
  assert.equal((await post(" \t\r\n")).status, 200);
  assert.equal((await post("x".repeat(config.maxMessageLength + 1))).status, 413);
  assert.equal(calls.qwen.length, 0);
});

test("offline and legacy normalization and empty/size validation remain unchanged", async () => {
  for (const command of commands) {
    const plain = await resolveNliRequest(command, context, { useModel: false });
    assert.deepEqual(await resolveNliRequest(`\uFEFF${command}\uFEFF`, context, { useModel: false }), plain);
    const calls = [];
    await resolveNliRequest(`\uFEFF${command}\uFEFF`, context, {
      modelClient: async (message) => { calls.push(message); return null; }
    });
    assert.deepEqual(calls, [command]);
  }
  assert.equal(readNliRequest({ message: " \t\r\n" }, 500).message, " \t\r\n");
  assert.throws(() => readNliRequest({ message: "\uFEFF도움말" }, 3), (error) => error.statusCode === 413);
  assert.throws(() => readNliRequest({ message: null }, 500), (error) => error.statusCode === 400);
});
