import net from "node:net";
import dns from "node:dns";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

// Test isolation only, not a sandbox against arbitrary binaries or hostile code.
const guardOption = `--import=${JSON.stringify(import.meta.filename)}`;
const violationLog = process.env.HARNESS_EGRESS_LOG;
// Keep harness plumbing private to this closure, not application env snapshots.
// Native V8 has already consumed its coverage destination at process startup.
delete process.env.HARNESS_EGRESS_LOG;
delete process.env.NODE_V8_COVERAGE;
if (process.env.NODE_OPTIONS) {
  const remaining = process.env.NODE_OPTIONS.replaceAll(guardOption, "").trim();
  if (remaining) process.env.NODE_OPTIONS = remaining;
  else delete process.env.NODE_OPTIONS;
}
const loopback = (host) => {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return value === "::1" || value === "0:0:0:0:0:0:0:1"
    || (net.isIPv4(value) && value.startsWith("127."))
    || /^::ffff:127\./.test(value) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(value);
};
function blocked() {
  const error = Object.assign(new Error("Test egress blocked: loopback only"), { code: "TEST_EGRESS_BLOCKED" });
  // Deliberately omit URL, payload, environment, credentials and destination.
  if (violationLog) appendFileSync(violationLog, `${JSON.stringify({ code: error.code, pid: process.pid })}\n`);
  else process.exitCode = 1;
  return error;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  // Unix-domain IPC never leaves the host and is used by the PM2 test fixture.
  if ((typeof first === "object" && first?.path) || (typeof first === "string" && !/^\d+$/.test(first))) {
    return connect.apply(this, args);
  }
  const options = typeof first === "object" && first !== null ? { ...first }
    : { port: first, host: typeof normalized[1] === "string" ? normalized[1] : "localhost" };
  const host = options.host ?? "localhost";
  if (!loopback(host) && host !== "localhost") throw blocked();
  const lookup = options.lookup ?? dns.lookup;
  options.lookup = (hostname, lookupOptions, callback) => lookup(hostname, lookupOptions, (error, address, family) => {
    if (error) return callback(error);
    const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
    if (!addresses.length || addresses.some((value) => !loopback(value))) return callback(blocked());
    callback(null, address, family);
  });
  const callback = normalized.findLast((arg) => typeof arg === "function");
  return callback ? connect.call(this, options, callback) : connect.call(this, options);
};

function guardedOptions(options = {}) {
  const env = { ...(options.env ?? process.env) };
  // Retain an explicitly supplied nested test log, otherwise inherit the parent's.
  if (!env.HARNESS_EGRESS_LOG && violationLog) env.HARNESS_EGRESS_LOG = violationLog;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  env.NODE_OPTIONS = nodeOptions.includes(guardOption) ? nodeOptions : `${nodeOptions} ${guardOption}`.trim();
  return { ...options, env };
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  const withOptions = (args) => {
    const guarded = [...args];
    const index = Array.isArray(guarded[0]) ? 1 : 0;
    if (typeof guarded[index] === "function") guarded.splice(index, 0, guardedOptions());
    else guarded[index] = guardedOptions(guarded[index]);
    return guarded;
  };
  childProcess[name] = function (file, ...args) {
    return original.call(this, file, ...withOptions(args));
  };
  if (original[promisify.custom]) childProcess[name][promisify.custom] = function (file, ...args) {
    return original[promisify.custom].call(this, file, ...withOptions(args));
  };
}
for (const name of ["exec", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (command, options, callback) {
    if (typeof options === "function") return original.call(this, command, guardedOptions(), options);
    return original.call(this, command, guardedOptions(options), callback);
  };
  if (original[promisify.custom]) childProcess[name][promisify.custom] = function (command, options) {
    return original[promisify.custom].call(this, command, guardedOptions(options));
  };
}
syncBuiltinESMExports();
