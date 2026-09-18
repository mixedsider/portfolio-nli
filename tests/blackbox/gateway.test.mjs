import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { startTestApp } from "../support/app-process.mjs";

async function post(app, body, headers = {}) {
  return fetch(`${app.gatewayUrl}/api/nli`, { method: "POST",
    headers: { "content-type": "application/json", Origin: app.staticUrl, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}

test("health exposes only public process/context fields when the app is ready", async (t) => {
  // Given the real separate application child.
  const app = await startTestApp(); t.after(app.close);
  // When its public health endpoint is read.
  const response = await fetch(`${app.gatewayUrl}/api/nli/health`);
  const body = await response.json();
  // Then there is no model URL, receipt, readiness or control field.
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["ok", "processId", "revision", "targets", "terms"]);
  assert.equal(body.ok, true);
  assert.ok(body.targets > 0 && body.terms > 0 && body.processId > 0);
  assert.equal(typeof body.revision, "string");
});

test("serves actual portfolio assets while hiding private files", async (t) => {
  // Given the production static server.
  const app = await startTestApp(); t.after(app.close);
  // When fetching its real assets and private paths.
  for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/styles.css", "text/css"]]) {
    const response = await fetch(`${app.staticUrl}${path}`);
    // Then content is present with its public media type.
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").startsWith(type));
    assert.ok((await response.text()).length > 100);
  }
  for (const path of ["/.env", "/.nli/qwen-no-thinking.json"]) {
    assert.equal((await fetch(`${app.staticUrl}${path}`)).status, 404);
  }
});

test("exact help bypasses both models when sent with the allowed origin", async (t) => {
  // Given an isolated healthy instance.
  const app = await startTestApp(); t.after(app.close);
  // When an exact local command arrives.
  const response = await post(app, { message: "도움말" });
  // Then the actual upstream counters remain zero.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), app.staticUrl);
  assert.equal((await response.json()).intent, "list_capabilities");
  assert.deepEqual(await app.stats(), { lfm: 0, qwen: 0 });
});

test("profile uses one LFM completion with real portfolio sources", async (t) => {
  // Given a valid current target and completed conversation history.
  const app = await startTestApp(); t.after(app.close);
  // When a profile request reaches the real resolver.
  const response = await post(app, { message: "자기소개해줘", currentTargetId: "project-catequest",
    history: [{ role: "user", text: "도움말" }, { role: "assistant", text: "포트폴리오를 안내합니다." }] });
  const body = await response.json();
  // Then LFM is adopted and the Gateway owns the source labels.
  assert.equal(response.status, 200);
  assert.equal(body.intent, "answer_portfolio");
  assert.deepEqual(body.sources.map((source) => source.id), ["about"]);
  assert.ok(body.sources.every((source) => typeof source.label === "string" && source.label.length > 0));
  assert.match(body.answer, /Backend & Infra Developer/);
  assert.deepEqual(await app.stats(), { lfm: 1, qwen: 0 });
});

test("complex comparison escalates through real receipt verification to Qwen", async (t) => {
  // Given incomplete LFM only for the complex comparison scenario.
  const app = await startTestApp({ scenario: "escalation" }); t.after(app.close);
  // When both projects are requested.
  const response = await post(app, { message: "CateQuest와 Bookking의 성능 개선을 비교해줘",
    currentTargetId: "project-makertion-db", history: [] });
  const body = await response.json();
  // Then both projects are grounded and exactly one real HTTP call reached each model.
  assert.equal(response.status, 200);
  assert.equal(body.intent, "answer_portfolio");
  assert.deepEqual(body.sources.map((source) => source.id).sort(), ["project-bookking-https", "project-catequest-n1"]);
  assert.match(body.answer, /Bookking/);
  assert.deepEqual(await app.stats(), { lfm: 1, qwen: 1 });
});

for (const [name, body, headers, status, code] of [
  ["blocked origin", { message: "도움말" }, { Origin: "https://attacker.example" }, 403, "ORIGIN_NOT_ALLOWED"],
  ["bad JSON", "{", {}, 400, "INVALID_REQUEST"],
  ["invalid history", { message: "도움말", history: [{ role: "system", text: "bad" }] }, {}, 400, "INVALID_REQUEST"],
  ["oversized body", { message: "a".repeat(17_000) }, {}, 413, "REQUEST_TOO_LARGE"],
  ["wrong media type", { message: "도움말" }, { "content-type": "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"]
]) {
  test(`rejects ${name} before any inference`, async (t) => {
    // Given an invalid public HTTP request.
    const app = await startTestApp(); t.after(app.close);
    // When it reaches the Gateway boundary.
    const response = await post(app, body, headers);
    // Then the stable error contract is returned without model calls.
    assert.equal(response.status, status);
    const error = await response.json();
    assert.equal(error.errorCode, code);
    assert.equal(typeof error.requestId, "string");
    assert.deepEqual(await app.stats(), { lfm: 0, qwen: 0 });
  });
}

test("returns 429 when the isolated request limit is consumed", async (t) => {
  // Given a one-request fixture whose first request has completed.
  const app = await startTestApp({ scenario: "rate-limited" }); t.after(app.close);
  assert.equal((await post(app, { message: "도움말" })).status, 200);
  // When a second request arrives in the same window.
  const response = await post(app, { message: "도움말" });
  // Then retry metadata and public error agree.
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal((await response.json()).errorCode, "RATE_LIMITED");
  assert.deepEqual(await app.stats(), { lfm: 0, qwen: 0 });
});

test("returns 503 when upstream fails and no compatible trusted fallback exists", async (t) => {
  // Given a fake model that fails over real HTTP, not an injected Gateway result.
  const app = await startTestApp({ scenario: "upstream-error" }); t.after(app.close);
  // When asking a question whose local fallback cannot satisfy the request.
  const response = await post(app, { message: "포트폴리오 정보의 색상은?" });
  // Then the production resolver emits its public unavailable contract.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).errorCode, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(await app.stats(), { lfm: 1, qwen: 0 });
});

test("survives client cancellation and closes listeners", async () => {
  // Given a client which has sent headers but not completed the body.
  const app = await startTestApp();
  const pending = request(`${app.gatewayUrl}/api/nli`, { method: "POST",
    headers: { "content-type": "application/json", "content-length": "100" } });
  pending.on("error", () => {});
  try {
    await new Promise((resolve) => { pending.on("socket", (socket) => socket.once("connect", resolve)); pending.flushHeaders(); });
    // When the client cancels, the service still handles a new request.
    pending.destroy();
    assert.equal((await post(app, { message: "도움말" })).status, 200);
    assert.deepEqual(await app.stats(), { lfm: 0, qwen: 0 });
  } finally { pending.destroy(); await app.close(); }
  // Then close resolves only after the listeners are gone.
  await assert.rejects(fetch(`${app.gatewayUrl}/api/nli/health`));
  await assert.rejects(fetch(app.staticUrl));
});
