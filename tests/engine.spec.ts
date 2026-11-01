import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import type { Assessor } from "../src/core/assessor.ts";
import { makeInput, makePolicy, SOURCE } from "./helpers.ts";

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => {
  store.close();
});

function engine(overrides: { assessor?: Assessor } = {}) {
  return new Engine(store, { policy: () => makePolicy(), ...overrides });
}

describe("receive", () => {
  it("stores a trigger, creates its thread and queues it for eval", () => {
    const result = engine().receive(makeInput());
    expect(result).toBe("stored");
    expect(store.triggers.byExternalId(SOURCE, "evt-1")).toBeDefined();
    expect(store.threads.get("thread-1")).toBeDefined();
    expect(store.evalQueue.pendingThreads()).toEqual(["thread-1"]);
  });

  it("synthesizes a thread when none is supplied", () => {
    engine().receive(makeInput({ threadIds: [] }));
    const trigger = store.triggers.byExternalId(SOURCE, "evt-1");
    expect(trigger?.threadIds).toHaveLength(1);
    expect(store.evalQueue.pendingThreads()).toHaveLength(1);
  });

  it("is idempotent: a duplicate delivery returns 'duplicate' and creates one trigger", () => {
    const e = engine();
    expect(e.receive(makeInput())).toBe("stored");
    expect(e.receive(makeInput())).toBe("duplicate");
    expect(store.triggers.listBySource(SOURCE)).toHaveLength(1);
  });
});

describe("evaluateDue", () => {
  it("accepts an explicit request: ticket, mandate, assignment and subscription", () => {
    const e = engine();
    e.receive(makeInput());
    e.evaluateDue();

    const tickets = store.tickets.list();
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket?.state).toBe("open");
    expect(ticket?.mandate.strength).toBe("explicit");
    expect(ticket?.mandate.requester).toBe("alice");
    expect(ticket?.mandate.matchedRules).toEqual(["fix"]);

    const assignments = store.assignments.listByTicket(ticket!.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.state).toBe("pending");
    expect(assignments[0]?.workerId).toBe(`worker-${ticket!.id}`);

    expect(store.subscriptions.threadIdsFor(ticket!.id)).toEqual(["thread-1"]);

    const decision = store.decisions.list()[0];
    expect(decision?.outcome).toBe("accept");
  });

  it("ignores a trigger from an unknown actor", () => {
    const e = engine();
    e.receive(makeInput({ actor: "mallory" }));
    e.evaluateDue();
    expect(store.tickets.list()).toHaveLength(0);
    expect(store.decisions.list()[0]?.outcome).toBe("ignore");
  });

  it("accepts a bot candidate only when a rule matches its kind", () => {
    const e = engine();
    e.receive(makeInput({ actor: "ci-bot", kind: "issue" }));
    e.evaluateDue();
    expect(store.tickets.list()).toHaveLength(1);
    expect(store.tickets.list()[0]?.mandate.strength).toBe("inferred");
  });

  it("ignores a bot candidate with no matching rule", () => {
    const e = engine();
    e.receive(makeInput({ actor: "ci-bot", kind: "push" }));
    e.evaluateDue();
    expect(store.tickets.list()).toHaveLength(0);
  });

  it("records the trigger disposition for audit", () => {
    const e = engine();
    e.receive(makeInput());
    e.evaluateDue();
    const trigger = store.triggers.byExternalId(SOURCE, "evt-1");
    expect(trigger?.disposition?.kind).toBe("evaluated");
  });
});

describe("subscription-aware routing", () => {
  it("does not create a new ticket for a person's follow-up on a subscribed thread", () => {
    const e = engine();
    e.receive(makeInput());
    e.evaluateDue();
    expect(store.tickets.list()).toHaveLength(1);

    // Alice replies on the same thread.
    e.receive(makeInput({ externalId: "evt-2", kind: "comment" }));
    e.evaluateDue();

    expect(store.tickets.list()).toHaveLength(1);
    const followUp = store.triggers.byExternalId(SOURCE, "evt-2");
    expect(followUp?.disposition?.kind).toBe("fannedOut");
    // It was not queued for eval.
    expect(store.evalQueue.pendingThreads()).toHaveLength(0);
  });

  it("still evaluates a bot message on a subscribed thread", () => {
    const e = engine();
    e.receive(makeInput());
    e.evaluateDue();

    e.receive(makeInput({ externalId: "evt-2", actor: "ci-bot", kind: "push" }));
    expect(store.evalQueue.pendingThreads()).toContain("thread-1");
  });
});

describe("transactional consistency", () => {
  it("rolls back the whole eval when the assessor throws", () => {
    const throwingAssessor: Assessor = {
      assess() {
        throw new Error("assessor exploded");
      },
    };
    const e = engine({ assessor: throwingAssessor });
    e.receive(makeInput());
    expect(() => e.evaluateDue()).toThrow("assessor exploded");

    // Queue retained, nothing written.
    expect(store.evalQueue.pendingThreads()).toEqual(["thread-1"]);
    expect(store.decisions.list()).toHaveLength(0);
    expect(store.tickets.list()).toHaveLength(0);
    expect(store.triggers.byExternalId(SOURCE, "evt-1")?.disposition).toBeNull();
  });
});

describe("stopTicket", () => {
  it("ends an open ticket", () => {
    const e = engine();
    e.receive(makeInput());
    e.evaluateDue();
    const ticketId = store.tickets.list()[0]!.id;

    e.stopTicket(ticketId, "no longer needed");
    const ticket = store.tickets.get(ticketId);
    expect(ticket?.state).toBe("ended");
    expect(ticket?.end?.outcome).toBe("closed");
    expect(ticket?.end?.reason).toBe("no longer needed");
  });

  it("refuses to stop a missing or already-ended ticket", () => {
    const e = engine();
    expect(() => e.stopTicket("nope")).toThrow();
    e.receive(makeInput());
    e.evaluateDue();
    const ticketId = store.tickets.list()[0]!.id;
    e.stopTicket(ticketId);
    expect(() => e.stopTicket(ticketId)).toThrow();
  });
});
