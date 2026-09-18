import { listCapabilitiesResponse, listContactsResponse, navigateResponse } from "./responses.mjs";
import { isCurrentProjectScopeConstrained, isTargetInCurrentProjectScope } from "./router.mjs";

const navigationSuffixes = ["로 이동", "으로 이동", "보여줘"];

// Context is the authoritative loaded registry, never a browser/model proposal.
export function resolveLocalFastPath(message, context) {
  if (typeof message !== "string") return null;
  const command = normalizeCommand(message);
  if (!command) return null;
  if (command === "도움말" || command === "사용법") return listCapabilitiesResponse();
  if (command === "연락처" || command === "연락처 보여줘") return listContactsResponse(context);

  const targetIds = new Set();
  for (const target of context.routes.targets) {
    const names = [target.label, ...(target.aliases || [])];
    if (names.some((name) => matchesNavigation(command, name))) targetIds.add(target.id);
  }
  // Resolve ambiguity before scope: location must not silently choose an alias.
  if (targetIds.size !== 1) return null;
  const [targetId] = targetIds;
  if (!context.targetById.has(targetId)) return null;
  if (isCurrentProjectScopeConstrained(command, context) && !isTargetInCurrentProjectScope(targetId, context)) {
    return null;
  }
  return navigateResponse(targetId);
}

function matchesNavigation(command, name) {
  if (typeof name !== "string") return false;
  const label = normalizeCommand(name);
  return Boolean(label) && navigationSuffixes.some((suffix) =>
    command === label + suffix || command === `${label} ${suffix}`
  );
}

function normalizeCommand(value) {
  return value.normalize("NFKC")
    .replace(/\p{Script=Latin}/gu, (letter) => letter.toLowerCase())
    // Unlike JS trim/\s, Unicode White_Space does not discard the invisible BOM.
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^ +| +$/g, "");
}
