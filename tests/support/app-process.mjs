import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAppChild } from "./app-child.mjs";
import { assertScenario } from "./app-scenarios.mjs";

const activeClosers = new Set();
async function stopInstances(exitCode) {
  await Promise.allSettled([...activeClosers].map((close) => close()));
  process.exit(exitCode);
}
const onTerm = () => { void stopInstances(143); };
const onInterrupt = () => { void stopInstances(130); };

export async function startTestApp({ scenario = "healthy" } = {}) {
  assertScenario(scenario);
  const directory = await mkdtemp(join(tmpdir(), "portfolio-test-app-"));
  // Keep NODE_OPTIONS (including the harness egress guard), remove operator model configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(NLI_|LFM_|LM_STUDIO_|TEST_APP_)/.test(key)));
  const startup = launchAppChild(fileURLToPath(new URL("./app-server.mjs", import.meta.url)), {
    env: { ...env, TEST_APP_SCENARIO: scenario, TEST_APP_DIRECTORY: directory }
  });
  let closing;
  if (activeClosers.size === 0) {
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInterrupt);
  }
  activeClosers.add(close);
  function dispose() {
    activeClosers.delete(close);
    if (activeClosers.size === 0) {
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInterrupt);
    }
  }
  function close() {
    closing ??= (async () => {
      try { await (await startup).close(); }
      finally {
        try { await rm(directory, { recursive: true, force: true }); }
        finally { dispose(); }
      }
    })();
    return closing;
  }
  try {
    const processApp = await startup;
    return {
      staticUrl: processApp.staticUrl,
      gatewayUrl: processApp.gatewayUrl,
      async stats() {
        const response = await fetch(`${processApp.controlUrl}/stats`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`Fixture stats failed: ${response.status}`);
        const counts = await response.json();
        if (!Number.isInteger(counts.lfm) || !Number.isInteger(counts.qwen) || counts.lfm < 0 || counts.qwen < 0) {
          throw new Error("Invalid fixture inference counts");
        }
        return { lfm: counts.lfm, qwen: counts.qwen };
      },
      close
    };
  } catch (error) {
    dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
