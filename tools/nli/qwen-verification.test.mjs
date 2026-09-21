import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { collectProbeMetadata } from "./probe-metadata.mjs";
import { createQwenVerifier } from "./qwen-verification.mjs";
import { runQwenVerification } from "./probe-verification.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);
const schemaBytes = await readFile(new URL("../../nli/model-decision.schema.json", import.meta.url), "utf8");
const schema = JSON.parse(schemaBytes);
const fixtures = JSON.parse(await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8"));

export function fakeQwen(context, state = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (state.stall) return new Promise(() => {});
    if (state.malformed) return new Response("bad");
    const payload = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith("/props")) return Response.json({ model_alias: "fixture-qwen", model_path: state.path || "/models/fixture",
      build_info: state.build || { version: "fake-build" }, chat_template: state.template ?? "{% if not enable_thinking %}<think>\n\n</think>{% endif %}" });
    if (url.endsWith("/apply-template")) return Response.json({ prompt: JSON.stringify(payload.messages) +
      "<|im_start|>assistant\n<think>" + (state.open ? "secret" : "\n\n</think>\n\n") });
    const text = payload.messages[2].content;
    let candidate;
    if (text.includes("이동")) candidate = { intent: "navigate", confidence: 1, targetId: "project-catequest" };
    else if (text.includes("P95")) candidate = { intent: "define_term", confidence: 1, term: "P95" };
    else if (text.includes("날씨")) candidate = { intent: "reject_out_of_scope", confidence: 1 };
    else {
      const available = new Set(JSON.parse(payload.messages[1].content).candidateSources.map((card) => card.id));
      const sourceIds = fixtures.find((item) => item.message === text)?.sourceIds;
      assert.ok(sourceIds?.length && sourceIds.every((id) => available.has(id)), "Expected fixture sources must be available");
      const answer = sourceIds.map((id) => id === "project-catequest" ? `CateQuest ${context.projectByTargetId.get(id).description}` :
        `${id.includes("catequest") ? "CateQuest N+1" : "Bookking"} ${context.sectionById.get(id).result}`).join("; ");
      candidate = { intent: "answer_portfolio", confidence: 1, sourceIds, answer };
    }
    return Response.json({ model: state.model || "fixture-qwen", choices: [{ finish_reason: state.finish || "stop",
      message: { role: "assistant", content: JSON.stringify(candidate), ...(state.reasoning ? { reasoning_details: "SECRET" } : {}) } }],
    ...(state.positive ? { usage: { output_tokens_details: { reasoning_tokens: 2 } } } : {}) });
  };
  return { calls, fetchImpl };
}

async function setup(t, state = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qwen-verify-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = createGatewayConfig({ LM_STUDIO_BASE_URL: "http://127.0.0.1:9876/v1" });
  const receipt = join(dir, "receipt.json");
  const fake = fakeQwen(context, state);
  const dependencies = { context, schemaBytes, fetchImpl: fake.fetchImpl, admission: createModelAdmission(4) };
  const verify = () => runQwenVerification({ settings: config.model, context, schema, schemaBytes, receipt }, dependencies);
  const gate = (extra = {}) => createQwenVerifier(config.model,
    { ...config.cascade, qwenVerificationFile: receipt }, { ...dependencies, ...extra });
  return { ...fake, state, dir, receipt, verify, gate, config, dependencies };
}

test("18 clean probes issue bound receipt; metadata-only gate preserves unknown accounting", async (t) => {
  const f = await setup(t);
  const report = await f.verify();
  assert.equal(report.verified, true, JSON.stringify(report));
  const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
  assert.equal(receipt.probeCount, 18);
  assert.equal(receipt.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(report.verificationPolicy, VERIFICATION_POLICY);
  assert.equal(receipt.reasoningAccounting, "unavailable");
  assert.equal(receipt.returnedModelId, "fixture-qwen");
  assert.equal(receipt.results.length, 18);
  const payloads = f.calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => JSON.parse(call.options.body));
  assert.equal(payloads.length, 18);
  assert.deepEqual(payloads.map((payload) => JSON.parse(payload.messages[1].content).conversation.length), [0, 2, 6].flatMap((n) => Array(6).fill(n)));
  assert.ok(payloads.every((payload) => payload.reasoning_effort === "none" && payload.chat_template_kwargs.enable_thinking === false));
  assert.equal((await stat(f.receipt)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.dir), ["receipt.json"]);
  assert.ok(!JSON.stringify(receipt).includes("SECRET"));
  const before = f.calls.length;
  const gate = f.gate();
  const result = await gate.verify({ deadlineAt: performance.now() + 8000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.elapsedMs >= 0);
  assert.ok(f.calls.slice(before).every((call) => !call.url.endsWith("/chat/completions")));
  gate.invalidate();
  assert.equal((await gate.verify()).reason, "qwen_unverified");
});

test("configured Qwen timeout covers both metadata proof passes during receipt issuance", async (t) => {
  const f = await setup(t);
  let time = 0;
  const fetchImpl = async (url, options) => {
    if (!url.endsWith("/chat/completions")) time += 60;
    return f.dependencies.fetchImpl(url, options);
  };
  const report = await runQwenVerification({ settings: { ...f.config.model, timeoutMs: 8000 },
    context, schema, schemaBytes, receipt: f.receipt }, { ...f.dependencies, fetchImpl, now: () => time });
  assert.equal(report.verified, true, JSON.stringify(report));
  assert.equal(report.metadataCalls, 38);
  assert.equal(report.inferenceCalls, 18);
  assert.equal(time, 2280);
});

test("baseline metadata uses the configured Qwen timeout and preserves the LFM one-second cap", async () => {
  const timeoutMs = 8000;
  const observed = [];
  const request = async (url, options) => {
    observed.push({ url, timeoutMs: options.timeoutMs });
    if (url.endsWith("/props")) return { ok: true, data: { model_alias: "fixture", model_path: "/fixture",
      build_info: "fixture", chat_template: "fixture" } };
    return { ok: true, data: { prompt: "<|im_start|>assistant\n<think>\n</think>\n" } };
  };
  const settings = { baseUrl: "http://127.0.0.1:9876/v1", timeoutMs, maxResponseBytes: 65536 };
  const metadata = await collectProbeMetadata("qwen", settings, { messages: [] }, { request });
  assert.equal(metadata.ok, true);
  assert.deepEqual(observed.map(({ timeoutMs: observedTimeout }) => observedTimeout), [timeoutMs, timeoutMs]);
  observed.length = 0;
  const lfm = await collectProbeMetadata("lfm", { ...settings, name: "fixture" }, { messages: [] }, { request: async (url, options) => {
    observed.push({ url, timeoutMs: options.timeoutMs });
    return { ok: true, data: { data: [{ id: "fixture", state: "loaded" }] } };
  } });
  assert.equal(lfm.ok, true);
  assert.deepEqual(observed.map(({ timeoutMs: observedTimeout }) => observedTimeout), [1000]);
});

test("runtime proof uses configured timeout while preserving a smaller caller budget", async (t) => {
  const f = await setup(t);
  await f.verify();
  let time = 0;
  const fetchImpl = async (url, options) => {
    time += 60;
    return f.dependencies.fetchImpl(url, options);
  };
  const gate = f.gate({ fetchImpl, now: () => time });
  const accepted = await gate.verify({ budgetMs: 8000, deadlineAt: 8000 });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.metadataCalls, 19);
  time = 0;
  const bounded = await f.gate({ fetchImpl, now: () => time }).verify({ budgetMs: 1000, deadlineAt: 8000 });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.detail, "timeout");
});

test("failed proof never writes receipt or persists raw reasoning", async (t) => {
  for (const state of [{ open: true }, { reasoning: true }, { positive: true }, { finish: "length" }, { model: "changed" }, { malformed: true }]) {
    const f = await setup(t, state);
    const report = await f.verify();
    assert.equal(report.ok, false, JSON.stringify(state));
    assert.ok(!JSON.stringify(report).includes("SECRET"));
    await assert.rejects(readFile(f.receipt));
  }
});

test("missing, stale, future, malformed, changed receipt and identity fail closed", async (t) => {
  const f = await setup(t);
  assert.equal((await f.gate().verify()).ok, false);
  await f.verify();
  const original = await readFile(f.receipt, "utf8");
  for (const checkedAt of [new Date(Date.now() - 86400001).toISOString(), new Date(Date.now() + 60000).toISOString(), "bad"]) {
    await writeFile(f.receipt, JSON.stringify({ ...JSON.parse(original), checkedAt }));
    assert.equal((await f.gate().verify()).ok, false);
  }
  await writeFile(f.receipt, "{");
  assert.equal((await f.gate().verify()).ok, false);
  await writeFile(f.receipt, original);
  assert.equal((await f.gate({ context: { ...context, prompt: context.prompt + "changed" } }).verify()).ok, false);
  f.state.path = "/changed";
  assert.equal((await f.gate().verify()).ok, false);
});

test("metadata deadline, caller abort and shared admission return bounded failure", async (t) => {
  const f = await setup(t);
  await f.verify();
  f.state.stall = true;
  const start = performance.now();
  assert.equal((await f.gate().verify({ budgetMs: 30 })).ok, false);
  assert.ok(performance.now() - start < 1500);
  const controller = new AbortController();
  const pending = f.gate().verify({ signal: controller.signal });
  controller.abort();
  assert.equal((await pending).detail, "aborted");
  assert.equal(f.dependencies.admission.active, 0);
  f.state.stall = false;
  const admission = createModelAdmission(1);
  const release = admission.acquire("occupied", 1);
  assert.equal((await f.gate({ admission }).verify()).detail, "busy");
  release();
});

test("all binding fields, representative rows and actual template/build changes invalidate", async (t) => {
  const f = await setup(t);
  await f.verify();
  const original = await readFile(f.receipt, "utf8");
  for (const key of ["endpoint", "requestedModelId", "promptSha256", "schemaSha256", "settingsSha256", "matrixSha256", "returnedModelId"]) {
    await writeFile(f.receipt, JSON.stringify({ ...JSON.parse(original), [key]: "changed" }));
    assert.equal((await f.gate().verify()).ok, false, key);
  }
  const broken = JSON.parse(original);
  broken.results[0].reasoningAccounting = "positive";
  await writeFile(f.receipt, JSON.stringify(broken));
  assert.equal((await f.gate().verify()).ok, false);
  await writeFile(f.receipt, original);
  for (const [key, value] of [["build", "new-build"], ["template", "new-template"], ["template", ""]]) {
    f.state[key] = value;
    assert.equal((await f.gate().verify()).ok, false);
    delete f.state[key];
  }
  assert.equal((await f.gate({ schemaBytes: schemaBytes + "\n" }).verify()).ok, false);
  const settings = { ...f.config.model };
  const gate = createQwenVerifier(settings, { ...f.config.cascade, qwenVerificationFile: f.receipt }, f.dependencies);
  settings.name = "mutated-after-snapshot";
  assert.equal((await gate.verify()).ok, true);
});

test("untrusted receipt files and disabled gates never dispatch metadata", async (t) => {
  const f = await setup(t);
  await f.verify();
  const before = f.calls.length;
  await chmod(f.receipt, 0o666);
  assert.equal((await f.gate().verify()).ok, false);
  await chmod(f.receipt, 0o600);
  const link = join(f.dir, "link.json");
  await symlink(f.receipt, link);
  const config = { ...f.config.cascade, qwenVerificationFile: link };
  assert.equal((await createQwenVerifier(f.config.model, config, f.dependencies).verify()).ok, false);
  assert.equal((await createQwenVerifier(f.config.model, { ...config, qwenEnabled: false }, f.dependencies).verify()).detail, "disabled");
  await writeFile(f.receipt, "x".repeat(65537));
  assert.equal((await f.gate().verify()).ok, false);
  assert.equal(f.calls.length, before);
});

test("actual CLI verify against loopback writes atomic receipt only on clean proof", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = {};
  const fake = fakeQwen(context, state);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const response = await fake.fetchImpl(`http://fixture${req.url}`, { body: body || undefined });
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  for (const [mode, invalid] of [["json_schema", false], ["json_schema", true], ["plain", false], ["plain", true]]) {
    state.reasoning = invalid;
    const receipt = join(dir, `receipt-${mode}-${invalid}.json`);
    const output = join(dir, `report-${mode}-${invalid}.json`);
    const child = spawn(process.execPath, ["tools/nli-model-probe.mjs", "--endpoint", "qwen", "--mode", "verify", "--output", output, "--receipt", receipt],
      { cwd: new URL("../../", import.meta.url), env: { ...process.env, LM_STUDIO_OUTPUT_MODE: mode,
        LM_STUDIO_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }, stdio: "pipe" });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(exit, invalid ? 1 : 0);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.selectedMode, mode);
    assert.equal(report.cleanup.receiptWritten, !invalid);
    if (invalid) await assert.rejects(readFile(receipt));
    else assert.equal(JSON.parse(await readFile(receipt, "utf8")).probeCount, 18);
  }
});

test("verified plain and schema receipts cannot authorize the other mode", async (t) => {
  const f = await setup(t);
  const schemaReport = await f.verify();
  assert.equal(schemaReport.verified, true);
  f.config.model.outputMode = "plain";
  assert.equal((await f.gate().verify()).ok, false);
  const before = f.calls.length;
  const plainReport = await f.verify();
  assert.equal(plainReport.verified, true);
  assert.equal(plainReport.selectedMode, "plain");
  assert.equal((await f.gate().verify()).ok, true);
  assert.notEqual(plainReport.binding.settingsSha256, schemaReport.binding.settingsSha256);
  assert.notEqual(plainReport.binding.matrixSha256, schemaReport.binding.matrixSha256);
  assert.ok(f.calls.slice(before).filter((call) => call.url.endsWith("/chat/completions"))
    .every((call) => !Object.hasOwn(JSON.parse(call.options.body), "response_format")));
  f.config.model.outputMode = "json_schema";
  assert.equal((await f.gate().verify()).ok, false);
});

test("old sanitizer receipts and present-invalid result rows fail before metadata", async (t) => {
  const f = await setup(t);
  await f.verify();
  const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
  const before = f.calls.length;
  const legacy = structuredClone(receipt);
  delete legacy.reasoningPolicy;
  const weaker = structuredClone(receipt);
  delete weaker.verificationPolicy;
  for (const bad of [legacy, weaker, { ...receipt, verificationPolicy: "old" },
    { ...receipt, verificationPolicy: "shared-acceptance-v1" },
    { ...receipt, results: receipt.results.map((row) => ({ ...row, reasoningAccounting: "invalid" })) }]) {
    await writeFile(f.receipt, JSON.stringify(bad));
    assert.equal((await f.gate().verify()).ok, false);
  }
  assert.equal(f.calls.length, before);
});
