import { key } from "./ids";
import { UserError, USER_ERRORS } from "./errors";
import { DeterministicAssessor } from "./assessor";
import type { Assessor, Assessment } from "./assessor";
import { gate, isPerson } from "./policy";
import type { GateResult, Policy } from "./policy";
import { triggerId } from "./trigger";
import type { TriggerInput } from "./trigger";
import type { Repositories } from "./ports";
import type {
  Assignment,
  AssignmentId,
  Decision,
  Report,
  ThreadId,
  Ticket,
  TicketId,
  Trigger,
  TriggerId,
} from "./model";

export type ReceiveResult = "stored" | "duplicate";

export interface EngineOptions {
  policy: () => Policy;
  assessor?: Assessor;
  /** Replacement assignments allowed after the first attempt, per ticket. */
  maxRetries?: number;
  now?: () => number;
}

/**
 * The Router. The single writer of Triggers, Threads, Decisions, Tickets and
 * Assignments. It evaluates triggers and, for accepted work, creates a Ticket
 * and a pending Assignment (the dispatch intent consumed by the Worker Runtime).
 */
export class Engine {
  private readonly policy: () => Policy;
  private readonly assessor: Assessor;
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(
    private readonly repos: Repositories,
    options: EngineOptions,
  ) {
    this.policy = options.policy;
    this.assessor = options.assessor ?? new DeterministicAssessor();
    this.maxRetries = options.maxRetries ?? 0;
    this.now = options.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------------ Intake

  /** Ingest a normalized event. Idempotent: a duplicate delivery returns "duplicate". */
  receive(input: TriggerInput): ReceiveResult {
    const id = triggerId(input.sourceId, input.externalId);
    return this.repos.atomic(() => {
      if (this.repos.triggers.get(id) !== undefined) return "duplicate";

      const threadIds =
        input.threadIds.length > 0 ? input.threadIds : [key("thread", id)];
      const primaryThreadId = threadIds[0];
      if (primaryThreadId === undefined) {
        throw new UserError(USER_ERRORS.invalid);
      }

      for (const threadId of threadIds) {
        if (this.repos.threads.get(threadId) === undefined) {
          this.repos.threads.save({
            id: threadId,
            sourceId: input.sourceId,
            label: null,
            meta: {},
          });
        }
      }

      const trigger: Trigger = {
        id,
        sourceId: input.sourceId,
        externalId: input.externalId,
        actor: input.actor,
        kind: input.kind,
        payload: input.payload,
        createdAt: input.createdAt,
        threadIds,
        disposition: null,
      };
      this.repos.triggers.save(trigger);

      // Subscription-aware routing: fan out to open tickets on these threads.
      const subscribed = this.repos.subscriptions.openTicketIdsFor(threadIds);
      if (subscribed.length > 0) {
        trigger.disposition = {
          kind: "fannedOut",
          ticketIds: subscribed,
          at: this.now(),
        };
        this.repos.triggers.save(trigger);
        // A person's message that reached a Ticket stays with that Ticket.
        if (isPerson(this.policy(), input.sourceId, input.actor)) {
          return "stored";
        }
      }

      this.repos.evalQueue.enqueue(primaryThreadId, id);
      return "stored";
    });
  }

  // ------------------------------------------------------------------- Eval

  /** Evaluate queued triggers, one transaction per thread. Returns threads evaluated. */
  evaluateDue(): number {
    let evaluated = 0;
    for (const threadId of this.repos.evalQueue.pendingThreads()) {
      if (this.repos.atomic(() => this.evaluateThread(threadId))) evaluated++;
    }
    return evaluated;
  }

  private evaluateThread(threadId: ThreadId): boolean {
    const batchIds = this.repos.evalQueue.takeThread(threadId);
    if (batchIds.length === 0) return false;

    const triggers = batchIds
      .map((id) => this.repos.triggers.get(id))
      .filter((t): t is Trigger => t !== undefined);

    const policy = this.policy();
    const thread = this.repos.threads.get(threadId);
    const tickets = this.repos.subscriptions
      .openTicketIdsFor([threadId])
      .map((id) => this.repos.tickets.get(id))
      .filter((t): t is Ticket => t !== undefined);

    // Two-stage evaluation: deterministic gate, then the semantic assessor.
    let primary: Trigger | undefined;
    let admitted: Extract<GateResult, { admitted: true }> | undefined;
    for (const trigger of triggers) {
      const g = gate(policy, trigger);
      if (g.admitted) {
        primary = trigger;
        admitted = g;
        break;
      }
    }

    let outcome: Decision["outcome"];
    let assessment: Assessment | undefined;
    let reasons: Decision["reasons"];

    if (primary === undefined || admitted === undefined) {
      outcome = "ignore";
      reasons = [{ code: "not_admitted", values: {} }];
    } else {
      assessment = this.assessor.assess({
        trigger: primary,
        batch: triggers,
        thread,
        tickets,
        policy,
        gate: admitted,
      });
      outcome = assessment.outcome;
      reasons = [{ code: assessment.reasonCode, values: {} }];
    }

    const decision: Decision = {
      id: key("decision", threadId, ...batchIds),
      triggerIds: batchIds,
      outcome,
      strength: admitted?.strength ?? "explicit",
      reasons,
      decidedAt: this.now(),
      decidedBy: "router",
    };
    this.repos.decisions.save(decision);

    for (const trigger of triggers) {
      trigger.disposition = {
        kind: "evaluated",
        decisionId: decision.id,
        at: this.now(),
      };
      this.repos.triggers.save(trigger);
    }

    if (
      outcome === "accept" &&
      primary !== undefined &&
      admitted !== undefined &&
      assessment !== undefined
    ) {
      this.acceptTicket(primary, batchIds, admitted, assessment, policy.version);
    }

    return true;
  }

  private acceptTicket(
    primary: Trigger,
    batchIds: TriggerId[],
    admitted: Extract<GateResult, { admitted: true }>,
    assessment: Assessment,
    policyVersion: string,
  ): void {
    const ticketId = key("ticket", primary.id);
    const ticket: Ticket = {
      id: ticketId,
      mandate: {
        policyVersion,
        scope: assessment.scope,
        strength: admitted.strength,
        requester: primary.actor,
        sourceId: primary.sourceId,
        matchedRules: assessment.ruleId === null ? [] : [assessment.ruleId],
        via: admitted.basis,
      },
      origin: { triggerId: primary.id, triggerIds: batchIds },
      state: "open",
      createdAt: this.now(),
      end: null,
    };
    this.repos.tickets.save(ticket);

    // Subscribe the ticket to every thread in the batch.
    const threadIds = new Set<ThreadId>(primary.threadIds);
    for (const id of batchIds) {
      const trigger = this.repos.triggers.get(id);
      for (const threadId of trigger?.threadIds ?? []) threadIds.add(threadId);
    }
    for (const threadId of threadIds) {
      this.repos.subscriptions.subscribe(ticketId, threadId);
    }

    // Dispatch intent: the first pending Assignment.
    this.createAssignment(ticketId);
  }

  private createAssignment(ticketId: TicketId): Assignment {
    const seq = this.repos.assignments.listByTicket(ticketId).length;
    const assignment: Assignment = {
      id: key("assignment", ticketId, String(seq)),
      ticketId,
      workerId: `worker-${ticketId}`,
      state: "pending",
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      heartbeatAt: null,
      progressAt: null,
      report: null,
      artifacts: [],
    };
    this.repos.assignments.save(assignment);
    return assignment;
  }

  // ------------------------------------------------------------- People role

  stopTicket(ticketId: TicketId, reason?: string): void {
    this.repos.atomic(() => {
      const ticket = this.repos.tickets.get(ticketId);
      if (ticket === undefined) throw new UserError(USER_ERRORS.missing);
      if (ticket.state !== "open") throw new UserError(USER_ERRORS.notOpen);
      ticket.state = "ended";
      ticket.end = { at: this.now(), by: "person", outcome: "closed", reason: reason ?? null };
      this.repos.tickets.save(ticket);
    });
  }

  // ------------------------------------------------------------------ Reads

  getTicket(ticketId: TicketId): Ticket | undefined {
    return this.repos.tickets.get(ticketId);
  }

  getTrigger(triggerId: TriggerId): Trigger | undefined {
    return this.repos.triggers.get(triggerId);
  }

  assignmentCount(ticketId: TicketId): number {
    return this.repos.assignments.listByTicket(ticketId).length;
  }

  // ------------------------------------------------------------ Executor role

  pendingAssignments(): Assignment[] {
    return this.repos.assignments.list("pending");
  }

  runningAssignments(): Assignment[] {
    return this.repos.assignments.list("running");
  }

  completedAssignments(): Assignment[] {
    return this.repos.assignments.list("completed");
  }

  claim(assignmentId: AssignmentId): Assignment | undefined {
    return this.repos.assignments.claim(assignmentId, this.now());
  }

  /** Worker liveness signal. No-op unless the assignment is running. */
  heartbeat(assignmentId: AssignmentId): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined || assignment.state !== "running") return;
      assignment.heartbeatAt = this.now();
      this.repos.assignments.save(assignment);
    });
  }

  /** Worker progress signal. No-op unless the assignment is running. */
  progress(assignmentId: AssignmentId): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined || assignment.state !== "running") return;
      assignment.progressAt = this.now();
      this.repos.assignments.save(assignment);
    });
  }

  /** Persist a worker's result durably: running -> completed. */
  complete(
    assignmentId: AssignmentId,
    report: Report,
    artifacts: string[] = [],
  ): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined) throw new UserError(USER_ERRORS.missing);
      if (assignment.state !== "running") {
        throw new UserError(USER_ERRORS.invalid, { state: assignment.state });
      }
      const updated: Assignment = {
        ...assignment,
        state: "completed",
        report,
        artifacts,
      };
      this.repos.assignments.save(updated);
    });
  }

  /** Finalize a completed assignment: completed -> ended. Idempotent. */
  deliver(assignmentId: AssignmentId): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined) throw new UserError(USER_ERRORS.missing);
      if (assignment.state !== "completed") return;
      const updated: Assignment = {
        ...assignment,
        state: "ended",
        endedAt: this.now(),
      };
      this.repos.assignments.save(updated);
      this.endTicketIfDropped(assignment.ticketId, assignment.report);
    });
  }

  /**
   * Retry delivery of stranded `completed` assignments without re-executing
   * the work. Returns the number delivered.
   */
  deliverCompleted(): number {
    return this.repos.atomic(() => {
      let delivered = 0;
      for (const assignment of this.repos.assignments.list("completed")) {
        const updated: Assignment = {
          ...assignment,
          state: "ended",
          endedAt: this.now(),
        };
        this.repos.assignments.save(updated);
        this.endTicketIfDropped(assignment.ticketId, assignment.report);
        delivered++;
      }
      return delivered;
    });
  }

  /** Pause a running assignment awaiting external input: running -> waiting. */
  wait(assignmentId: AssignmentId, report: Report): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined) throw new UserError(USER_ERRORS.missing);
      if (assignment.state !== "running") {
        throw new UserError(USER_ERRORS.invalid, { state: assignment.state });
      }
      const updated: Assignment = {
        ...assignment,
        state: "waiting",
        report,
      };
      this.repos.assignments.save(updated);
    });
  }

  /** Record a failed execution: running -> ended. The Ticket stays open. */
  fail(assignmentId: AssignmentId, report: Report): void {
    this.repos.atomic(() => {
      const assignment = this.repos.assignments.get(assignmentId);
      if (assignment === undefined) throw new UserError(USER_ERRORS.missing);
      if (assignment.state !== "running") {
        throw new UserError(USER_ERRORS.invalid, { state: assignment.state });
      }
      const updated: Assignment = {
        ...assignment,
        state: "ended",
        endedAt: this.now(),
        report,
      };
      this.repos.assignments.save(updated);
    });
  }

  private endTicketIfDropped(ticketId: TicketId, report: Report | null): void {
    if (report?.status !== "dropped") return;
    const ticket = this.repos.tickets.get(ticketId);
    if (ticket !== undefined && ticket.state === "open") {
      ticket.state = "ended";
      ticket.end = {
        at: this.now(),
        by: "executor",
        outcome: "dropped",
        reason: report.text,
      };
      this.repos.tickets.save(ticket);
    }
  }

  /** Create a replacement Assignment for an open Ticket, respecting maxRetries. */
  replaceAssignment(ticketId: TicketId): Assignment | undefined {
    return this.repos.atomic(() => {
      const ticket = this.repos.tickets.get(ticketId);
      if (ticket === undefined || ticket.state !== "open") return undefined;
      const attempts = this.repos.assignments.listByTicket(ticketId).length;
      if (attempts > this.maxRetries) return undefined;
      return this.createAssignment(ticketId);
    });
  }

  /** Recover Assignments left in `running` by a dead process. Returns count recovered. */
  recoverInterrupted(): number {
    return this.repos.atomic(() => {
      let recovered = 0;
      for (const assignment of this.repos.assignments.list("running")) {
        const ended: Assignment = {
          ...assignment,
          state: "ended",
          endedAt: this.now(),
          report: {
            status: "failed",
            text: "host interrupted",
            question: null,
            at: this.now(),
          },
        };
        this.repos.assignments.save(ended);
        recovered++;
        const ticket = this.repos.tickets.get(assignment.ticketId);
        if (ticket !== undefined && ticket.state === "open") {
          this.createAssignment(assignment.ticketId);
        }
      }
      return recovered;
    });
  }
}
