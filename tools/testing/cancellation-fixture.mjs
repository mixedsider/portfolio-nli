import { writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { execute, testEnvironment } from "./process.mjs";
import { fixtureDirectory } from "./harness-fixture.mjs";

export async function cancellationFixture(t, mode) {
  const root = await fixtureDirectory(t);
  const leaf = join(root, "leaf.mjs");
  const owner = join(root, "owner.mjs");
  const pidFile = join(root, "pid");
  const liveTemp = join(root, "leaf.tmp");
  const ownerTemp = join(root, "owner.tmp");
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } } });
  await writeFile(leaf, `import {writeFileSync,rmSync} from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    writeFileSync(${JSON.stringify(liveTemp)},'owned');
    const timer=setInterval(()=>{},1000);
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{${mode === "force" ? "" : `clearInterval(timer);rmSync(${JSON.stringify(liveTemp)});`}});
    console.log('READY');`);
  await writeFile(owner, `import {execute,testEnvironment} from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
    import {writeFileSync,rmSync} from 'node:fs';
    writeFileSync(${JSON.stringify(ownerTemp)},'owned');
    try { await execute(process.execPath,[${JSON.stringify(leaf)}],{env:testEnvironment(),stream:true}); }
    finally { rmSync(${JSON.stringify(ownerTemp)}); }`);
  let result;
  if (mode === "timeout" || mode === "force") {
    result = await execute(process.execPath, [owner], { env: testEnvironment(), timeout: 1500 });
  } else {
    const source = `import {execute,testEnvironment} from ${JSON.stringify(new URL("./process.mjs", import.meta.url).href)};
      console.log(JSON.stringify(await execute(process.execPath,[${JSON.stringify(owner)}],{env:testEnvironment(),stream:true})));`;
    const controller = spawn(process.execPath, ["--input-type=module", "-e", source], { env: testEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let sent = false;
    const timer = setTimeout(() => controller.kill("SIGKILL"), 10000);
    controller.stdout.on("data", (data) => {
      output += data;
      if (!sent && output.includes("READY")) { sent = true; controller.kill(mode); }
    });
    try {
      await new Promise((resolve, reject) => { controller.once("close", resolve); controller.once("error", reject); });
      result = JSON.parse(output.trim().split("\n").at(-1));
    } finally { clearTimeout(timer); }
  }
  pid = Number(await readFile(pidFile, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    alive = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) { if (!["ESRCH", "ENOENT"].includes(error.code)) throw error; }
  const exists = async (path) => { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  return { result, alive, leafTempExists: await exists(liveTemp), ownerTempExists: await exists(ownerTemp) };
}
