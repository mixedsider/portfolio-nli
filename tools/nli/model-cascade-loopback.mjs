import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createGatewayConfig } from "./config.mjs";
import { runQwenVerification } from "./probe-verification.mjs";
import { context, envelope, partial, proposal } from "./model-cascade-fixtures.mjs";

export async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "loopback arrival timed out");
    await delay(2);
  }
}

const probeFixtures = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));

function probeCandidate(payload) {
  const text = payload.messages[2].content;
  if (text.includes("이동")) return { intent: "navigate", confidence: 1, targetId: "project-catequest" };
  if (text.includes("P95")) return { intent: "define_term", confidence: 1, term: "P95" };
  if (text.includes("날씨")) return { intent: "reject_out_of_scope", confidence: 1 };
  const available = new Set(JSON.parse(payload.messages[1].content).candidateSources.map((card) => card.id));
  const sourceIds = probeFixtures.find((item) => item.message === text)?.sourceIds;
  assert.ok(sourceIds?.length && sourceIds.every((id) => available.has(id)), "Expected fixture sources must be available");
  const answer = sourceIds.map((id) => id === "project-catequest" ? `CateQuest ${context.projectByTargetId.get(id).description}` :
    `${id.includes("catequest") ? "CateQuest N+1" : "Bookking"} ${context.sectionById.get(id).result}`).join("; ");
  return { intent: "answer_portfolio", confidence: 1, sourceIds, answer };
}

// Fixture HTTP only: no LAN addresses, real receipts or production endpoint changes.
export async function loopbackFixture({ maxConcurrentRequests = 4 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "model-cascade-"));
  const state = { runtime: false, lfmComplete: false, model: "fixture-qwen", reasoning: false,
    lfmHold: null, propsHold: null, status: 200, calls: [], active: 0, maxActive: 0 };
  const servers = [];
  const start = async (endpoint) => {
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = body ? JSON.parse(body) : null;
      const call = { endpoint, path: req.url, payload, runtime: state.runtime };
      state.calls.push(call);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      let released = false;
      const release = () => { if (!released) { released = true; state.active -= 1; } };
      res.once("finish", release);
      res.once("close", release);
      if (state.runtime && endpoint === "lfm" && state.lfmHold) await state.lfmHold;
      if (state.runtime && req.url === "/props" && state.propsHold) await state.propsHold;
      if (res.destroyed) return;
      let response;
      if (req.url === "/props") response = { model_alias: "fixture-qwen", model_path: "/models/fixture",
        build_info: { version: "fixture-build" }, chat_template: "{% if not enable_thinking %}<think>\n\n</think>{% endif %}" };
      else if (req.url === "/apply-template") response = { prompt: JSON.stringify(payload.messages) +
        "<|im_start|>assistant\n<think>\n\n</think>\n\n" };
      else {
        const candidate = !state.runtime ? probeCandidate(payload) : payload.messages[2].content.includes("P95") ?
          { intent: "define_term", confidence: 0.01, term: "P95" } :
          endpoint === "lfm" && !state.lfmComplete ? partial() : proposal();
        response = envelope(candidate, endpoint === "lfm" ? "fixture-lfm" : state.model,
          endpoint === "qwen" && state.reasoning ? { reasoning_content: "NEVER_LOG_THIS" } : {});
      }
      res.writeHead(state.runtime ? state.status : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}/v1`;
  };
  const close = async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const lfm = await start("lfm");
    const qwen = await start("qwen");
    const config = createGatewayConfig({ LFM_BASE_URL: lfm, LM_STUDIO_BASE_URL: qwen,
      NLI_QWEN_VERIFICATION_FILE: join(directory, "receipt.json"),
      NLI_CASCADE_MAX_CONCURRENT_REQUESTS: String(maxConcurrentRequests) });
    const proof = await runQwenVerification({ settings: config.model, context, receipt: config.cascade.qwenVerificationFile });
    assert.equal(proof.verified, true, "fixture receipt must pass real 18-completion verifier");
    state.runtime = true;
    state.maxActive = 0;
    return { config, state, close, directory, proof,
      calls: (endpoint, path = "/v1/chat/completions") => state.calls.filter((call) => call.runtime && call.endpoint === endpoint && call.path === path) };
  } catch (error) {
    await close();
    throw error;
  }
}
