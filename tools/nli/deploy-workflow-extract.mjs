import assert from "node:assert/strict";

export function extractWorkflowRemote(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  const bodyStart = source.indexOf("          set -euo pipefail", start);
  const bodyEnd = source.indexOf("\n          REMOTE", bodyStart);
  const nextStep = source.indexOf("\n      - name:", start + 1);
  assert.ok(bodyStart > start && bodyEnd > bodyStart && (nextStep < 0 || bodyEnd < nextStep));
  return source.slice(bodyStart, bodyEnd).replace(/^          /gm, "");
}

export function extractWorkflowLifecycle(source) {
  const deploy = extractWorkflowRemote(source, "Deploy exact triggering revision");
  const marker = "<<'LIFECYCLE'\n";
  const start = deploy.indexOf(marker);
  const end = deploy.indexOf("\nLIFECYCLE", start);
  assert.ok(start >= 0 && end > start, "Missing embedded lifecycle module");
  return deploy.slice(start + marker.length, end);
}
