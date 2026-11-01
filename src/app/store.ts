import { DatabaseSync } from "node:sqlite";
import type {
  Assignment,
  Decision,
  Source,
  Thread,
  Ticket,
  Trigger,
} from "../core/model.ts";
import type {
  AssignmentRepository,
  DecisionRepository,
  EvalQueueRepository,
  Repositories,
  SourceRepository,
  SubscriptionRepository,
  ThreadRepository,
  TicketRepository,
  TriggerRepository,
} from "../core/ports.ts";

type Row = Record<string, null | number | bigint | string | Uint8Array>;

function parseJson<T>(text: string | null, fallback: T): T {
  return text === null ? fallback : (JSON.parse(text) as T);
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    read_position TEXT,
    state TEXT NOT NULL
  );
  CREATE TABLE triggers (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    disposition TEXT,
    UNIQUE (source_id, external_id)
  );
  CREATE TABLE thread_triggers (
    thread_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, trigger_id)
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    label TEXT,
    meta TEXT NOT NULL
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    policy_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    strength TEXT NOT NULL,
    requester TEXT NOT NULL,
    source_id TEXT NOT NULL,
    matched_rules TEXT NOT NULL,
    via TEXT NOT NULL,
    origin_trigger_id TEXT NOT NULL,
    origin_trigger_ids TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT,
    ended_outcome TEXT,
    ended_reason TEXT
  );
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    report_status TEXT,
    report_text TEXT,
    report_question TEXT,
    report_at INTEGER
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    trigger_ids TEXT NOT NULL,
    outcome TEXT NOT NULL,
    strength TEXT NOT NULL,
    reasons TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    decided_by TEXT NOT NULL
  );
  CREATE INDEX idx_triggers_source ON triggers (source_id);
  CREATE INDEX idx_thread_triggers_trigger ON thread_triggers (trigger_id);
  CREATE INDEX idx_tickets_state ON tickets (state);
  CREATE INDEX idx_assignments_ticket ON assignments (ticket_id);
  `,
  // v2: evaluation queue + ticket-thread subscriptions
  `
  CREATE TABLE eval_queue (
    thread_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, trigger_id)
  );
  CREATE TABLE subscriptions (
    ticket_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    PRIMARY KEY (ticket_id, thread_id)
  );
  CREATE INDEX idx_subscriptions_thread ON subscriptions (thread_id);
  `,
  // v3: artifact references on assignments
  `ALTER TABLE assignments ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]';`,
];

export class Store implements Repositories {
  readonly sources: SourceRepository;
  readonly triggers: TriggerRepository;
  readonly threads: ThreadRepository;
  readonly tickets: TicketRepository;
  readonly assignments: AssignmentRepository;
  readonly decisions: DecisionRepository;
  readonly evalQueue: EvalQueueRepository;
  readonly subscriptions: SubscriptionRepository;

  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();

    this.sources = this.buildSources();
    this.triggers = this.buildTriggers();
    this.threads = this.buildThreads();
    this.tickets = this.buildTickets();
    this.assignments = this.buildAssignments();
    this.decisions = this.buildDecisions();
    this.evalQueue = this.buildEvalQueue();
    this.subscriptions = this.buildSubscriptions();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    const version = Number(row["user_version"] ?? 0);
    for (let i = version; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i];
      if (migration === undefined) break;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private buildSources(): SourceRepository {
    const db = this.db;
    const map = (row: Row): Source => ({
      id: row["id"] as string,
      kind: row["kind"] as string,
      readPosition: row["read_position"] as string | null,
      state: row["state"] as Source["state"],
    });
    return {
      save(source) {
        db.prepare(
          `INSERT INTO sources (id, kind, read_position, state)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             read_position = excluded.read_position,
             state = excluded.state`,
        ).run(source.id, source.kind, source.readPosition, source.state);
      },
      get(id) {
        const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
          | Row
          | undefined;
        return row === undefined ? undefined : map(row);
      },
      list() {
        return (db.prepare("SELECT * FROM sources").all() as Row[]).map(map);
      },
      setReadPosition(id, position) {
        db.prepare("UPDATE sources SET read_position = ? WHERE id = ?").run(
          position,
          id,
        );
      },
    };
  }

  private buildTriggers(): TriggerRepository {
    const db = this.db;
    const threadIdsOf = (triggerId: string): string[] =>
      (
        db
          .prepare("SELECT thread_id FROM thread_triggers WHERE trigger_id = ?")
          .all(triggerId) as Row[]
      ).map((r) => r["thread_id"] as string);

    const map = (row: Row): Trigger => ({
      id: row["id"] as string,
      sourceId: row["source_id"] as string,
      externalId: row["external_id"] as string,
      actor: row["actor"] as string,
      kind: row["kind"] as string,
      payload: row["payload"] as string,
      createdAt: Number(row["created_at"]),
      threadIds: threadIdsOf(row["id"] as string),
      disposition: parseJson<Trigger["disposition"]>(
        row["disposition"] as string | null,
        null,
      ),
    });

    return {
      save(trigger) {
        db.prepare(
          `INSERT INTO triggers
             (id, source_id, external_id, actor, kind, payload, created_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             actor = excluded.actor,
             kind = excluded.kind,
             payload = excluded.payload,
             disposition = excluded.disposition`,
        ).run(
          trigger.id,
          trigger.sourceId,
          trigger.externalId,
          trigger.actor,
          trigger.kind,
          trigger.payload,
          trigger.createdAt,
          trigger.disposition === null
            ? null
            : toJson(trigger.disposition),
        );
        db.prepare("DELETE FROM thread_triggers WHERE trigger_id = ?").run(
          trigger.id,
        );
        const insert = db.prepare(
          "INSERT INTO thread_triggers (thread_id, trigger_id) VALUES (?, ?)",
        );
        for (const threadId of trigger.threadIds) {
          insert.run(threadId, trigger.id);
        }
      },
      get(id) {
        const row = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as
          | Row
          | undefined;
        return row === undefined ? undefined : map(row);
      },
      byExternalId(sourceId, externalId) {
        const row = db
          .prepare(
            "SELECT * FROM triggers WHERE source_id = ? AND external_id = ?",
          )
          .get(sourceId, externalId) as Row | undefined;
        return row === undefined ? undefined : map(row);
      },
      listBySource(sourceId) {
        return (
          db
            .prepare("SELECT * FROM triggers WHERE source_id = ?")
            .all(sourceId) as Row[]
        ).map(map);
      },
      listByThread(threadId) {
        return (
          db
            .prepare(
              `SELECT t.* FROM triggers t
               JOIN thread_triggers tt ON tt.trigger_id = t.id
               WHERE tt.thread_id = ?`,
            )
            .all(threadId) as Row[]
        ).map(map);
      },
    };
  }

  private buildThreads(): ThreadRepository {
    const db = this.db;
    const map = (row: Row): Thread => ({
      id: row["id"] as string,
      sourceId: row["source_id"] as string,
      label: row["label"] as string | null,
      meta: parseJson<Record<string, unknown>>(row["meta"] as string, {}),
    });
    return {
      save(thread) {
        db.prepare(
          `INSERT INTO threads (id, source_id, label, meta)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source_id = excluded.source_id,
             label = excluded.label,
             meta = excluded.meta`,
        ).run(thread.id, thread.sourceId, thread.label, toJson(thread.meta));
      },
      get(id) {
        const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
          | Row
          | undefined;
        return row === undefined ? undefined : map(row);
      },
      listBySource(sourceId) {
        return (
          db
            .prepare("SELECT * FROM threads WHERE source_id = ?")
            .all(sourceId) as Row[]
        ).map(map);
      },
    };
  }

  private buildTickets(): TicketRepository {
    const db = this.db;
    const map = (row: Row): Ticket => ({
      id: row["id"] as string,
      mandate: {
        policyVersion: row["policy_version"] as string,
        scope: row["scope"] as string,
        strength: row["strength"] as Ticket["mandate"]["strength"],
        requester: row["requester"] as string,
        sourceId: row["source_id"] as string,
        matchedRules: parseJson<string[]>(row["matched_rules"] as string, []),
        via: row["via"] as Ticket["mandate"]["via"],
      },
      origin: {
        triggerId: row["origin_trigger_id"] as string,
        triggerIds: parseJson<string[]>(
          row["origin_trigger_ids"] as string,
          [],
        ),
      },
      state: row["state"] as Ticket["state"],
      createdAt: Number(row["created_at"]),
      end:
        row["ended_at"] === null
          ? null
          : {
              at: Number(row["ended_at"]),
              by: row["ended_by"] as string,
              outcome: row["ended_outcome"] as NonNullable<
                Ticket["end"]
              >["outcome"],
              reason: row["ended_reason"] as string | null,
            },
    });
    return {
      save(ticket) {
        const end = ticket.end;
        db.prepare(
          `INSERT INTO tickets
             (id, policy_version, scope, strength, requester, source_id,
              matched_rules, via, origin_trigger_id, origin_trigger_ids,
              state, created_at, ended_at, ended_by, ended_outcome, ended_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             policy_version = excluded.policy_version,
             scope = excluded.scope,
             strength = excluded.strength,
             requester = excluded.requester,
             source_id = excluded.source_id,
             matched_rules = excluded.matched_rules,
             via = excluded.via,
             origin_trigger_id = excluded.origin_trigger_id,
             origin_trigger_ids = excluded.origin_trigger_ids,
             state = excluded.state,
             created_at = excluded.created_at,
             ended_at = excluded.ended_at,
             ended_by = excluded.ended_by,
             ended_outcome = excluded.ended_outcome,
             ended_reason = excluded.ended_reason`,
        ).run(
          ticket.id,
          ticket.mandate.policyVersion,
          ticket.mandate.scope,
          ticket.mandate.strength,
          ticket.mandate.requester,
          ticket.mandate.sourceId,
          toJson(ticket.mandate.matchedRules),
          ticket.mandate.via,
          ticket.origin.triggerId,
          toJson(ticket.origin.triggerIds),
          ticket.state,
          ticket.createdAt,
          end?.at ?? null,
          end?.by ?? null,
          end?.outcome ?? null,
          end?.reason ?? null,
        );
      },
      get(id) {
        const row = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as
          | Row
          | undefined;
        return row === undefined ? undefined : map(row);
      },
      list(state) {
        const rows =
          state === undefined
            ? (db.prepare("SELECT * FROM tickets").all() as Row[])
            : (db
                .prepare("SELECT * FROM tickets WHERE state = ?")
                .all(state) as Row[]);
        return rows.map(map);
      },
    };
  }

  private buildAssignments(): AssignmentRepository {
    const db = this.db;
    const map = (row: Row): Assignment => ({
      id: row["id"] as string,
      ticketId: row["ticket_id"] as string,
      workerId: row["worker_id"] as string,
      state: row["state"] as Assignment["state"],
      createdAt: Number(row["created_at"]),
      startedAt:
        row["started_at"] === null ? null : Number(row["started_at"]),
      endedAt: row["ended_at"] === null ? null : Number(row["ended_at"]),
      report:
        row["report_status"] === null
          ? null
          : {
              status: row["report_status"] as NonNullable<
                Assignment["report"]
              >["status"],
              text: row["report_text"] as string | null,
              question: row["report_question"] as string | null,
              at: Number(row["report_at"]),
            },
      artifacts: parseJson<string[]>(row["artifacts"] as string, []),
    });
    return {
      save(assignment) {
        const report = assignment.report;
        db.prepare(
          `INSERT INTO assignments
             (id, ticket_id, worker_id, state, created_at, started_at, ended_at,
              report_status, report_text, report_question, report_at, artifacts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ticket_id = excluded.ticket_id,
             worker_id = excluded.worker_id,
             state = excluded.state,
             created_at = excluded.created_at,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             report_status = excluded.report_status,
             report_text = excluded.report_text,
             report_question = excluded.report_question,
             report_at = excluded.report_at,
             artifacts = excluded.artifacts`,
        ).run(
          assignment.id,
          assignment.ticketId,
          assignment.workerId,
          assignment.state,
          assignment.createdAt,
          assignment.startedAt,
          assignment.endedAt,
          report?.status ?? null,
          report?.text ?? null,
          report?.question ?? null,
          report?.at ?? null,
          toJson(assignment.artifacts),
        );
      },
      get(id) {
        const row = db.prepare("SELECT * FROM assignments WHERE id = ?").get(
          id,
        ) as Row | undefined;
        return row === undefined ? undefined : map(row);
      },
      list(state) {
        const rows =
          state === undefined
            ? (db.prepare("SELECT * FROM assignments").all() as Row[])
            : (db
                .prepare("SELECT * FROM assignments WHERE state = ?")
                .all(state) as Row[]);
        return rows.map(map);
      },
      listByTicket(ticketId) {
        return (
          db
            .prepare("SELECT * FROM assignments WHERE ticket_id = ?")
            .all(ticketId) as Row[]
        ).map(map);
      },
      claim(id, startedAt) {
        const result = db
          .prepare(
            `UPDATE assignments SET state = 'running', started_at = ?
             WHERE id = ? AND state = 'pending'`,
          )
          .run(startedAt, id);
        if (Number(result.changes) !== 1) return undefined;
        const row = db
          .prepare("SELECT * FROM assignments WHERE id = ?")
          .get(id) as Row | undefined;
        return row === undefined ? undefined : map(row);
      },
    };
  }

  private buildDecisions(): DecisionRepository {
    const db = this.db;
    const map = (row: Row): Decision => ({
      id: row["id"] as string,
      triggerIds: parseJson<string[]>(row["trigger_ids"] as string, []),
      outcome: row["outcome"] as Decision["outcome"],
      strength: row["strength"] as Decision["strength"],
      reasons: parseJson<Decision["reasons"]>(row["reasons"] as string, []),
      decidedAt: Number(row["decided_at"]),
      decidedBy: row["decided_by"] as string,
    });
    return {
      save(decision) {
        db.prepare(
          `INSERT INTO decisions
             (id, trigger_ids, outcome, strength, reasons, decided_at, decided_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             trigger_ids = excluded.trigger_ids,
             outcome = excluded.outcome,
             strength = excluded.strength,
             reasons = excluded.reasons,
             decided_at = excluded.decided_at,
             decided_by = excluded.decided_by`,
        ).run(
          decision.id,
          toJson(decision.triggerIds),
          decision.outcome,
          decision.strength,
          toJson(decision.reasons),
          decision.decidedAt,
          decision.decidedBy,
        );
      },
      get(id) {
        const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(
          id,
        ) as Row | undefined;
        return row === undefined ? undefined : map(row);
      },
      list() {
        return (db.prepare("SELECT * FROM decisions").all() as Row[]).map(map);
      },
    };
  }

  private buildEvalQueue(): EvalQueueRepository {
    const db = this.db;
    return {
      enqueue(threadId, triggerId) {
        db.prepare(
          "INSERT OR IGNORE INTO eval_queue (thread_id, trigger_id) VALUES (?, ?)",
        ).run(threadId, triggerId);
      },
      pendingThreads() {
        return (
          db
            .prepare("SELECT DISTINCT thread_id FROM eval_queue")
            .all() as Row[]
        ).map((r) => r["thread_id"] as string);
      },
      takeThread(threadId) {
        const ids = (
          db
            .prepare(
              "SELECT trigger_id FROM eval_queue WHERE thread_id = ? ORDER BY rowid",
            )
            .all(threadId) as Row[]
        ).map((r) => r["trigger_id"] as string);
        db.prepare("DELETE FROM eval_queue WHERE thread_id = ?").run(threadId);
        return ids;
      },
    };
  }

  private buildSubscriptions(): SubscriptionRepository {
    const db = this.db;
    return {
      subscribe(ticketId, threadId) {
        db.prepare(
          "INSERT OR IGNORE INTO subscriptions (ticket_id, thread_id) VALUES (?, ?)",
        ).run(ticketId, threadId);
      },
      unsubscribe(ticketId, threadId) {
        db.prepare(
          "DELETE FROM subscriptions WHERE ticket_id = ? AND thread_id = ?",
        ).run(ticketId, threadId);
      },
      threadIdsFor(ticketId) {
        return (
          db
            .prepare("SELECT thread_id FROM subscriptions WHERE ticket_id = ?")
            .all(ticketId) as Row[]
        ).map((r) => r["thread_id"] as string);
      },
      openTicketIdsFor(threadIds) {
        if (threadIds.length === 0) return [];
        const placeholders = threadIds.map(() => "?").join(", ");
        return (
          db
            .prepare(
              `SELECT DISTINCT s.ticket_id AS ticket_id
               FROM subscriptions s
               JOIN tickets t ON t.id = s.ticket_id
               WHERE s.thread_id IN (${placeholders}) AND t.state = 'open'`,
            )
            .all(...threadIds) as Row[]
        ).map((r) => r["ticket_id"] as string);
      },
    };
  }
}
