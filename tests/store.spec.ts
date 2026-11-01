import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import type {
  Assignment,
  Decision,
  Source,
  Thread,
  Ticket,
  Trigger,
} from "../src/core/model.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => {
  store.close();
});

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: "source:gh:owner/repo",
    kind: "github",
    readPosition: null,
    state: "running",
    ...overrides,
  };
}

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: "t1",
    sourceId: "source:gh:owner/repo",
    externalId: "issue-1",
    actor: "alice",
    kind: "issue",
    payload: JSON.stringify({ title: "Fix the bug" }),
    createdAt: 1_700_000_000_000,
    threadIds: ["thread-1"],
    disposition: null,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sourceId: "source:gh:owner/repo",
    label: "Issue #1",
    meta: {},
    ...overrides,
  };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-1",
    mandate: {
      policyVersion: "v1",
      scope: "fix the bug",
      strength: "explicit",
      requester: "alice",
      sourceId: "source:gh:owner/repo",
      matchedRules: ["fix-requests"],
      via: "addressed",
    },
    origin: { triggerId: "t1", triggerIds: ["t1"] },
    state: "open",
    createdAt: 1_700_000_000_000,
    end: null,
    ...overrides,
  };
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "assignment-1",
    ticketId: "ticket-1",
    workerId: "worker-ticket-1",
    state: "pending",
    createdAt: 1_700_000_000_000,
    startedAt: null,
    endedAt: null,
    report: null,
    artifacts: [],
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "decision-1",
    triggerIds: ["t1"],
    outcome: "accept",
    strength: "explicit",
    reasons: [{ code: "addressed", values: {} }],
    decidedAt: 1_700_000_000_000,
    decidedBy: "router",
    ...overrides,
  };
}

describe("sources", () => {
  it("round-trips", () => {
    store.sources.save(source());
    expect(store.sources.get("source:gh:owner/repo")).toEqual(source());
  });

  it("updates the read position independently", () => {
    store.sources.save(source());
    store.sources.setReadPosition("source:gh:owner/repo", "cursor-42");
    expect(store.sources.get("source:gh:owner/repo")?.readPosition).toBe(
      "cursor-42",
    );
  });

  it("lists all sources", () => {
    store.sources.save(source());
    store.sources.save(source({ id: "s2", kind: "webhook" }));
    expect(store.sources.list()).toHaveLength(2);
  });
});

describe("triggers", () => {
  it("round-trips with thread ids", () => {
    store.triggers.save(trigger());
    expect(store.triggers.get("t1")).toEqual(trigger());
  });

  it("is idempotent: the same external event maps to one row", () => {
    store.triggers.save(trigger());
    store.triggers.save(trigger({ disposition: { kind: "filtered", code: "x", at: 1 } }));
    expect(store.triggers.listBySource("source:gh:owner/repo")).toHaveLength(1);
    expect(store.triggers.get("t1")?.disposition?.kind).toBe("filtered");
  });

  it("finds by external id for deduplication", () => {
    store.triggers.save(trigger());
    const found = store.triggers.byExternalId("source:gh:owner/repo", "issue-1");
    expect(found?.id).toBe("t1");
    expect(
      store.triggers.byExternalId("source:gh:owner/repo", "issue-2"),
    ).toBeUndefined();
  });

  it("lists triggers by thread", () => {
    store.triggers.save(trigger());
    store.triggers.save(
      trigger({
        id: "t2",
        externalId: "comment-1",
        kind: "comment",
        threadIds: ["thread-2"],
      }),
    );
    expect(store.triggers.listByThread("thread-1").map((t) => t.id)).toEqual([
      "t1",
    ]);
    expect(store.triggers.listByThread("thread-2").map((t) => t.id)).toEqual([
      "t2",
    ]);
  });
});

describe("threads", () => {
  it("round-trips meta", () => {
    store.threads.save(thread({ meta: { number: 1, labels: ["bug"] } }));
    expect(store.threads.get("thread-1")).toEqual(
      thread({ meta: { number: 1, labels: ["bug"] } }),
    );
  });

  it("lists by source", () => {
    store.threads.save(thread());
    store.threads.save(thread({ id: "thread-2", label: "PR #2" }));
    expect(store.threads.listBySource("source:gh:owner/repo")).toHaveLength(2);
  });
});

describe("tickets", () => {
  it("round-trips an open ticket", () => {
    store.tickets.save(ticket());
    expect(store.tickets.get("ticket-1")).toEqual(ticket());
  });

  it("round-trips an ended ticket", () => {
    store.tickets.save(
      ticket({
        state: "ended",
        end: {
          at: 1_700_000_001_000,
          by: "alice",
          outcome: "merged",
          reason: "pr merged",
        },
      }),
    );
    expect(store.tickets.get("ticket-1")?.state).toBe("ended");
    expect(store.tickets.get("ticket-1")?.end?.outcome).toBe("merged");
  });

  it("lists by state", () => {
    store.tickets.save(ticket());
    store.tickets.save(ticket({ id: "ticket-2", state: "ended", end: null }));
    expect(store.tickets.list("open")).toHaveLength(1);
    expect(store.tickets.list()).toHaveLength(2);
  });
});

describe("assignments", () => {
  it("round-trips a pending assignment", () => {
    store.assignments.save(assignment());
    expect(store.assignments.get("assignment-1")).toEqual(assignment());
  });

  it("round-trips a report", () => {
    store.assignments.save(
      assignment({
        state: "running",
        startedAt: 1_700_000_000_500,
        report: {
          status: "ready",
          text: "opened a PR",
          question: null,
          at: 1_700_000_001_000,
        },
      }),
    );
    const got = store.assignments.get("assignment-1");
    expect(got?.report?.status).toBe("ready");
    expect(got?.report?.text).toBe("opened a PR");
  });

  it("lists by ticket", () => {
    store.assignments.save(assignment());
    store.assignments.save(
      assignment({ id: "assignment-2", ticketId: "ticket-2", workerId: "w2" }),
    );
    expect(store.assignments.listByTicket("ticket-1")).toHaveLength(1);
  });
});

describe("decisions", () => {
  it("round-trips", () => {
    store.decisions.save(decision());
    expect(store.decisions.get("decision-1")).toEqual(decision());
  });
});

describe("atomic", () => {
  it("commits on success", () => {
    store.atomic(() => {
      store.sources.save(source());
    });
    expect(store.sources.get("source:gh:owner/repo")).toBeDefined();
  });

  it("rolls back on throw", () => {
    expect(() =>
      store.atomic(() => {
        store.sources.save(source());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.sources.get("source:gh:owner/repo")).toBeUndefined();
  });
});
