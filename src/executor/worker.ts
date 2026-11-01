import type { Assignment, Report, Ticket } from "../core/model";

export interface WorkerContext {
  ticket: Ticket;
  assignment: Assignment;
  /** Dedicated working directory for this assignment. */
  workDir: string;
  /** Canonical inputs derived from the ticket's origin triggers. */
  inputs: string[];
}

export interface WorkerResult {
  report: Report;
  /** References to generated artifacts, not the artifacts themselves. */
  artifacts: string[];
}

/**
 * Pluggable execution mechanism. The Worker Runtime depends only on this
 * interface, so DeepSeek Harness or another agent runtime can be substituted
 * without touching the Router or the Store.
 */
export interface Worker {
  run(ctx: WorkerContext): Promise<WorkerResult>;
}
