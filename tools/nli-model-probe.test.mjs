import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNliContext } from "./nli/context.mjs";
import { createModelClient } from "./nli/model-client.mjs";
import { prepareProbeCases, buildProbePayload, PROBE_ENDPOINTS } from "./nli/probe-request.mjs";
import { inspectProbeCompletion, matchesProbeExpectation } from "./nli/probe-result.mjs";
import { requestProbeJson } from "./nli/probe-http.mjs";
import { runProbe, selectProbeMode } from "./nli/probe-runner.mjs";
import { parseProbeArgs, main } from "./nli-model-probe.mjs";
import { prepareGroundedRequest } from "./nli/evidence-selection.mjs";

const root = new URL("../", import.meta.url).pathname;
const context = await loadNliContext(root);
const fixtures = JSON.parse(await readFile(new URL("../nli/model-probe-cases.json", import.meta.url), "utf8"));
const schema = JSON.parse(await readFile(new URL("../nli/model-decision.schema.json", import.meta.url), "utf8"));
const cases = prepareProbeCases(fixtures, context);
const envelope = (proposal, extra = {}) => ({ model: "test-model", choices: [{
  finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal) }
}], ...extra });
const proposal = { intent: "navigate", confidence: 0.01, targetId: "project-catequest" };

async function serverFor(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("existing client characterization: length JSON is accepted, reasoning-only is null", async (t) => {
  let onlyReasoning = false;
  const url = await serverFor(t, (_req, res) => res.end(JSON.stringify({ choices: [{
    finish_reason: "length", message: { content: onlyReasoning ? "" : JSON.stringify(proposal), reasoning_content: "private" }
  }] })));
  const ask = createModelClient({ model: { ...PROBE_ENDPOINTS.lfm, baseUrl: url, maxConcurrentRequests: 1 } });
  assert.deepEqual(await ask("fixture", context), proposal);
  onlyReasoning = true;
  assert.equal(await ask("fixture", context), null);
});

test("LFM probe caps oversized overrides at 6.5s while preserving smaller bounds and bound settings", async () => {
  for (const configured of [99000, 6000, 1234]) {
    const bounds = [];
    const settings = { ...PROBE_ENDPOINTS.lfm, timeoutMs: configured };
    const report = await runProbe({ endpoint: "lfm", mode: "verify", settings, cases, context, schema }, {
      collectMetadata: async () => ({ ok: true }),
      request: async (_url, options) => {
        bounds.push(options.timeoutMs);
        return { ok: false, kind: "timeout" };
      }
    });
    assert.deepEqual(bounds, Array(12).fill(Math.min(configured, 6500)));
    assert.deepEqual(report.settings, settings);
    assert.equal(report.verified, false);
  }
});

test("fixed real matrix and exact schema share identical bounded messages", () => {
  assert.equal(cases.length, 6);
  assert.throws(() => prepareProbeCases([], context));
  for (const item of cases) {
    const structured = buildProbePayload(item, context, schema, PROBE_ENDPOINTS.qwen, "json_schema");
    const plain = buildProbePayload(item, context, schema, PROBE_ENDPOINTS.qwen, "plain");
    assert.deepEqual(structured.response_format.json_schema.schema, schema);
    assert.deepEqual(structured.messages, plain.messages);
    assert.deepEqual(plain.messages.map((m) => m.role), ["system", "system", "user"]);
    assert.equal(plain.reasoning_effort, "none");
    assert.deepEqual(plain.chat_template_kwargs, { enable_thinking: false });
    assert.equal(plain.response_format, undefined);
    assert.deepEqual(JSON.parse(plain.messages[1].content).candidateSources, item.candidateSources);
    assert.ok(item.candidateSources.every((card) => Buffer.byteLength(card.evidence) <= 3000));
  }
});

test("probe preparation uses the exact runtime projection for all six classes and history sizes", () => {
  for (const length of [0, 2, 6]) {
    const history = Array.from({ length }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "CateQuest" }));
    const input = fixtures.map((item) => ({ ...item, history }));
    for (const item of prepareProbeCases(input, context)) {
      const runtime = prepareGroundedRequest(item.message, { ...context, history, currentTargetId: item.currentTargetId });
      assert.equal(JSON.stringify(item.grounded), runtime.groundedRequestBlock, item.id);
      assert.deepEqual(item.candidateSources, runtime.candidateSources);
      assert.strictEqual(item.candidateSources, item.grounded.candidateSources);
      assert.ok(Object.isFrozen(item.grounded));
      const fixture = fixtures.find((entry) => entry.id === item.id);
      assert.deepEqual(item.expected, fixture.expected);
      assert.deepEqual(item.sourceIds, fixture.sourceIds);
      for (const group of item.expected.groups || []) assert.ok(item.candidateSources.some((card) => card.id === group.sourceId));
      for (const mode of ["plain", "json_schema"]) {
        assert.equal(buildProbePayload(item, context, schema, PROBE_ENDPOINTS.qwen, mode).messages[1].content, runtime.groundedRequestBlock);
      }
    }
  }
  const bad = fixtures.map((item, i) => i ? item : { ...item, sourceIds: ["fake-source"] });
  assert.throws(() => prepareProbeCases(bad, context), /Unregistered probe source/);
});

test("strict envelope failure matrix never persists reasoning or invalid visible content", () => {
  const bad = [
    { choices: [] }, { choices: [envelope(proposal).choices[0], envelope(proposal).choices[0]] },
    { choices: [{ ...envelope(proposal).choices[0], finish_reason: "length" }] },
    { choices: [{ finish_reason: "stop", message: { role: "user", content: "{}" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: "SECRET" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "```json\n{}\n```" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "<think>SECRET</think>{}" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "[]" } }] },
    { choices: [{ finish_reason: "stop", message: { ...envelope(proposal).choices[0].message, tool_calls: [{}] } }] }
  ];
  for (const body of bad) {
    const result = inspectProbeCompletion({ model: "test", ...body }, cases[0], context, "lfm");
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    assert.equal(result.visibleAnswer, undefined);
  }
  const body = envelope(proposal);
  body.choices[0].message.reasoning_content = "SECRET";
  const lfm = inspectProbeCompletion(body, cases[0], context, "lfm");
  assert.equal(lfm.ok, true);
  assert.equal(lfm.reasoning.bytes, 6);
  assert.equal(lfm.reasoning.accounting, "unavailable");
  assert.equal(inspectProbeCompletion(body, cases[0], context, "qwen").ok, false);
  body.choices[0].message.reasoning_content = "";
  body.usage = { completion_tokens_details: { reasoning_tokens: 1 } };
  assert.equal(inspectProbeCompletion(body, cases[0], context, "qwen").ok, false);
});

test("strict proposal and fixture intent/scope are independently enforced", () => {
  for (const candidate of [{ ...proposal, extra: true }, { ...proposal, targetId: "about" },
    { intent: "reject_out_of_scope", confidence: 1 }]) {
    assert.equal(inspectProbeCompletion(envelope(candidate), cases[0], context, "lfm").ok, false);
  }
  const partial = { intent: "answer_portfolio", confidence: 1, answer: "CateQuest N+1 해결", sourceIds: ["project-catequest-n1", "project-bookking-https"] };
  assert.equal(inspectProbeCompletion(envelope(partial), cases[4], context, "lfm").ok, false);
});

test("probe groups can require a source and topic without a label", () => {
  const section = cases.find((item) => item.id === "section-explanation");
  const project = cases.find((item) => item.id === "project-summary");
  assert.ok(section);
  assert.ok(project);
  const topicOnly = { ...section, expected: { ...section.expected,
    groups: [{ sourceId: "project-catequest-n1", topic: "N+1" }] } };
  const candidate = { intent: "answer_portfolio", confidence: 0.01,
    answer: "N+1 문제를 DTO Projection과 JPQL 조인으로 해결했습니다.",
    sourceIds: ["project-catequest-n1"] };
  assert.equal(matchesProbeExpectation(candidate, topicOnly), true);
  assert.equal(inspectProbeCompletion(envelope(candidate), topicOnly, context, "lfm").ok, true);
  assert.equal(matchesProbeExpectation({ ...candidate, answer: "쿼리 문제를 해결했습니다." }, topicOnly), false);
  assert.equal(matchesProbeExpectation({ ...candidate, sourceIds: ["project-catequest"] }, topicOnly), false);
  assert.equal(matchesProbeExpectation({ ...candidate, sourceIds: ["project-catequest"],
    answer: context.projectByTargetId.get("project-catequest").description }, project), false);
  for (const label of [null, false, 0, ""]) {
    const malformed = { ...topicOnly, expected: { ...topicOnly.expected,
      groups: [{ ...topicOnly.expected.groups[0], label }] } };
    assert.equal(matchesProbeExpectation(candidate, malformed), false);
  }
});

test("bounded HTTP covers status, redirect, malformed body, limit, disconnect and both timeout phases", async (t) => {
  let requestReady;
  let responseAllowed;
  const url = await serverFor(t, async (req, res) => {
    if (!req.url.includes("timeout")) {
      const allowed = responseAllowed;
      requestReady(req.url);
      await allowed;
    }
    if (req.url === "/status") { res.writeHead(400); res.end('schema unsupported'); }
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/ok" }); res.end(); }
    if (req.url === "/invalid") res.end("SECRET non-json");
    if (req.url === "/large") res.end("x".repeat(200));
    if (req.url === "/disconnect") req.socket.destroy();
    if (req.url === "/body-timeout") { res.writeHead(200); res.write("{"); }
    if (req.url === "/ok") res.end("{}");
  });
  for (const [path, kind] of [["status", "http_error"], ["redirect", "network_error"],
    ["invalid", "invalid_json"], ["large", "body_limit"], ["disconnect", "network_error"],
    ["timeout", "timeout"], ["body-timeout", "timeout"]]) {
    const ready = Promise.withResolvers();
    const response = Promise.withResolvers();
    requestReady = ready.resolve;
    responseAllowed = response.promise;
    const pending = requestProbeJson(`${url}/${path}`, { timeoutMs: path.includes("timeout") ? 100 : 2000, maxResponseBytes: 100 });
    if (!path.includes("timeout")) {
      try {
        const arrived = await Promise.race([ready.promise, pending.then(() => { throw new Error("Request ended before server readiness"); })]);
        assert.equal(arrived, `/${path}`);
      } finally { response.resolve(); }
    }
    const result = await pending;
    assert.equal(result.kind, kind, path);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

test("mode selection cannot turn semantic failure into plain fallback", () => {
  assert.equal(selectProbeMode([], 6), null);
  const rows = ["json_schema", "plain"].flatMap((outputMode) => cases.map((item) => ({ caseId: item.id, outputMode, ok: true })));
  assert.equal(selectProbeMode(rows, 6), "json_schema");
  rows[0].ok = false;
  assert.equal(selectProbeMode(rows, 6), null);
  rows[0].schemaUnsupported = true;
  assert.equal(selectProbeMode(rows, 6), "plain");
});

test("runner fake baseline covers both modes without granting Qwen verification", async (t) => {
  let rejectSchema = false;
  const url = await serverFor(t, async (req, res) => {
    if (req.url === "/props") { res.end(JSON.stringify({ model_alias: "test-model", model_path: "test", build_info: "test", chat_template: "test" })); return; }
    if (req.url === "/apply-template") { res.end(JSON.stringify({ prompt: "<think>\n\n</think>\n\n" })); return; }
    if (req.url === "/api/v0/models") { res.end(JSON.stringify({ data: [{ id: PROBE_ENDPOINTS.lfm.name, state: "loaded" }] })); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    if (rejectSchema && payload.response_format) { res.writeHead(400); res.end("schema unsupported"); return; }
    const item = cases.find((entry) => entry.message === payload.messages[2].content);
    const answer = item.id === "project-summary" ? `CateQuest ${context.projectByTargetId.get("project-catequest").description}` :
      item.expected.groups?.map((group) => `${group.label} ${group.topic || (group.sourceId === "project-catequest-n1" ? "N+1" : "")} ${context.sectionById.get(group.sourceId).result}`).join(" ");
    res.end(JSON.stringify(envelope(item.expected.intent === "navigate" ? proposal :
      item.expected.intent === "define_term" ? { intent: "define_term", confidence: 1, term: "P95" } :
        item.expected.intent === "answer_portfolio" ? { intent: "answer_portfolio", confidence: 0.01, answer, sourceIds: item.sourceIds } :
        { intent: "reject_out_of_scope", confidence: 1 })));
  });
  const report = await runProbe({ endpoint: "qwen", mode: "baseline", cases, context, schema,
    settings: { ...PROBE_ENDPOINTS.qwen, baseUrl: url } });
  assert.equal(report.results.length, 12);
  assert.ok(report.results.every((row) => row.ok), JSON.stringify(report.results));
  assert.equal(report.selectedMode, "json_schema");
  assert.equal(report.verified, false);
  assert.ok(report.blockers.includes("qwen_verifier_unavailable"));
  const lfm = await runProbe({ endpoint: "lfm", mode: "baseline", cases, context, schema,
    settings: { ...PROBE_ENDPOINTS.lfm, baseUrl: url } });
  assert.equal(lfm.ok, true);
  assert.equal(lfm.verified, false);
  assert.equal(lfm.selectedMode, "json_schema");
  rejectSchema = true;
  const plain = await runProbe({ endpoint: "lfm", mode: "baseline", cases, context, schema,
    settings: { ...PROBE_ENDPOINTS.lfm, baseUrl: url } });
  assert.equal(plain.selectedMode, "plain");
  assert.equal(plain.results.length, 12);
  assert.equal(plain.results.filter((row) => row.schemaUnsupported).length, 6);
});

test("CLI rejects invalid flags and verify emits no receipt even on endpoint failure", async (t) => {
  for (const args of [[], ["--endpoint", "other"], ["--endpoint", "lfm", "--mode", "wat", "--output", "x"],
    ["--endpoint", "lfm", "--mode", "baseline", "--output", "x", "--receipt", "y"],
    ["--endpoint", "qwen", "--mode", "baseline", "--output", "x", "--output", "y"]]) {
    assert.throws(() => parseProbeArgs(args));
  }
  const dir = await mkdtemp(join(tmpdir(), "nli-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receipt = join(dir, "receipt.json");
  const output = join(dir, "report.json");
  const code = await main(["--endpoint", "qwen", "--mode", "verify", "--output", output, "--receipt", receipt], {
    run: async () => ({ verified: false, ok: false, blockers: ["qwen_verifier_unavailable"] })
  });
  assert.equal(code, 1);
  await assert.rejects(access(receipt));
  assert.equal(JSON.parse(await readFile(output, "utf8")).verified, false);
});
