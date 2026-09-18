import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createFakePm2(app, initialEnv, bootstrap) {
  let child = null;
  const calls = [];
  const children = [];
  const sockets = new Set();
  const statePath = join(app, "state.json");
  const state = async () => JSON.parse(await readFile(statePath, "utf8"));
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  async function start(env) {
    await stop();
    child = spawn(process.execPath, [join(app, "tools/nli-gateway.mjs")], { cwd: app, env, stdio: "ignore" });
    children.push(child);
    await once(child, "spawn");
    await writeFile(statePath, JSON.stringify({ name: "fixture", pid: child.pid, pm2_env: {
      env, status: "online", exec_mode: "fork_mode", pm_exec_path: join(app, "tools/nli-gateway.mjs"), pm_cwd: app
    } }));
  }
  await writeFile(statePath, "null");
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 131072) return socket.destroy();
      if (!input.endsWith("\n")) return;
      socket.removeAllListeners("data");
      handle(JSON.parse(input)).then((result) => socket.end(JSON.stringify(result))).catch(() => {
        socket.end(JSON.stringify({ code: 1, output: "" }));
      });
    });
  });
  async function handle({ args, env }) {
    const action = args[0];
    const current = await state();
    if (action === "jlist") return { code: 0, output: JSON.stringify(current ? [current] : []) };
    calls.push(action);
    if (action === "save") return { code: 0, output: "" };
    if (!["restart", "start"].includes(action)) return { code: 9, output: "" };
    if (await readFile(join(app, "scenario"), "utf8") === "restart-fail") return { code: 1, output: "" };
    if (action === "restart" && (!current || !args.includes("--update-env"))) return { code: 4, output: "" };
    await start(action === "restart" ? { ...current.pm2_env.env, ...env } : env);
    return { code: 0, output: "" };
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(app, "pm2.sock"), resolve);
    });
    await chmod(join(app, "pm2.sock"), 0o600);
    if (!bootstrap) await start(initialEnv);
    await writeFile(join(app, "pm2-stub.mjs"), `
      import { connect } from "node:net";
      import { dirname, join } from "node:path";
      import { fileURLToPath } from "node:url";
      const socket = connect(join(dirname(fileURLToPath(import.meta.url)), "pm2.sock"));
      socket.setTimeout(10000, () => socket.destroy(new Error("fixture timeout")));
      socket.on("error", () => { process.exitCode = 1; });
      let output = "";
      socket.on("connect", () => socket.write(JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n"));
      socket.on("data", (chunk) => { output += chunk; });
      socket.on("end", () => {
        const result = JSON.parse(output);
        console.error("fake-private-sentinel fake-ssh-sentinel");
        process.stdout.write(result.output);
        process.exitCode = result.code;
      });
    `);
  } catch (error) {
    await stop();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    calls, state,
    setState: (value) => writeFile(statePath, JSON.stringify(value)),
    async close() {
      await stop();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return { listening: server.listening, activeChildren: children.filter((item) => item.exitCode === null && item.signalCode === null).length };
    }
  };
}
