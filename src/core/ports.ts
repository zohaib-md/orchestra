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
  listByTicket(ticketId: TicketId): Assignment[];
}

export interface DecisionRepository {
  save(decision: Decision): void;
  get(id: DecisionId): Decision | undefined;
  list(): Decision[];
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
  /** Run `fn` in one transaction; roll back on throw. */
  atomic<T>(fn: () => T): T;
}
