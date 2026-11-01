import { createHash } from "node:crypto";

/**
 * Deterministic ids derived from their inputs: equal inputs produce equal ids.
 * Used for idempotency — e.g. a Trigger's id is `key(sourceId, externalId)`,
 * so the same external event always maps to the same Trigger id.
 */
export function key(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
