export const scenarios = Object.freeze(["healthy", "upstream-error", "escalation", "rate-limited"]);

export function assertScenario(scenario) {
  if (!scenarios.includes(scenario)) throw new Error(`Unknown application scenario: ${scenario}`);
}
