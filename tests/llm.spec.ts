import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import { LlmAssessor } from "../src/llm/assessor.ts";
import { LlmWorker } from "../src/llm/worker.ts";
import type { ModelClient } from "../src/llm/model.ts";
import { WorkerRuntime } from "../src/executor/runtime.ts";
import type { WorkerContext } from "../src/executor/worker.ts";
import type { AssessmentInput } from "../src/core/assessor.ts";
import type { Assignment, Ticket, Trigger } from "../src/core/model.ts";
import { makeInputs, makePolicy, SOURCE } from "./helpers.ts";

class FakeModelClient implements ModelClient {
  private readonly queue: Array<string | Error> = [];
  readonly prompts: string[] = [];

  respond(...responses: Array<string | Error>): void {
    this.queue.push(...responses);
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("unexpected model call");
    if (next instanceof Error) throw next;
    return next;
  }
}

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function makeStore(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}

function assessmentInput(): AssessmentInput {
  const trigger: Trigger = {
    id: "t1",
    sourceId: SOURCE,
    externalId: "e1",
    actor: "alice",
    kind: "issue",
    payload: "{}",
    createdAt: 0,
    threadIds: ["thread-1"],
    disposition: null,
  };
  return {
    trigger,
    batch: [trigger],
    thread: { id: "thread-1", sourceId: SOURCE, label: null, meta: {} },
    tickets: [],
    policy: makePolicy(),
    gate: { admitted: true, strength: "explicit", basis: "addressed", actorKind: "person" },
  };
}

function fakeTicket(): Ticket {
  return {
    id: "ticket-1",
    mandate: {
      policyVersion: "v1",
      scope: "fix the bug",
      strength: "explicit",
      requester: "alice",
      sourceId: SOURCE,
      matchedRules: [],
      via: "addressed",
    },
    origin: { triggerId: "t1", triggerIds: ["t1"] },
    state: "open",
    createdAt: 0,
    end: null,
  };
}

function fakeAssignment(): Assignment {
  return {
    id: "assignment-1",
    ticketId: "ticket-1",
    workerId: "worker-ticket-1",
    state: "running",
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    heartbeatAt: 0,
    progressAt: 0,
    report: null,
    artifacts: [],
  };
}

describe("LlmAssessor", () => {
  it("accepts when the model returns an accept decision", async () => {
    const client = new FakeModelClient();
    client.respond(JSON.stringify({ outcome: "accept", rule: "fix", scope: "fix the bug" }));
    const result = await new LlmAssessor(client).assess(assessmentInput());
    expect(result).toMatchObject({ outcome: "accept", ruleId: "fix", scope: "fix the bug" });
  });

  it("ignores when the model returns an ignore decision", async () => {
    const client = new FakeModelClient();
    client.respond(JSON.stringify({ outcome: "ignore" }));
    const result = await new LlmAssessor(client).assess(assessmentInput());
    expect(result.outcome).toBe("ignore");
  });

  it("returns unavailable when the model errors", async () => {
    const client = new FakeModelClient();
    client.respond(new Error("network down"));
    const result = await new LlmAssessor(client).assess(assessmentInput());
    expect(result).toMatchObject({ outcome: "unavailable", reasonCode: "model_error" });
  });

  it("returns unavailable when the model output is invalid", async () => {
    const client = new FakeModelClient();
    client.respond("not json at all");
    const result = await new LlmAssessor(client).assess(assessmentInput());
    expect(result.outcome).toBe("unavailable");
  });
});

describe("LLM-powered evaluation via the Router", () => {
  it("accepts a request and records the model's scope", async () => {
    const client = new FakeModelClient();
    client.respond(JSON.stringify({ outcome: "accept", rule: "fix", scope: "fix the bug" }));
    const store = makeStore();
    const engine = new Engine(store, {
      policy: () => makePolicy(),
      assessor: new LlmAssessor(client),
    });

    engine.receive(makeInputs(1)[0]!);
    await engine.evaluateDue();

    const ticket = store.tickets.list()[0];
    expect(ticket?.mandate.scope).toBe("fix the bug");
    expect(ticket?.mandate.matchedRules).toEqual(["fix"]);
    expect(store.decisions.list()[0]?.outcome).toBe("accept");
  });

  it("requeues the batch on a transient model error, then accepts on retry", async () => {
    const client = new FakeModelClient();
    client.respond(new Error("network down"), JSON.stringify({ outcome: "accept", rule: "fix" }));
    const store = makeStore();
    const engine = new Engine(store, {
      policy: () => makePolicy(),
      assessor: new LlmAssessor(client),
    });

    engine.receive(makeInputs(1)[0]!);
    await engine.evaluateDue();
    expect(store.decisions.list()[0]?.outcome).toBe("unavailable");
    expect(store.tickets.list()).toHaveLength(0);
    expect(store.evalQueue.pendingThreads()).toHaveLength(1);

    await engine.evaluateDue();
    expect(store.tickets.list()).toHaveLength(1);
  });

  it("drops a batch after the requeue limit is exhausted", async () => {
    const client = new FakeModelClient();
    client.respond(new Error("down"), new Error("down"), new Error("down"));
    const store = makeStore();
    const engine = new Engine(store, {
      policy: () => makePolicy(),
      assessor: new LlmAssessor(client),
    });

    engine.receive(makeInputs(1)[0]!);
    await engine.evaluateDue();
    await engine.evaluateDue();
    await engine.evaluateDue();

    expect(store.evalQueue.pendingThreads()).toHaveLength(0); // dropped, not requeued forever
    expect(store.decisions.list().every((d) => d.outcome === "unavailable")).toBe(true);
    expect(store.tickets.list()).toHaveLength(0);
  });
});

describe("LlmWorker", () => {
  it("executes via the model and emits heartbeat and progress", async () => {
    const client = new FakeModelClient();
    client.respond("fixed the bug");
    let heartbeats = 0;
    let progresses = 0;
    const ctx: WorkerContext = {
      ticket: fakeTicket(),
      assignment: fakeAssignment(),
      workDir: "/tmp/orchestra-work",
      inputs: ["{}"],
      signals: {
        heartbeat: () => heartbeats++,
        progress: () => progresses++,
      },
    };

    const result = await new LlmWorker(client).run(ctx);
    expect(heartbeats).toBe(1);
    expect(progresses).toBe(2);
    expect(result.report.status).toBe("ready");
    expect(result.report.text).toBe("fixed the bug");
    expect(result.artifacts).toEqual(["result.txt"]);
  });

  it("fails the assignment and retries on a model error", async () => {
    const client = new FakeModelClient();
    client.respond(new Error("model down"), "fixed after retry");
    const store = makeStore();
    const engine = new Engine(store, { policy: () => makePolicy(), maxRetries: 1 });
    for (const input of makeInputs(1)) engine.receive(input);
    await engine.evaluateDue();
    const ticketId = store.tickets.list()[0]!.id;

    const runtime = new WorkerRuntime(engine, {
      worker: new LlmWorker(client),
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    const summary = await runtime.runAll();

    expect(summary).toEqual({ completed: 1, failed: 1, replaced: 1 });
    const assignments = store.assignments.listByTicket(ticketId);
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.report?.status).toBe("failed");
    expect(assignments[1]?.report?.status).toBe("ready");
    expect(assignments[1]?.report?.text).toBe("fixed after retry");
    expect(store.tickets.get(ticketId)?.state).toBe("open");
  });
});
