import type { Policy } from "../src/core/policy.ts";
import type { TriggerInput } from "../src/core/trigger.ts";

export const SOURCE = "source:gh:owner/repo";

export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: "v1",
    rules: [{ id: "fix", kinds: ["issue", "comment"], scope: "fix the issue" }],
    sources: {
      [SOURCE]: { allowed: ["alice"], bots: ["ci-bot"] },
    },
    ...overrides,
  };
}

export function makeInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    sourceId: SOURCE,
    externalId: "evt-1",
    actor: "alice",
    kind: "issue",
    payload: JSON.stringify({ title: "Fix the bug" }),
    createdAt: 1_700_000_000_000,
    threadIds: ["thread-1"],
    ...overrides,
  };
}

export function makeInputs(
  count: number,
  overrides: Partial<TriggerInput> = {},
): TriggerInput[] {
  return Array.from({ length: count }, (_, i) =>
    makeInput({
      externalId: `evt-${i}`,
      threadIds: [`thread-${i}`],
      ...overrides,
    }),
  );
}
