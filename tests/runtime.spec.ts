import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import { WorkerRuntime } from "../src/executor/runtime.ts";
import type { Worker, WorkerResult } from "../src/executor/worker.ts";
import { makeInputs, makePolicy } from "./helpers.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function tempStorePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orchestra-"));
  temps.push(dir);
  return path.join(dir, "state.db");
}

function setup(path = ":memory:", maxRetries = 0) {
  const store = new Store(path);
  const engine = new Engine(store, { policy: () => makePolicy(), maxRetries });
  return { store, engine };
}

async function seed(engine: Engine, count: number): Promise<void> {
  for (const input of makeInputs(count)) engine.receive(input);
  await engine.evaluateDue();
}

function okResult(text = "done"): WorkerResult {
  return {
    report: { status: "ready", text, question: null, at: Date.now() },
    artifacts: ["result.json"],
  };
}

const successWorker: Worker = { async run() { return okResult(); } };

describe("worker runtime", () => {
  it("runs the full definition-of-done demonstration", async () => {
    const { store, engine } = setup(":memory:", 1);
    await seed(engine, 3);

    // 1. three authorized tickets with pending dispatch intents
    expect(store.tickets.list("open")).toHaveLength(3);
    expect(store.assignments.list("pending")).toHaveLength(3);

    // 2-3. dispatch to isolated workers, concurrently within a limit of 2
    const failingTicketId = store.tickets.list()[1]!.id;
    const attempts = new Map<string, number>();
    const flakyWorker: Worker = {
      async run(ctx) {
        const n = (attempts.get(ctx.ticket.id) ?? 0) + 1;
        attempts.set(ctx.ticket.id, n);
        if (ctx.ticket.id === failingTicketId && n === 1) {
          throw new Error("worker crashed");
        }
        return okResult();
      },
    };

    const runtime = new WorkerRuntime(engine, {
      worker: flakyWorker,
      maxWorkers: 2,
      workRoot: "/tmp/orchestra-work",
    });

    const summary = await runtime.runAll();

    // 5-7. one failure, ticket preserved, replacement worker succeeded
    expect(summary).toEqual({ completed: 3, failed: 1, replaced: 1 });

    // 4. results persisted
    expect(store.assignments.list()).toHaveLength(4); // 3 initial + 1 replacement
    const failingAssignments = store.assignments.listByTicket(failingTicketId);
    expect(failingAssignments).toHaveLength(2);
    expect(failingAssignments[0]?.report?.status).toBe("failed");
    expect(failingAssignments[1]?.report?.status).toBe("ready");
    expect(failingAssignments[1]?.artifacts).toEqual(["result.json"]);

    // 6. the original ticket is preserved and still open
    expect(store.tickets.get(failingTicketId)?.state).toBe("open");
  });

  it("enforces the concurrency limit", async () => {
    const { store, engine } = setup();
    await seed(engine, 4);

    let inFlight = 0;
    let maxSeen = 0;
    const trackingWorker: Worker = {
      async run() {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return okResult();
      },
    };

    const runtime = new WorkerRuntime(engine, {
      worker: trackingWorker,
      maxWorkers: 2,
      workRoot: "/tmp/orchestra-work",
    });
    await runtime.runAll();

    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(maxSeen).toBeGreaterThanOrEqual(2); // concurrency actually happened
    expect(store.assignments.list("pending")).toHaveLength(0);
  });

  it("queues work beyond the limit and completes it all", async () => {
    const { store, engine } = setup();
    await seed(engine, 3);
    const runtime = new WorkerRuntime(engine, {
      worker: successWorker,
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    const summary = await runtime.runAll();
    expect(summary.completed).toBe(3);
    expect(store.assignments.list("pending")).toHaveLength(0);
  });

  it("never runs a completed assignment again (no duplicate side effects)", async () => {
    const { store, engine } = setup();
    await seed(engine, 2);
    let sideEffects = 0;
    const worker: Worker = {
      async run() {
        sideEffects++;
        return okResult();
      },
    };
    const runtime = new WorkerRuntime(engine, {
      worker,
      maxWorkers: 2,
      workRoot: "/tmp/orchestra-work",
    });
    await runtime.runAll();
    expect(sideEffects).toBe(2);

    // A fresh runtime over the same state must not re-run completed work.
    const second = new WorkerRuntime(engine, {
      worker,
      maxWorkers: 2,
      workRoot: "/tmp/orchestra-work",
    });
    await second.runAll();
    expect(sideEffects).toBe(2);
  });

  it("claims an assignment at most once (duplicate dispatch delivery)", async () => {
    const { store, engine } = setup();
    await seed(engine, 1);
    const assignment = store.assignments.list("pending")[0]!;

    const claimed = engine.claim(assignment.id);
    expect(claimed?.state).toBe("running");

    // A second claim of the same assignment is refused.
    expect(engine.claim(assignment.id)).toBeUndefined();
    expect(store.assignments.get(assignment.id)?.state).toBe("running");
  });

  it("records a failed assignment and creates a replacement (retry policy)", async () => {
    const { store, engine } = setup(":memory:", 1);
    await seed(engine, 1);
    const ticketId = store.tickets.list()[0]!.id;

    const runtime = new WorkerRuntime(engine, {
      worker: { async run() { throw new Error("boom"); } },
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    const summary = await runtime.runAll();

    expect(summary.failed).toBe(2); // initial + replacement both failed
    expect(summary.replaced).toBe(1);
    const assignments = store.assignments.listByTicket(ticketId);
    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.report?.status === "failed")).toBe(true);
    expect(store.tickets.get(ticketId)?.state).toBe("open"); // preserved
  });

  it("does not retry beyond the configured limit", async () => {
    const { store, engine } = setup();
    await seed(engine, 1);
    const ticketId = store.tickets.list()[0]!.id;

    const runtime = new WorkerRuntime(engine, {
      worker: { async run() { throw new Error("boom"); } },
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    await runtime.runAll();
    expect(store.assignments.listByTicket(ticketId)).toHaveLength(1);
  });
});

describe("persistence and restart", () => {
  it("persists execution state across a reopen", async () => {
    const path = tempStorePath();
    const first = setup(path);
    await seed(first.engine, 2);

    const runtime = new WorkerRuntime(first.engine, {
      worker: successWorker,
      maxWorkers: 2,
      workRoot: "/tmp/orchestra-work",
    });
    await runtime.runAll();
    first.store.close();

    const second = new Store(path);
    expect(second.assignments.list()).toHaveLength(2);
    expect(second.assignments.list("running")).toHaveLength(0);
    expect(second.assignments.list().every((a) => a.report?.status === "ready")).toBe(
      true,
    );
    expect(second.assignments.list().every((a) => a.artifacts[0] === "result.json")).toBe(
      true,
    );
    second.close();
  });

  it("recovers an interrupted running assignment on restart", async () => {
    const path = tempStorePath();

    // First process: claim the assignment with a hanging worker, then die.
    const first = setup(path);
    await seed(first.engine, 1);
    const ticketId = first.store.tickets.list()[0]!.id;

    const hangingWorker: Worker = {
      run() {
        return new Promise(() => {}); // never resolves
      },
    };
    const firstRuntime = new WorkerRuntime(first.engine, {
      worker: hangingWorker,
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    firstRuntime.runAll(); // not awaited: claims, then hangs

    expect(first.store.assignments.list("running")).toHaveLength(1);
    first.store.close();

    // Second process recovers.
    const second = setup(path);
    expect(second.store.assignments.list("running")).toHaveLength(1);

    const secondRuntime = new WorkerRuntime(second.engine, {
      worker: successWorker,
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    const { recovered } = secondRuntime.start();
    expect(recovered).toBe(1);

    await secondRuntime.runAll();

    const assignments = second.store.assignments.listByTicket(ticketId);
    expect(assignments).toHaveLength(2);
    expect(assignments[0]?.report?.status).toBe("failed"); // host interrupted
    expect(assignments[1]?.report?.status).toBe("ready"); // replacement
    expect(second.store.tickets.get(ticketId)?.state).toBe("open");
    second.store.close();
  });
});
