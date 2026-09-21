import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createModelAdmission } from "./model-admission.mjs";
import { verificationInputs, collectQwenProof, validReceipt, sha256 } from "./qwen-verification-proof.mjs";
import { withVerificationBudget, verificationRequest } from "./qwen-verification-http.mjs";

async function readTrustedReceipt(path, signal) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o022) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("receipt");
    return await handle.readFile({ signal });
  } finally { await handle.close(); }
}

export function createQwenVerifier(settings, cascadeConfig, dependencies = {}) {
  const inputs = verificationInputs(settings, dependencies.context, dependencies.schemaBytes);
  const enabled = cascadeConfig.qwenEnabled === true;
  const receiptFile = cascadeConfig.qwenVerificationFile;
  const now = dependencies.now || (() => performance.now());
  const wallNow = dependencies.wallNow || Date.now;
  const admission = dependencies.admission || createModelAdmission(cascadeConfig.maxConcurrentRequests);
  let invalidated = false;
  return Object.freeze({
    invalidate() { invalidated = true; },
    async verify(options = {}) {
      const started = now();
      const counters = { metadataCalls: 0, inferenceCalls: 0 };
      const fail = (detail) => ({ ok: false, reason: "qwen_unverified", detail, elapsedMs: Math.max(0, now() - started), ...counters });
      if (!enabled || invalidated) return fail(!enabled ? "disabled" : "invalidated");
      const budgetMs = Math.min(inputs.settings.timeoutMs, options.budgetMs ?? inputs.settings.timeoutMs);
      if (!Number.isFinite(budgetMs) || budgetMs <= 0 || (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))) return fail("timeout");
      try {
        return await withVerificationBudget({ ...options, now, budgetMs }, async (scope) => {
          const bytes = await readTrustedReceipt(receiptFile, scope.signal);
          scope.check();
          if (bytes.length > 65536) throw new Error("receipt");
          const receipt = JSON.parse(bytes.toString("utf8"));
          if (!validReceipt(receipt, inputs, wallNow())) throw new Error("receipt");
          const proof = await collectQwenProof(inputs, verificationRequest(inputs, { ...dependencies, admission }, scope, counters));
          scope.check();
          if (invalidated || !validReceipt(receipt, inputs, wallNow()) || sha256(proof) !== sha256(receipt.proof)) throw new Error("mismatch");
          return { ok: true, reason: null, returnedModelId: receipt.returnedModelId,
            elapsedMs: Math.max(0, now() - started), ...counters };
        });
      } catch (error) {
        return fail(["aborted", "timeout", "busy", "mismatch", "identity", "template", "http_error", "body_limit"].includes(error.message) ? error.message : "receipt_or_metadata");
      }
    }
  });
}
