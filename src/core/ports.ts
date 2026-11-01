import type {
  Assignment,
  AssignmentId,
  Decision,
  DecisionId,
  Source,
  SourceId,
  Thread,
  ThreadId,
  Ticket,
  TicketId,
  Trigger,
  TriggerId,
} from "./model.ts";

export interface SourceRepository {
  save(source: Source): void;
  get(id: SourceId): Source | undefined;
  list(): Source[];
  setReadPosition(id: SourceId, position: string): void;
}

export interface TriggerRepository {
  save(trigger: Trigger): void;
  get(id: TriggerId): Trigger | undefined;
  byExternalId(sourceId: SourceId, externalId: string): Trigger | undefined;
  listBySource(sourceId: SourceId): Trigger[];
  listByThread(threadId: ThreadId): Trigger[];
}

export interface ThreadRepository {
  save(thread: Thread): void;
  get(id: ThreadId): Thread | undefined;
  listBySource(sourceId: SourceId): Thread[];
}

export interface TicketRepository {
  save(ticket: Ticket): void;
  get(id: TicketId): Ticket | undefined;
  list(state?: Ticket["state"]): Ticket[];
}

export interface AssignmentRepository {
  save(assignment: Assignment): void;
  get(id: AssignmentId): Assignment | undefined;
  list(state?: Assignment["state"]): Assignment[];
  listByTicket(ticketId: TicketId): Assignment[];
  /**
   * Atomically transition pending -> running. Returns the running Assignment,
   * or undefined if the Assignment was not pending (already claimed or ended).
   * This is the database-level safeguard against two workers claiming the
   * same Assignment.
   */
  claim(id: AssignmentId, startedAt: number): Assignment | undefined;
}

export interface DecisionRepository {
  save(decision: Decision): void;
  get(id: DecisionId): Decision | undefined;
  list(): Decision[];
}

/** Durable queue of Triggers awaiting evaluation, per Thread. */
export interface EvalQueueRepository {
  enqueue(threadId: ThreadId, triggerId: TriggerId): void;
  /** Distinct threads that have queued triggers. */
  pendingThreads(): ThreadId[];
  /** Take and remove all queued triggers for a thread, in insertion order. */
  takeThread(threadId: ThreadId): TriggerId[];
}

/** Many-to-many relation between Tickets and Threads. */
export interface SubscriptionRepository {
  subscribe(ticketId: TicketId, threadId: ThreadId): void;
  unsubscribe(ticketId: TicketId, threadId: ThreadId): void;
  threadIdsFor(ticketId: TicketId): ThreadId[];
  /** Distinct ids of open Tickets subscribed to any of the given threads. */
  openTicketIdsFor(threadIds: ThreadId[]): TicketId[];
}

/**
 * The domain-facing contract for persistent state. The Store implements it;
 * the Engine depends only on this interface, never on SQLite.
 */
export interface Repositories {
  sources: SourceRepository;
  triggers: TriggerRepository;
  threads: ThreadRepository;
  tickets: TicketRepository;
  assignments: AssignmentRepository;
  decisions: DecisionRepository;
  evalQueue: EvalQueueRepository;
  subscriptions: SubscriptionRepository;
  /** Run `fn` in one transaction; roll back on throw. */
  atomic<T>(fn: () => T): T;
}
