import type { Assessor, Assessment, AssessmentInput } from "../core/assessor.ts";
import type { ModelClient } from "./model.ts";

function buildPrompt(input: AssessmentInput): string {
  const rules = input.policy.rules
    .map((r) => `- ${r.id}: kinds [${r.kinds.join(", ")}] → scope "${r.scope}"`)
    .join("\n");
  return [
    "You are the admission evaluator of an autonomous coding agent.",
    "Decide whether to accept or ignore this work request.",
    "",
    `Requester: ${input.trigger.actor}`,
    `Strength: ${input.gate.strength} (${input.gate.basis})`,
    `Event kind: ${input.trigger.kind}`,
    `Content: ${input.trigger.payload}`,
    "",
    "Available rules:",
    rules === "" ? "  (none)" : rules,
    "",
    "Respond with exactly one JSON object, no prose, one of:",
    '{"outcome":"accept","rule":"<ruleId>","scope":"<scope>"}',
    '{"outcome":"ignore"}',
  ].join("\n");
}

function parseAssessment(raw: string, input: AssessmentInput): Assessment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { outcome: "unavailable", ruleId: null, scope: "", reasonCode: "invalid_output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { outcome: "unavailable", ruleId: null, scope: "", reasonCode: "invalid_output" };
  }
  const outcome = (parsed as Record<string, unknown>)["outcome"];
  if (outcome === "ignore") {
    return { outcome: "ignore", ruleId: null, scope: "", reasonCode: "llm_ignore" };
  }
  if (outcome === "accept") {
    const obj = parsed as Record<string, unknown>;
    const ruleId = typeof obj["rule"] === "string" ? obj["rule"] : null;
    const rule =
      (ruleId === null ? undefined : input.policy.rules.find((r) => r.id === ruleId)) ??
      input.policy.rules.find((r) => r.kinds.includes(input.trigger.kind)) ??
      null;
    const scope =
      typeof obj["scope"] === "string" && obj["scope"].trim() !== ""
        ? obj["scope"]
        : (rule?.scope ?? `handle ${input.trigger.kind}`);
    return { outcome: "accept", ruleId: rule?.id ?? null, scope, reasonCode: "llm_accept" };
  }
  return { outcome: "unavailable", ruleId: null, scope: "", reasonCode: "invalid_outcome" };
}

/**
 * LLM-backed semantic evaluator. A model or parse failure returns
 * `unavailable`, which the Router treats as a transient failure and requeues
 * (bounded). Authorization is NOT decided here — the deterministic gate runs
 * before the assessor is invoked.
 */
export class LlmAssessor implements Assessor {
  constructor(private readonly client: ModelClient) {}

  async assess(input: AssessmentInput): Promise<Assessment> {
    let raw: string;
    try {
      raw = await this.client.complete(buildPrompt(input));
    } catch {
      return { outcome: "unavailable", ruleId: null, scope: "", reasonCode: "model_error" };
    }
    return parseAssessment(raw, input);
  }
}
