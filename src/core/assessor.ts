import type { Thread, Ticket, Trigger } from "./model.ts";
import type { GateResult, Policy } from "./policy.ts";

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
  outcome: "accept" | "ignore" | "unavailable";
  ruleId: string | null;
  scope: string;
  reasonCode: string;
}

/**
 * The semantic (second) layer of evaluation. Pluggable and asynchronous: an
 * LLM-backed implementation can be substituted without touching the gate.
 * An `unavailable` outcome means the assessor could not decide (e.g. the model
 * was unreachable); the Router requeues the batch for a fresh eval.
 */
export interface Assessor {
  assess(input: AssessmentInput): Promise<Assessment>;
}

/**
 * Deterministic semantic evaluator. An explicit request from an allowed
 * person is always accepted; an inferred candidate from a bot is accepted
 * only when a rule matches its kind. Never returns `unavailable`.
 */
export class DeterministicAssessor implements Assessor {
  async assess(input: AssessmentInput): Promise<Assessment> {
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
