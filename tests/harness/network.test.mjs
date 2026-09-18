import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const preload = fileURLToPath(new URL("../../tools/testing/network-guard.mjs", import.meta.url));
for (const [name, code] of [
  ["fetch IPv4", 'await fetch("http://192.0.2.1", {signal: AbortSignal.timeout(100)}).catch(() => {});'],
  ["fetch IPv6", 'await fetch("http://[2001:db8::1]", {signal: AbortSignal.timeout(100)}).catch(() => {});'],
  ["net", 'try { (await import("node:net")).connect(80,"192.0.2.1").on("error",()=>{}); } catch {}'],
  ["http", 'try { (await import("node:http")).get("http://192.0.2.1").on("error",()=>{}); } catch {}'],
  ["owned child", `const {spawnSync}=await import("node:child_process"); spawnSync(process.execPath,["-e", ${JSON.stringify('fetch("http://192.0.2.1",{signal:AbortSignal.timeout(100)}).catch(()=>{})')}],{env:{PATH:process.env.PATH}});`],
  ["resolved address", 'try { (await import("node:net")).connect({port:80,host:"localhost",lookup:(_h,_o,cb)=>cb(null,"192.0.2.1",4)}).on("error",()=>{}); } catch {}'],
  ["redirect", 'const s=(await import("node:http")).createServer((_q,r)=>{r.writeHead(302,{location:"http://192.0.2.1"});r.end()}); await new Promise(r=>s.listen(0,"127.0.0.1",r)); await fetch(`http://127.0.0.1:${s.address().port}`,{signal:AbortSignal.timeout(1000)}).catch(()=>{}); await new Promise(r=>s.close(r));']
]) test(`records a violation out of band when ${name} errors are caught`, async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-network-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, "violations.jsonl");
  // When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH, HARNESS_EGRESS_LOG: log }, encoding: "utf8", timeout: 3000
  });
  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.ok((await readFile(log, "utf8")).includes('"code":"TEST_EGRESS_BLOCKED"'));
});
for (const host of ["127.0.0.1", "::1"]) test(`permits loopback when server uses ${host}`, async () => {
  // Given
  const code = `const s=(await import('node:http')).createServer((_q,r)=>r.end('ok')); await new Promise(r=>s.listen(0,'${host}',r)); const r=await fetch('http://${host.includes(":") ? "[::1]" : host}:'+s.address().port); if(await r.text()!=='ok')process.exitCode=1; await new Promise(r=>s.close(r));`;
  // When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  // Then
  assert.equal(result.status, 0, result.stderr);
});
test("preserves promisified execFile stdout and stderr under the guard", () => {
  // Given
  const code = `const {promisify}=await import('node:util'); const {execFile}=await import('node:child_process'); const result=await promisify(execFile)(process.execPath,['-e','console.log(42)']); if(result.stdout!=='42\\n'||result.stderr!=='')process.exitCode=1;`;
  // When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  // Then
  assert.equal(result.status, 0, result.stderr);
});
test("keeps preload bookkeeping out of child application environment snapshots", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = `const {spawnSync}=await import('node:child_process'); const r=spawnSync(process.execPath,['-e','console.log(JSON.stringify(process.env))'],{env:{FIXTURE:'yes'},encoding:'utf8'}); const env=JSON.parse(r.stdout); if(JSON.stringify(env)!==JSON.stringify({FIXTURE:'yes'}))throw Error(JSON.stringify(Object.keys(env)));`;
  // When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HARNESS_EGRESS_LOG: join(root, "log"), NODE_V8_COVERAGE: root }
  });
  // Then
  assert.equal(result.status, 0, result.stderr);
});
test("fails closed when a blocked request has no violation log destination", () => {
  // Given / When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e",
    `delete process.env.HARNESS_EGRESS_LOG; await import(${JSON.stringify(new URL("../../tools/testing/network-guard.mjs?missing-log", import.meta.url).href)}); await fetch("http://192.0.2.1").catch(()=>{});`],
  { env: {}, encoding: "utf8", timeout: 5000 });
  // Then
  assert.equal(result.status, 1, result.stderr);
});
test("permits local Unix IPC when a child talks to its own socket", async (t) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "harness-ipc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const code = `const net=await import('node:net'); const path=${JSON.stringify(join(root, "ipc.sock"))}; const s=net.createServer(c=>c.end('ok')); await new Promise(r=>s.listen(path,r)); await new Promise((r,j)=>{const c=net.connect(path); c.on('error',j); c.resume(); c.on('end',r)}); await new Promise(r=>s.close(r));`;
  // When
  const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
  // Then
  assert.equal(result.status, 0, result.stderr);
});
