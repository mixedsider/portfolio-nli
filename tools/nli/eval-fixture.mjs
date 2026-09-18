import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayConfig } from "./config.mjs";
import { runQwenVerification } from "./probe-verification.mjs";
import { context, comparison, proposal, partial, envelope } from "./model-cascade-fixtures.mjs";
import { loadTestCases } from "./test-fixtures.mjs";

export async function evalFixture({ tempRoot = tmpdir(), lfmPartial = false } = {}) {
  const directory = await mkdtemp(join(tempRoot, "eval-endpoints-"));
  const cases = (await loadTestCases("nli/live-test-cases.json")).map((item, index) => ({ ...item, id: `live-${index + 1}` }));
  const probeCases = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));
  const state = { runtime: false, calls: [], status: 200, reasoning: false, delayMs: 0, metadataModel: "fixture-qwen" };
  const servers = [];
  const timers = new Set();
  function probeCandidate(payload) {
    const message = payload.messages[2].content;
    if (message.includes("이동")) return { intent: "navigate", confidence: 1, targetId: "project-catequest" };
    if (message.includes("P95")) return { intent: "define_term", confidence: 1, term: "P95" };
    if (message.includes("날씨")) return { intent: "reject_out_of_scope", confidence: 1 };
    const available = JSON.parse(payload.messages[1].content).candidateSources.map((card) => card.id);
    const sourceIds = probeCases.find((item) => item.message === message).sourceIds.filter((id) => available.includes(id));
    const answer = sourceIds.map((id) => id === "project-catequest" ? `CateQuest ${context.projectByTargetId.get(id).description}` :
      `${id.includes("catequest") ? "CateQuest N+1" : "Bookking"} ${context.sectionById.get(id).result}`).join("; ");
    return { intent: "answer_portfolio", confidence: 1, sourceIds, answer };
  }
  async function start(endpoint) {
    const server = createServer(async (req, res) => {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = body ? JSON.parse(body) : null;
        state.calls.push({ endpoint, path: req.url, runtime: state.runtime });
        let response;
        if (req.url === "/api/v0/models") response = { data: [{ id: "fixture-lfm", state: "loaded", quantization: "Q4_K_M",
          loaded_context_length: 16384, max_context_length: 131072 }] };
        else if (req.url === "/props") response = { model_alias: state.metadataModel, model_path: "/models/fixture",
          build_info: { version: "fixture-build" }, chat_template: "{% if not enable_thinking %}<think>\n\n</think>{% endif %}" };
        else if (req.url === "/apply-template") response = { prompt: JSON.stringify(payload.messages) +
          "<|im_start|>assistant\n<think>\n\n</think>\n\n" };
        else {
          const message = payload.messages[2].content;
          const candidate = !state.runtime ? probeCandidate(payload) : message === comparison ?
            (endpoint === "lfm" && lfmPartial ? partial() : proposal()) :
            cases.find((item) => item.message === message)?.models?.lfm.response ?? { intent: "reject_out_of_scope", confidence: 1 };
          response = envelope(candidate, `fixture-${endpoint}`, endpoint === "qwen" && state.reasoning ?
            { reasoning_content: "NEVER_PERSIST_HIDDEN" } : {});
          response.usage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
            completion_tokens_details: { reasoning_tokens: 0 } };
        }
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(state.runtime ? state.status : 200, { "content-type": "application/json" });
          res.end(JSON.stringify(response));
        };
        if (state.delayMs && req.url.endsWith("chat/completions")) {
          const timer = setTimeout(() => { timers.delete(timer); send(); }, state.delayMs);
          timers.add(timer);
        } else send();
      } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}/v1`;
  }
  async function close() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    assert.ok(servers.every((server) => !server.listening));
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const env = { LFM_BASE_URL: await start("lfm"), LM_STUDIO_BASE_URL: await start("qwen"),
      LFM_MODEL: "fixture-lfm", LM_STUDIO_MODEL: "fixture-qwen", NLI_QWEN_VERIFICATION_FILE: join(directory, "receipt.json") };
    const config = createGatewayConfig(env);
    const proof = await runQwenVerification({ settings: config.model, context, receipt: config.cascade.qwenVerificationFile });
    assert.equal(proof.verified, true);
    state.runtime = true;
    return { directory, cases, config, context, state, env, proof, close };
  } catch (error) { await close(); throw error; }
}
