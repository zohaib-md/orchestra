export type SourceId = string;
export type TriggerId = string;
export type ThreadId = string;
export type TicketId = string;
export type AssignmentId = string;
export type DecisionId = string;

export type SourceState = "running" | "paused" | "disabled";

/** A stream of events. Holds its read position so a restart does not replay. */
export interface Source {
  id: SourceId;
  kind: string;
  readPosition: string | null;
  state: SourceState;
}

/** One immutable event from a Source. */
export type TriggerDisposition =
  | { kind: "filtered"; code: string; at: number }
  | { kind: "evaluated"; decisionId: DecisionId; at: number }
  | { kind: "fannedOut"; ticketIds: TicketId[]; at: number };

export interface Trigger {
  id: TriggerId;
  sourceId: SourceId;
  /** The Source's own id for the event; drives deduplication. */
  externalId: string;
  /** Who caused the event, as the Source identifies them. */
  actor: string;
  /** The event type, e.g. "issue", "comment", "message". */
  kind: string;
  /** Source-specific data, opaque to the core. Stored as JSON text. */
  payload: string;
  createdAt: number;
  threadIds: ThreadId[];
  disposition: TriggerDisposition | null;
}

/** Triggers in time order; the unit within which Evals run. */
export interface Thread {
  id: ThreadId;
  sourceId: SourceId;
  label: string | null;
  meta: Record<string, unknown>;
}

export type Strength = "explicit" | "inferred";
export type DecisionOutcome = "accept" | "stop" | "ignore" | "unavailable";
export type AdmissionVia = "addressed" | "followup" | "admission" | "bot";

/** Why a Decision was recorded, or a Trigger was set aside. */
export interface Reason {
  code: string;
  values: Record<string, string>;
}

/** The result of an Eval over a batch of Triggers. */
export interface Decision {
  id: DecisionId;
  triggerIds: TriggerId[];
  outcome: DecisionOutcome;
  strength: Strength;
  reasons: Reason[];
  decidedAt: number;
  decidedBy: string;
}

/** What an accept grants: why the work may be done, and how far it may go. */
export interface Mandate {
  policyVersion: string;
  scope: string;
  strength: Strength;
  /** The requester's identity on the Source. */
  requester: string;
  sourceId: SourceId;
  matchedRules: string[];
  via: AdmissionVia;
}

export type TicketState = "open" | "ended";

export interface TicketOrigin {
  /** The admissible Trigger that gave the Eval's batch its strength. */
  triggerId: TriggerId;
  triggerIds: TriggerId[];
}

export interface TicketEnd {
  at: number;
  by: string;
  outcome: "completed" | "merged" | "closed" | "dropped" | "failed";
  reason: string | null;
}

/** A unit of authorized work. */
export interface Ticket {
  id: TicketId;
  mandate: Mandate;
  origin: TicketOrigin;
  state: TicketState;
  createdAt: number;
  end: TicketEnd | null;
}

export type AssignmentState = "pending" | "running" | "ended";
export type ReportStatus =
  | "progress"
  | "waiting"
  | "ready"
  | "blocked"
  | "failed"
  | "dropped";

/** The state an Assignment reports to its Ticket. */
export interface Report {
  status: ReportStatus;
  text: string | null;
  /** A question that waits for a person's answer. */
  question: string | null;
  at: number;
}

/** The binding of a Ticket to one Executor (worker) instance. */
export interface Assignment {
  id: AssignmentId;
  ticketId: TicketId;
  workerId: string;
  state: AssignmentState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  report: Report | null;
}
