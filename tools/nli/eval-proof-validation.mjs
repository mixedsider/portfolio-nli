import { isDeepStrictEqual as same } from "node:util";
import { selectProbeMode } from "./probe-runner.mjs";
import { validReceipt } from "./qwen-verification-proof.mjs";
import { parseProbeArgs } from "../nli-model-probe.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";
import { PROPOSAL_FAILURE_REASONS } from "./proposal-acceptance.mjs";
import { MODEL_FAILURE_KINDS } from "./model-outcome.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === "string" && value.trim().length > 0;
const commonKeys = ["version", "endpoint", "mode", "ok", "verified", "exitStatus", "checkedAt", "status", "blockers",
  "selectedMode", "results", "command", "cleanup", "evaluationBinding", "verificationPolicy"];
function common(report, inputs, now) {
  const time = typeof report?.checkedAt === "string" ? Date.parse(report.checkedAt) : NaN;
  const command = Array.isArray(report?.command) ? parseProbeArgs(report.command.slice(2)) : null;
  return object(report) && report.version === 1 && report.endpoint === inputs.binding.endpoint && report.mode === "verify" &&
    report.verificationPolicy === VERIFICATION_POLICY && inputs.binding.verificationPolicy === VERIFICATION_POLICY &&
    report.ok === true && report.verified === true && report.exitStatus === 0 && report.status === "live-verified" &&
    same(report.blockers, []) && report.selectedMode === inputs.settings.outputMode && Number.isFinite(time) &&
    time <= now && now - time <= 86400000 && same(report.evaluationBinding, inputs.binding) &&
    Array.isArray(report.results) && report.results.length === inputs.matrix.length &&
    same(report.cleanup, { isolatedServers: 0, receiptWritten: report.endpoint === "qwen", pendingRequests: 0 }) &&
    Array.isArray(report.command) && report.command.every(text) && report.command[1] === "tools/nli-model-probe.mjs" &&
    command?.endpoint === report.endpoint && command.mode === "verify" && (report.endpoint !== "qwen" || text(command.receipt));
}

function lfmRow(row, expected, inputs) {
  const allowed = ["caseId", "outputMode", "ok", "kind", "status", "bytes", "elapsedMs", "requestBytes", "groundedSha256",
    "returnedModel", "finishReason", "visibleBytes", "reasoning", "choiceCount", "usage", "validation", "visibleAnswer", "schemaUnsupported"];
  if (!keys(row, allowed) || row.caseId !== expected.item.id || row.outputMode !== expected.outputMode ||
    row.groundedSha256 !== expected.groundedSha256 || row.requestBytes !== expected.requestBytes ||
    !integer(row.bytes) || !nonnegative(row.elapsedMs) ||
    !(row.status === null || (Number.isInteger(row.status) && row.status >= 100 && row.status <= 599))) return false;
  if (row.ok === false) {
    return [...MODEL_FAILURE_KINDS, ...PROPOSAL_FAILURE_REASONS, "network_error", "empty_visible", "invalid_proposal", "fixture_expectation"].includes(row.kind) &&
      (row.validation === undefined || same(row.validation, { ok: false }) || (same(Object.keys(row.validation).sort(), ["errorCount", "ok"]) &&
        row.validation.ok === false && integer(row.validation.errorCount) && row.validation.errorCount > 0)) &&
      (row.schemaUnsupported === undefined || row.schemaUnsupported === false ||
        (row.kind === "http_error" && [400, 422, 501].includes(row.status) && row.outputMode === "json_schema"));
  }
  return row.ok === true && row.kind === "accepted" && row.status >= 200 && row.status < 300 &&
    row.bytes > 0 && row.bytes <= inputs.settings.maxResponseBytes && row.elapsedMs <= inputs.settings.timeoutMs &&
    text(row.returnedModel) && row.finishReason === "stop" && row.choiceCount === 1 && integer(row.visibleBytes) && row.visibleBytes > 0 &&
    same(row.validation, { ok: true }) && (row.schemaUnsupported === undefined || row.schemaUnsupported === false) &&
    keys(row.reasoning, ["present", "bytes", "accounting"]) && typeof row.reasoning.present === "boolean" && integer(row.reasoning.bytes) &&
    row.reasoning.present === (row.reasoning.bytes > 0) && ["zero", "positive", "unavailable"].includes(row.reasoning.accounting) &&
    keys(row.usage, ["prompt_tokens", "completion_tokens", "total_tokens"]) &&
    ["prompt_tokens", "completion_tokens", "total_tokens"].every((key) => row.usage[key] === null || integer(row.usage[key])) &&
    (expected.item.expected.intent === "answer_portfolio" ? text(row.visibleAnswer) : row.visibleAnswer === undefined);
}

export function validLfmReport(report, inputs, now) {
  try {
    if (!keys(report, [...commonKeys, "baseUrl", "requestedModel", "settings", "promptSha256", "schemaSha256", "promptBytes",
      "schemaBytes", "caseCount", "metadata", "recommendation", "limitations"]) || !common(report, inputs, now) ||
      !same(report.settings, inputs.settings) || report.baseUrl !== inputs.settings.baseUrl || report.requestedModel !== inputs.settings.name ||
      report.promptSha256 !== inputs.binding.promptSha256 || report.schemaSha256 !== inputs.schemaSha256 ||
      report.promptBytes !== inputs.promptBytes || report.schemaBytes !== inputs.schemaLength || report.caseCount !== inputs.fixtures.length ||
      report.recommendation !== inputs.settings.outputMode || !Array.isArray(report.limitations) || !report.limitations.every(text)) return false;
    const meta = report.metadata;
    if (!keys(meta, ["ok", "kind", "status", "bytes", "elapsedMs", "identitySha256", "models"]) || meta.ok !== true ||
      (meta.kind !== undefined && meta.kind !== null) || meta.status !== 200 || !integer(meta.bytes) || meta.bytes <= 0 ||
      !nonnegative(meta.elapsedMs) || meta.elapsedMs > Math.min(1000, inputs.settings.timeoutMs) || !hash(meta.identitySha256) ||
      !Array.isArray(meta.models) || new Set(meta.models.map((model) => model?.id)).size !== meta.models.length ||
      !meta.models.every((model) => keys(model, ["id", "state", "quantization", "loadedContextLength", "maxContextLength"]) &&
        text(model.id) && ["loaded", "not-loaded"].includes(model.state) && text(model.quantization) &&
        integer(model.maxContextLength) && model.maxContextLength > 0 &&
        (model.loadedContextLength === undefined || (integer(model.loadedContextLength) && model.loadedContextLength > 0)))) return false;
    const loaded = meta.models.filter((model) => model?.state === "loaded" &&
      [inputs.settings.name, inputs.settings.name.split("@")[0]].includes(model.id));
    if (loaded.length !== 1 || !text(loaded[0].quantization) || !integer(loaded[0].loadedContextLength) ||
      loaded[0].loadedContextLength <= 0 || !integer(loaded[0].maxContextLength) || loaded[0].maxContextLength < loaded[0].loadedContextLength) return false;
    return report.results.every((row, index) => lfmRow(row, inputs.matrix[index], inputs) &&
      (row.ok !== true || row.returnedModel === loaded[0].id)) && selectProbeMode(report.results, inputs.fixtures.length) === inputs.settings.outputMode;
  } catch { return false; }
}

export function validQwenReport(report, receipt, inputs, now) {
  try {
    const rowKeys = ["caseId", "repeat", "ok", "returnedModelId", "finishReason", "reasoningPresent", "reasoningBytes", "reasoningAccounting"];
    return keys(report, [...commonKeys, "receiptWritten", "binding", "proof", "reasoningAccounting", "metadataCalls", "inferenceCalls"]) &&
      common(report, inputs, now) && report.receiptWritten === true && report.metadataCalls === 38 && report.inferenceCalls === 18 &&
      keys(receipt, ["version", ...Object.keys(inputs.runtimeBinding), "returnedModelId", "checkedAt", "probeCount", "results", "proof", "reasoningAccounting"]) &&
      validReceipt(receipt, { binding: inputs.runtimeBinding, matrix: inputs.matrix }, now) &&
      same(report.binding, inputs.runtimeBinding) && report.checkedAt === receipt.checkedAt && same(report.proof, receipt.proof) &&
      keys(report.proof, ["returnedModelId", "modelIdentitySha256", "buildInfoSha256", "chatTemplateSha256", "templates"]) &&
      report.proof.templates.every((row) => keys(row, ["emptyClosedThink", "renderedSha256", "suffixSha256"])) &&
      report.reasoningAccounting === receipt.reasoningAccounting && same(report.results, receipt.results) &&
      report.results.every((row) => keys(row, rowKeys));
  } catch { return false; }
}
