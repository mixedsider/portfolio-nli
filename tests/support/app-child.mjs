import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== value) {
    throw new Error("Invalid fixture readiness URL");
  }
  return value;
}

// Internal process seam also used to exercise failed/stuck child startup without model access.
export async function launchAppChild(entry, { env, startupMs = 15_000, exitMs = 3_000 } = {}) {
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let exited = false;
  let closing;
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
    child.once("error", () => { exited = true; resolve({ code: null, signal: null }); });
  });
  const lines = createInterface({ input: child.stdout });
  const stopOnExit = () => child.kill("SIGKILL");
  process.once("exit", stopOnExit);
  async function close() {
    closing ??= (async () => {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), exitMs);
      let deadline;
      try {
        if (!exited) child.kill("SIGTERM");
        await Promise.race([exit, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Fixture child exit timed out")), exitMs * 2);
        })]);
      } finally {
        clearTimeout(killTimer);
        clearTimeout(deadline);
        lines.close();
        process.removeListener("exit", stopOnExit);
      }
    })();
    return closing;
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), startupMs);
      const finish = (callback, value) => { clearTimeout(timer); callback(value); };
      child.once("error", (error) => finish(reject, error));
      exit.then(({ code, signal }) => finish(reject, new Error(`Fixture exited before readiness (${code ?? signal}): ${stderr}`)));
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type !== "test-app-ready") throw new Error("Invalid fixture readiness message");
          finish(resolve, { staticUrl: loopbackUrl(message.staticUrl), gatewayUrl: loopbackUrl(message.gatewayUrl),
            controlUrl: loopbackUrl(message.controlUrl) });
        } catch (error) { finish(reject, error); }
      });
    });
    return { ...ready, child, exit, close };
  } catch (error) { await close(); throw error; }
}
