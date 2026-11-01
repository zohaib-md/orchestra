import type { AdmissionVia, SourceId, Strength, Trigger } from "./model";

export interface SourcePolicyPart {
  /** Actors allowed to originate work (explicit strength). */
  allowed: string[];
  /** Bots that may produce candidates (inferred strength). */
  bots: string[];
}

export interface AdmissionRule {
  id: string;
  /** Trigger kinds this rule matches. */
  kinds: string[];
  /** Scope granted to an accepted Ticket under this rule. */
  scope: string;
}

export interface Policy {
  version: string;
  rules: AdmissionRule[];
  sources: Record<SourceId, SourcePolicyPart>;
}

export function sourcePart(policy: Policy, sourceId: SourceId): SourcePolicyPart {
  return policy.sources[sourceId] ?? { allowed: [], bots: [] };
}

export function isPerson(policy: Policy, sourceId: SourceId, actor: string): boolean {
  return sourcePart(policy, sourceId).allowed.includes(actor);
}

export type GateResult =
  | {
      admitted: true;
      strength: Strength;
      basis: AdmissionVia;
      actorKind: "person" | "bot";
    }
  | { admitted: false; actorKind: "other" };

/**
 * Deterministic admission: who may originate work through this Source.
 * This is the first, deterministic layer of evaluation. The semantic
 * judgement lives in the Assessor (second, pluggable layer).
 */
export function gate(policy: Policy, trigger: Trigger): GateResult {
  const part = sourcePart(policy, trigger.sourceId);
  if (part.allowed.includes(trigger.actor)) {
    return {
      admitted: true,
      strength: "explicit",
      basis: "addressed",
      actorKind: "person",
    };
  }
  if (part.bots.includes(trigger.actor)) {
    return { admitted: true, strength: "inferred", basis: "bot", actorKind: "bot" };
  }
  return { admitted: false, actorKind: "other" };
}
