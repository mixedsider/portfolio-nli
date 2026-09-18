import { spawn } from "node:child_process";
import { stopProcessTree } from "./process-tree.mjs";

export function testEnvironment(extra = {}) {
  const env = { NODE_ENV: "test", TZ: "UTC", ...extra };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "CI", "PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]) {
    if (process.env[key] !== undefined && env[key] === undefined) env[key] = process.env[key];
  }
  return env;
}
export function execute(command, args, options = {}) {
  return new Promise((resolve) => {
    // Linux cancellation tracks owned descendants, including independently
    // detached fixture children; nested execute calls need no new process group.
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: !["linux", "win32"].includes(process.platform) });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    let stopping;
    let infrastructureError;
    const terminate = (signal = "SIGTERM") => {
      if (stopping || !child.pid) return;
      interrupted = true;
      stopping = stopProcessTree(child, signal).catch((error) => {
        infrastructureError = error.code ?? error.message;
        child.kill("SIGKILL");
      });
    };
    const timer = setTimeout(() => terminate(), options.timeout ?? 600_000);
    const handlers = { SIGINT: () => terminate("SIGINT"), SIGTERM: () => terminate("SIGTERM") };
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (options.stream) process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (options.stream) process.stderr.write(chunk); });
    const cleanup = () => {
      clearTimeout(timer);
      for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
    };
    child.once("error", (error) => { cleanup(); resolve({ code: null, signal: null, interrupted, error: error.code, stdout, stderr }); });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      await stopping;
      cleanup();
      resolve({ code, signal, interrupted, error: infrastructureError, stdout, stderr });
    });
  });
}
