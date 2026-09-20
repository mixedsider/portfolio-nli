import { fileURLToPath } from "node:url";
import { loadNliContext } from "../nli-gateway.mjs";
import { createGatewayConfig, loadDotEnv } from "./config.mjs";
import { loadTestCases } from "./test-fixtures.mjs";
import { runFixtureSuite } from "./eval-suites.mjs";
import { ordinaryCases, difficultCase, runWorkload, runQwenBaseline } from "./eval-workloads.mjs";
import { verificationEvidence } from "./eval-verification.mjs";
import { readyVerdict, distribution } from "./eval-report.mjs";
import { revalidateFinalProof } from "./eval-final-verification.mjs";
import { APPLICATION_TIMEOUT_MS, EVALUATION_HTTP_TIMEOUT_MS, LFM_TIMEOUT_MS, QWEN_TIMEOUT_MS } from "./timeout-policy.mjs";

export async function evaluateCascade(options, dependencies = {}) {
  await loadDotEnv(fileURLToPath(new URL("../../", import.meta.url)));
  const loadConfig = dependencies.loadConfig ?? createGatewayConfig;
  const loadContext = dependencies.loadContext ?? loadNliContext;
  const verify = dependencies.verify ?? verificationEvidence;
  const workload = dependencies.workload ?? runWorkload;
  const fixtureSuite = dependencies.fixtureSuite ?? runFixtureSuite;
  const qwenBaseline = dependencies.qwenBaseline ?? runQwenBaseline;
  const config = loadConfig();
  const context = await loadContext();
  const identified = (cases, prefix) => cases.map((item, index) => ({ ...item, id: item.id ?? `${prefix}-${index + 1}` }));
  const live = identified(await loadTestCases("nli/live-test-cases.json"), "live").filter((item) => item.kind === "success");
  const adversarial = identified(await loadTestCases("nli/adversarial-test-cases.json"), "adversarial");
  if (live.length !== 26 || adversarial.length !== 10) throw new Error("Required fixture matrix changed");
  const ordinary = ordinaryCases(live);
  const verification = await verify(options, config, context, { wallNow: dependencies.wallNow ?? Date.now });
  const fullyVerified = verification.lfmVerified && verification.qwenVerified;
  // Missing verification still permits bounded transport diagnostics, not a readiness claim.
  const repeats = fullyVerified ? 3 : 1;
  const firstCall = await workload(config, context, [ordinary[4]], { repeats: 1 });
  firstCall.label = "First evaluator inference, not cold start; verifier/operator calls may precede it";
  const success = await fixtureSuite(config, context, live, "nli/live-test-cases.json", "success");
  const adversarialSuite = await fixtureSuite(config, context, adversarial, "nli/adversarial-test-cases.json");
  const warm = await workload(config, context, ordinary, { repeats });
  const baseline = await qwenBaseline(config, context, ordinary, { repeats, verified: verification.qwenVerified });
  const phases = [];
  for (const concurrency of [1, 4]) {
    phases.push(await workload(config, context, ordinary.slice(0, 4), { repeats: 1, concurrency }));
  }
  const difficult = difficultCase(context);
  const naturalDifficult = await workload(config, context, [difficult], { repeats: 1, difficult: true });
  const injected = verification.qwenVerified ? await workload(config, context, [difficult], { repeats: 1, injectLfm: true }) :
    { ok: false, skipped: "real_qwen_verification_missing", results: [] };
  const workloadsClean = [verification, firstCall, success, adversarialSuite, warm, baseline, naturalDifficult, ...phases,
    ...(injected.skipped ? [] : [injected])].every((report) => report.cleanup?.ok === true);
  const perCase = ordinary.map((item) => ({ fixtureId: item.id,
    lfm: distribution(warm.results.filter((row) => row.fixtureId === item.id).map((row) => row.wallMs)),
    qwenOnly: distribution(baseline.results.filter((row) => row.fixtureId === item.id).map((row) => row.wallMs)) }));
  // Last asynchronous operation before readiness: re-read proofs/current context and metadata.
  const finalVerification = await revalidateFinalProof(verification, options, { loadConfig, loadContext, verify,
    wallNow: dependencies.wallNow ?? Date.now });
  const cleanup = workloadsClean && finalVerification.verification?.cleanup?.ok === true;
  const gates = { policyCaps: config.lfm.timeoutMs === LFM_TIMEOUT_MS && config.lfm.maxTokens === 512 &&
      config.model.timeoutMs === QWEN_TIMEOUT_MS && config.model.maxTokens === 768 && config.cascade.timeoutMs === APPLICATION_TIMEOUT_MS &&
      config.cascade.maxConcurrentRequests === 4,
    lfmVerified: verification.lfmVerified && finalVerification.verification?.lfmVerified === true,
    qwenVerified: verification.qwenVerified && finalVerification.verification?.qwenVerified === true,
    finalProofFreshness: finalVerification.ok,
    liveSuccess: success.ok, adversarial: adversarialSuite.ok,
    ordinary: repeats === 3 && warm.ok, qwenBaseline: repeats === 3 && baseline.ok,
    faster: warm.ok && baseline.ok && warm.timings.p50 < baseline.timings.p50,
    concurrency1: phases[0].ok, concurrency4: phases[1].ok,
    difficultWorkload: naturalDifficult.ok, injectedEscalation: injected.ok, cleanup };
  return { version: 1, ...readyVerdict(gates), gates, verification, finalVerification,
    settings: { lfm: config.lfm, qwen: config.model, cascade: config.cascade, clientTimeoutMs: EVALUATION_HTTP_TIMEOUT_MS },
    firstCall, success, adversarial: adversarialSuite, warm, baseline, phases, naturalDifficult, injected, perCase,
    limitations: ["Client cancellation does not prove stopped server GPU generation", "No fabricated cold reset",
      "Missing verification bounds warm/diagnostic sampling to one repeat; three-repeat gates remain false",
      "Transport success is not semantic acceptance; conservative grounding is not arbitrary entailment",
      "External CLI verification reports required via --lfm-verification and --qwen-verification; no receipt is issued by evaluator"] };
}
