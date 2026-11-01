import type { Thread, Ticket, Trigger } from "./model";
import type { GateResult, Policy } from "./policy";

export interface AssessmentInput {
  /** The admissible trigger that gave the batch its strength. */
  trigger: Trigger;
  batch: Trigger[];
  thread: Thread | undefined;
  /** Open tickets on the thread, for context. */
  tickets: Ticket[];
  policy: Policy;
  gate: Extract<GateResult, { admitted: true }>;
}

export interface Assessment {
  outcome: "accept" | "ignore";
  ruleId: string | null;
  scope: string;
  reasonCode: string;
}

/**
 * The semantic (second) layer of evaluation. Pluggable so V0.6 can replace
 * the deterministic implementation with an LLM without touching the gate.
 */
export interface Assessor {
  assess(input: AssessmentInput): Assessment;
}

/**
 * Deterministic semantic evaluator. An explicit request from an allowed
 * person is always accepted; an inferred candidate from a bot is accepted
 * only when a rule matches its kind.
 */
export class DeterministicAssessor implements Assessor {
  assess(input: AssessmentInput): Assessment {
    const rule =
      input.policy.rules.find((r) => r.kinds.includes(input.trigger.kind)) ?? null;

    if (input.gate.strength === "explicit") {
      return {
        outcome: "accept",
        ruleId: rule?.id ?? null,
        scope: rule?.scope ?? `handle ${input.trigger.kind}`,
        reasonCode: "addressed",
      };
    }

    if (rule !== null) {
      return {
        outcome: "accept",
        ruleId: rule.id,
        scope: rule.scope,
        reasonCode: "matched_rule",
      };
    }

    return { outcome: "ignore", ruleId: null, scope: "", reasonCode: "no_rule" };
  }
}
