import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startTestApp } from "./app-process.mjs";

const exec = promisify(execFile);
for (const [scenario, message, expectedStatus, expectedCounts] of [
  ["healthy", "자기소개해줘", 200, { lfm: 1, qwen: 0 }],
  ["escalation", "CateQuest와 Bookking의 성능 개선을 비교해줘", 200, { lfm: 1, qwen: 1 }],
  ["upstream-error", "포트폴리오 정보의 색상은?", 503, { lfm: 1, qwen: 0 }]
]) {
  const app = await startTestApp({ scenario });
  try {
    const health = await (await fetch(`${app.gatewayUrl}/api/nli/health`)).json();
    console.log(JSON.stringify({ scenario, phase: "child-ready", staticUrl: app.staticUrl,
      gatewayUrl: app.gatewayUrl, health, initialCounts: await app.stats() }));
    const { stdout, stderr } = await exec("curl", ["--silent", "--show-error", "--max-time", "10",
      "--write-out", "\n%{http_code}", "--header", "Content-Type: application/json",
      "--header", `Origin: ${app.staticUrl}`, "--data", JSON.stringify({ message }), `${app.gatewayUrl}/api/nli`]);
    const [body, status] = stdout.trim().split("\n");
    assert.equal(stderr, "");
    assert.equal(Number(status), expectedStatus);
    const counts = await app.stats();
    assert.deepEqual(counts, expectedCounts);
    console.log(JSON.stringify({ scenario, phase: "curl-response", status: Number(status), body: JSON.parse(body), counts }));
  } finally { await app.close(); }
  await assert.rejects(fetch(`${app.gatewayUrl}/api/nli/health`));
  await assert.rejects(fetch(app.staticUrl));
  console.log(JSON.stringify({ scenario, phase: "closed", gatewayReachable: false, staticReachable: false }));
}
