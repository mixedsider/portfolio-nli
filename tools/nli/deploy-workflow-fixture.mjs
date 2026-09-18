import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePm2 } from "./deploy-workflow-pm2.mjs";

export async function createWorkflowFixture(root, bootstrap, hadReceipt, { legacyConfig = false, defaultReceipt = false } = {}) {
  const app = await mkdtemp(join(tmpdir(), "deploy-workflow-"));
  let manager;
  try {
    await mkdir(join(app, "tools/nli"), { recursive: true });
    const directory = join(app, ".nli/preflight-qa");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(app, ".pm2"));
    const previousRevision = "a".repeat(40);
    const service = { PATH: process.env.PATH, HOME: app, PM2_HOME: join(app, ".pm2"),
      NLI_ALLOWED_ORIGINS: "https://prior.example", LM_STUDIO_MODEL: "prior-model", LFM_MODEL: "prior-lfm",
      NLI_QWEN_VERIFICATION_FILE: join(app, ".nli/prior.json"), GIT_COMMIT_SHA: previousRevision,
      SNAPSHOT_SECRET: "fake-private-sentinel", NLI_QWEN_ENABLED: "true" };
    const ssh = { ...service, APP_DIR: app, PROCESS_NAME: "fixture", PREFLIGHT_ID: "qa",
      PM2_BIN: join(app, "pm2-stub.mjs"), NLI_ALLOWED_ORIGINS: "https://ssh.example", LM_STUDIO_MODEL: "ssh-model",
      LFM_MODEL: "ssh-lfm", NLI_QWEN_VERIFICATION_FILE: join(app, ".nli/ssh.json"), SSH_ONLY: "must-not-leak",
      SNAPSHOT_SECRET: "fake-ssh-sentinel" };
    const dotenv = { NLI_ALLOWED_ORIGINS: "https://dotenv.example", LM_STUDIO_MODEL: "dotenv-model",
      LFM_MODEL: "dotenv-lfm", NLI_QWEN_VERIFICATION_FILE: join(app, ".nli/dotenv.json"), DOTENV_ONLY: "dotenv-value" };
    if (defaultReceipt) for (const env of [service, ssh, dotenv]) delete env.NLI_QWEN_VERIFICATION_FILE;
    await writeFile(join(app, ".env"), Object.entries(dotenv).map(([key, value]) => `${key}=${value}`).join("\n"));
    const receipt = defaultReceipt ? join(app, ".nli/qwen-no-thinking.json") :
      bootstrap ? ssh.NLI_QWEN_VERIFICATION_FILE : service.NLI_QWEN_VERIFICATION_FILE;
    if (hadReceipt) await writeFile(receipt, "private-old-receipt", { mode: 0o600 });
    if (!defaultReceipt) await writeFile(dotenv.NLI_QWEN_VERIFICATION_FILE, "untouched-dotenv-receipt");
    if (!bootstrap && !defaultReceipt) await writeFile(ssh.NLI_QWEN_VERIFICATION_FILE, "untouched-ssh-receipt");
    const configUrl = JSON.stringify(pathToFileURL(join(root, "tools/nli/config.mjs")).href);
    const candidateConfig = legacyConfig ? await readFile(join(root, "tools/nli/config.mjs"), "utf8") :
      `export { loadDotEnv, createGatewayConfig } from ${configUrl};\n`;
    const priorConfig = legacyConfig ? await readFile(new URL("./deploy-workflow-legacy-config.mjs", import.meta.url), "utf8") : candidateConfig;
    await writeFile(join(app, "tools/nli/config.mjs"), priorConfig);
    if (legacyConfig) await writeFile(join(app, "tools/nli/timeout-policy.mjs"),
      await readFile(join(root, "tools/nli/timeout-policy.mjs")));
    await writeFile(join(app, "tools/nli-gateway.mjs"), "setInterval(() => {}, 1000);\n");
    await writeFile(join(app, "scenario"), "success");
    await writeFile(join(app, "producer-calls.json"), "[]");
    // These producers test workflow control flow only, not model verification.
    const producer = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { parseProbeArgs } from ${JSON.stringify(pathToFileURL(join(root, "tools/nli-model-probe.mjs")).href)};
      import { parseEvalArgs } from ${JSON.stringify(pathToFileURL(join(root, "tools/nli-cascade-eval.mjs")).href)};
      const probe = process.argv[1].endsWith("eval-bound-probe.mjs");
      const args = probe ? parseProbeArgs(process.argv.slice(2)) : parseEvalArgs(process.argv.slice(2));
      const endpoint = args.endpoint || "eval";
      const calls = JSON.parse(readFileSync("producer-calls.json", "utf8"));
      calls.push(endpoint);
      writeFileSync("producer-calls.json", JSON.stringify(calls));
      console.error("fake-private-sentinel fake-ssh-sentinel");
      const scenario = readFileSync("scenario", "utf8");
      if (scenario === endpoint + "-fail") process.exit(1);
      if (probe && args.mode !== "verify") process.exit(2);
      if (!probe) for (const stage of ["lfm", "qwen"]) {
        const report = JSON.parse(readFileSync(args[stage + "-verification"], "utf8"));
        if (report.evaluationBinding.endpoint !== stage || Date.now() - Date.parse(report.checkedAt) > 10000) process.exit(3);
      }
      writeFileSync(args.output, JSON.stringify({ ready: scenario !== "eval-false",
        evaluationBinding: { fixtureOnly: true, endpoint }, checkedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      if (args.receipt) writeFileSync(args.receipt, "new-private-stub-receipt", { mode: 0o600 });
    `;
    await writeFile(join(app, "tools/nli/eval-bound-probe.mjs"), producer);
    await writeFile(join(app, "tools/nli-cascade-eval.mjs"), producer);
    manager = await createFakePm2(app, service, bootstrap);
    return {
      app, directory, service, ssh, dotenv, receipt, previousRevision, manager,
      selectConfig: (version) => writeFile(join(app, "tools/nli/config.mjs"), version === "prior" ? priorConfig : candidateConfig),
      scenario: (value) => writeFile(join(app, "scenario"), value),
      producerCalls: async () => JSON.parse(await readFile(join(app, "producer-calls.json"), "utf8")),
      async close() {
        try { return await manager.close(); }
        finally { await rm(app, { recursive: true, force: true }); }
      }
    };
  } catch (error) {
    try { await manager?.close(); }
    finally { await rm(app, { recursive: true, force: true }); }
    throw error;
  }
}
