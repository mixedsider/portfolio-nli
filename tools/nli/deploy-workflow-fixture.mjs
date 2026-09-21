import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      LFM_MODEL: "dotenv-lfm", NLI_QWEN_VERIFICATION_FILE: join(app, ".nli/dotenv.json"),
      NLI_DOTENV_ONLY: "dotenv-application-value", DOTENV_ONLY: "dotenv-value" };
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

export async function createSystemdWorkflowFixture(root, scope = "system", { hadReceipt = true, pm2Registered = false } = {}) {
  const fixture = await createWorkflowFixture(root, !pm2Registered, false);
  const managerDirectory = await mkdtemp(join(tmpdir(), "deploy-systemctl-"));
  const procRoot = join(fixture.app, "proc");
  const statePath = join(fixture.app, "systemd-state.json");
  const callsPath = join(fixture.app, "systemd-calls.json");
  const unit = "nli-gateway.service";
  const controlGroup = scope === "user"
    ? "/user.slice/user-1000.slice/user@1000.service/app.slice/nli-gateway.service"
    : "/system.slice/nli-gateway.service";
  const initialPid = pm2Registered ? (await fixture.manager.state()).pid : 42001;
  const systemctl = join(managerDirectory, "systemctl");
  const uid = process.geteuid();
  const runtimeRoot = join(managerDirectory, "run/user");
  const runtimeDirectory = join(runtimeRoot, String(uid));
  const managerPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const systemdEnv = { ...fixture.service, LD_PRELOAD: "/fixture/forbidden-loader.so",
    NODE_OPTIONS: "--trace-warnings", XDG_RUNTIME_DIR: "/fixture/untrusted-runtime",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/untrusted-bus" };
  const receipt = systemdEnv.NLI_QWEN_VERIFICATION_FILE || join(fixture.app, ".nli/qwen-no-thinking.json");
  const receiptBytes = "private-systemd-old-receipt";

  async function writeProcess(pid) {
    const processDirectory = join(procRoot, String(pid));
    await mkdir(processDirectory, { recursive: true });
    await symlink(fixture.app, join(processDirectory, "cwd"));
    await writeFile(join(processDirectory, "cmdline"),
      [process.execPath, join(fixture.app, "tools/nli-gateway.mjs"), ""].join("\0"));
    await writeFile(join(processDirectory, "environ"),
      Object.entries(systemdEnv).map(([key, value]) => `${key}=${value}`).join("\0") + "\0");
    await writeFile(join(processDirectory, "cgroup"), `0::${controlGroup}\n`);
    await writeFile(join(processDirectory, "status"),
      `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  }

  try {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(runtimeDirectory, 0o700);
    await writeProcess(initialPid);
    if (hadReceipt) await writeFile(receipt, receiptBytes, { mode: 0o600 });
    await writeFile(statePath, JSON.stringify({ pid: initialPid, scope, unit, controlGroup, app: fixture.app,
      env: systemdEnv, procRoot, loadState: "loaded", activeState: "active", subState: "running",
      mainPid: null, uid, managerPath, runtimeDirectory }));
    await writeFile(callsPath, "[]");
    await writeFile(systemctl, `#!${process.execPath}
      import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const statePath = ${JSON.stringify(statePath)};
      const callsPath = ${JSON.stringify(callsPath)};
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const args = process.argv.slice(2);
      const user = args[0] === "--user";
      if (user) args.shift();
      const expectedUser = state.scope === "user";
      const action = args[0];
      const unit = args.at(-1);
      const calls = JSON.parse(readFileSync(callsPath, "utf8"));
      calls.push({ action, scope: user ? "user" : "system", unit, env: process.env });
      writeFileSync(callsPath, JSON.stringify(calls));
      if (user !== expectedUser || unit !== state.unit) process.exit(7);
      const expectedEnv = { PATH: state.managerPath, LANG: "C", LC_ALL: "C" };
      if (expectedUser) {
        expectedEnv.XDG_RUNTIME_DIR = state.runtimeDirectory;
        expectedEnv.DBUS_SESSION_BUS_ADDRESS = "unix:path=" + state.runtimeDirectory + "/bus";
      }
      if (JSON.stringify(Object.entries(process.env).sort()) !== JSON.stringify(Object.entries(expectedEnv).sort())) process.exit(6);
      if (action === "show") {
        process.stdout.write(["ControlGroup=" + state.controlGroup, "ActiveState=" + state.activeState,
          "Id=" + state.unit, "MainPID=" + (state.mainPid ?? state.pid), "SubState=" + state.subState,
          "LoadState=" + state.loadState].join("\\n") + "\\n");
      } else if (action === "restart") {
        if (readFileSync(join(state.app, "scenario"), "utf8") === "systemd-restart-fail") process.exit(9);
        state.pid += 1;
        const processDirectory = join(state.procRoot, String(state.pid));
        mkdirSync(processDirectory, { recursive: true });
        symlinkSync(state.app, join(processDirectory, "cwd"));
        writeFileSync(join(processDirectory, "cmdline"), [process.execPath, join(state.app, "tools/nli-gateway.mjs"), ""].join("\\0"));
        writeFileSync(join(processDirectory, "environ"), Object.entries(state.env).map(([key, value]) => key + "=" + value).join("\\0") + "\\0");
        writeFileSync(join(processDirectory, "cgroup"), "0::" + state.controlGroup + "\\n");
        writeFileSync(join(processDirectory, "status"), "Name:\\tnode\\nUid:\\t" + state.uid + "\\t" + state.uid + "\\t" + state.uid + "\\t" + state.uid + "\\n");
        writeFileSync(statePath, JSON.stringify(state));
      } else process.exit(8);
    `);
    await chmod(systemctl, 0o700);
  } catch (error) {
    try { await fixture.close(); }
    finally { await rm(managerDirectory, { recursive: true, force: true }); }
    throw error;
  }

  return {
    ...fixture,
    procRoot,
    scope,
    unit,
    systemctl,
    managerDirectory,
    runtimeRoot,
    runtimeDirectory,
    uid,
    managerPath,
    receipt,
    receiptBytes,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    systemdCalls: async () => JSON.parse(await readFile(callsPath, "utf8")),
    async setProcessArgv(argv) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(join(procRoot, String(state.pid), "cmdline"), [...argv, ""].join("\0"));
    },
    async setProcessUid(processUid) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(join(procRoot, String(state.pid), "status"),
        `Name:\tnode\nUid:\t${processUid}\t${processUid}\t${processUid}\t${processUid}\n`);
    },
    async setSystemdProperties(properties) {
      const allowed = new Set(["loadState", "activeState", "subState", "mainPid"]);
      if (Object.keys(properties).some((key) => !allowed.has(key))) {
        throw new Error("unsupported systemd fixture property");
      }
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, JSON.stringify({ ...state, ...properties }));
    },
    async removeProcessEnvKey(key) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const environmentPath = join(procRoot, String(state.pid), "environ");
      const entries = (await readFile(environmentPath, "utf8")).split("\0").filter(Boolean)
        .filter((entry) => entry.slice(0, entry.indexOf("=")) !== key);
      await writeFile(environmentPath, entries.join("\0") + "\0");
    },
    async processEnvironment() {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      return Object.fromEntries((await readFile(join(procRoot, String(state.pid), "environ"), "utf8"))
        .split("\0").filter(Boolean).map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }));
    },
    async close() {
      try { return await fixture.close(); }
      finally { await rm(managerDirectory, { recursive: true, force: true }); }
    }
  };
}
