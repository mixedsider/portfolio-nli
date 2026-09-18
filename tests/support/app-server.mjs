import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { evalFixture } from "../../tools/nli/eval-fixture.mjs";
import { createGatewayConfig } from "../../tools/nli/config.mjs";
import { createStaticServer } from "../../tools/static-server.mjs";
import { assertScenario } from "./app-scenarios.mjs";

const servers = [];
const abort = new AbortController();
let fixture;
let closing;
async function close() {
  closing ??= (async () => {
    abort.abort();
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
    await fixture?.close();
    if (process.connected) process.disconnect();
  })();
  return closing;
}
async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

try {
  const scenario = process.env.TEST_APP_SCENARIO || "healthy";
  assertScenario(scenario);
  fixture = await evalFixture({ tempRoot: process.env.TEST_APP_DIRECTORY, lfmPartial: scenario === "escalation" });
  if (scenario === "upstream-error") fixture.state.status = 503;
  const staticUrl = await listen(createStaticServer({ root: fileURLToPath(new URL("../../", import.meta.url)) }));
  const env = { ...fixture.env, NLI_HOST: "127.0.0.1", NLI_PORT: "0", NLI_ALLOWED_ORIGINS: staticUrl,
    GIT_COMMIT_SHA: "test-app", ...(scenario === "rate-limited" ? { NLI_RATE_LIMIT_MAX: "1" } : {}) };
  // Importing the Gateway builds its default resolver: override real URLs BEFORE that import.
  // The server below uses only this explicit config, never values loaded from .env.
  Object.assign(process.env, env);
  const config = createGatewayConfig(env);
  const { createNliServer } = await import("../../tools/nli-gateway.mjs");
  const gatewayUrl = await listen(await createNliServer({ config, context: fixture.context, signal: abort.signal }));
  const controlUrl = await listen(createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/stats") { response.writeHead(404); response.end(); return; }
    const counts = { lfm: 0, qwen: 0 };
    for (const call of fixture.state.calls) {
      if (call.runtime && call.path === "/v1/chat/completions") counts[call.endpoint] += 1;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(counts));
  }));
  for (const signal of ["SIGTERM", "SIGINT", "disconnect"]) process.once(signal, () => {
    close().catch(() => { process.exitCode = 1; });
  });
  console.log(JSON.stringify({ type: "test-app-ready", staticUrl, gatewayUrl, controlUrl }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Fixture startup failed");
  await close();
  process.exitCode = 1;
}
