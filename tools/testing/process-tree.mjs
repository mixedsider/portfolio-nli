import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

async function processRecord(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), parent: Number(fields[1]), state: fields[0], start: fields[19] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}
async function discover(rootPid, known) {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const records = (await Promise.all(pids.map(processRecord))).filter(Boolean);
  const owned = new Set(records.filter((record) => known.get(record.pid)?.start === record.start).map((record) => record.pid));
  if (!known.size) owned.add(rootPid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!owned.has(record.pid) && owned.has(record.parent)) { owned.add(record.pid); changed = true; }
    }
  }
  for (const record of records) if (owned.has(record.pid)) known.set(record.pid, record);
  return records.filter((record) => owned.has(record.pid) && record.state !== "Z");
}
async function send(records, signal) {
  for (const record of [...records].reverse()) {
    const current = await processRecord(record.pid);
    // A PID can be reused after a process exits: signal only the captured identity.
    if (!current || current.start !== record.start || current.state === "Z") continue;
    try { process.kill(record.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
export async function stopProcessTree(child, signal, graceMs = 2000) {
  if (process.platform !== "linux") {
    const sendGroup = (value) => {
      try {
        if (process.platform === "win32") child.kill(value);
        else process.kill(-child.pid, value);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    sendGroup(signal);
    await delay(graceMs);
    sendGroup("SIGKILL");
    return;
  }
  const known = new Map();
  let live = await discover(child.pid, known);
  await send(live, signal);
  const deadline = Date.now() + graceMs;
  while ((live = await discover(child.pid, known)).length && Date.now() < deadline) await delay(25);
  if (!live.length) return;
  await send(live, "SIGKILL");
  const forceDeadline = Date.now() + 2000;
  while ((await discover(child.pid, known)).length) {
    if (Date.now() >= forceDeadline) throw new Error("Owned process tree did not terminate");
    await delay(25);
  }
}
