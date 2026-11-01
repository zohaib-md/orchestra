import type { SourceId, ThreadId, TriggerId } from "./model";
import { key } from "./ids";

/** Canonical Trigger id: derived from its Source identity, so equal events are equal ids. */
export function triggerId(sourceId: SourceId, externalId: string): TriggerId {
  return key("trigger", sourceId, externalId);
}

/** A raw, source-normalized event before it becomes a stored Trigger. */
export interface TriggerInput {
  sourceId: SourceId;
  externalId: string;
  actor: string;
  kind: string;
  payload: string;
  createdAt: number;
  threadIds: ThreadId[];
}
