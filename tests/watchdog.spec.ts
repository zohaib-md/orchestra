import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import { WorkerRuntime } from "../src/executor/runtime.ts";
import { Watchdog, classify } from "../src/executor/watchdog.ts";
import type { Assignment } from "../src/core/model.ts";
import type { WorkerResult } from "../src/executor/worker.ts";
import { makeInputs, makePolicy } from "./helpers.ts";

const HEARTBEAT = 100;
const PROGRESS = 50;
const DEADLINE = 200;

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

function setup(clock: { now: number }, maxRetries = 0) {
  const store = new Store(":memory:");
  const engine = new Engine(store, {
    policy: () => makePolicy(),
    now: () => clock.now,
    maxRetries,
  });
  const watchdog = new Watchdog(engine, {
    heartbeatTimeoutMs: HEARTBEAT,
    progressTimeoutMs: PROGRESS,
    deadlineMs: DEADLINE,
    now: () => clock.now,
  });
  return { store, engine, watchdog };
}

function seed(engine: Engine, count: number): void {
  for (const input of makeInputs(count)) engine.receive(input);
  engine.evaluateDue();
}

function readyResult(): WorkerResult {
  return {
    report: { status: "ready", text: "done", question: null, at: 0 },
    artifacts: ["out.json"],
  };
}

describe("classify", () => {
  function assignment(overrides: Partial<Assignment> = {}): Assignment {
    return {
      id: "a",
      ticketId: "t",
      workerId: "w",
      state: "running",
      createdAt: 0,
      startedAt: 0,
      endedAt: null,
      heartbeatAt: 0,
      progressAt: 0,
      report: null,
      artifacts: [],
      ...overrides,
    };
  }

  it("flags deadline exceeded first", () => {
    expect(
      classify(assignment({ startedAt: 0, heartbeatAt: DEADLINE - 1 }), DEADLINE + 1, {
        heartbeatTimeoutMs: HEARTBEAT,
        progressTimeoutMs: PROGRESS,
        deadlineMs: DEADLINE,
      }),
    ).toEqual({ kind: "deadline", reason: "execution deadline exceeded" });
  });

  it("flags no heartbeat as crashed", () => {
    expect(
      classify(assignment({ startedAt: 0, heartbeatAt: 0 }), HEARTBEAT + 1, {
        heartbeatTimeoutMs: HEARTBEAT,
        progressTimeoutMs: PROGRESS,
        deadlineMs: 1000,
      }),
    ).toEqual({ kind: "crashed", reason: "no heartbeat" });
  });

  it("flags fresh heartbeat but stale progress as stalled", () => {
    expect(
      classify(assignment({ heartbeatAt: 30, progressAt: 0 }), 30 + PROGRESS + 1, {
        heartbeatTimeoutMs: HEARTBEAT,
        progressTimeoutMs: PROGRESS,
        deadlineMs: 1000,
      }),
    ).toEqual({ kind: "stalled", reason: "alive but no progress" });
  });

  it("reports ok when all signals are fresh", () => {
    expect(
      classify(assignment({ heartbeatAt: 10, progressAt: 10 }), 20, {
        heartbeatTimeoutMs: HEARTBEAT,
        progressTimeoutMs: PROGRESS,
        deadlineMs: 1000,
      }),
    ).toBe("ok");
  });
});

describe("watchdog", () => {
  it("recovers a worker with no heartbeat (crashed)", () => {
    const clock = { now: 0 };
    const { store, engine, watchdog } = setup(clock);
    seed(engine, 1);
    const a = store.assignments.list("pending")[0]!;
    engine.claim(a.id);

    clock.now = HEARTBEAT + 1;
    expect(watchdog.tick().crashed).toBe(1);

    expect(store.assignments.get(a.id)?.state).toBe("ended");
    expect(store.assignments.get(a.id)?.report?.status).toBe("failed");
    expect(store.assignments.get(a.id)?.report?.text).toBe("no heartbeat");
  });

  it("detects a live worker that is not progressing (stalled)", () => {
    const clock = { now: 0 };
    const { store, engine, watchdog } = setup(clock);
    seed(engine, 1);
    const a = store.assignments.list("pending")[0]!;
    engine.claim(a.id); // startedAt = heartbeatAt = progressAt = 0

    clock.now = 30;
    engine.heartbeat(a.id); // worker is alive at t=30
    clock.now = 30 + PROGRESS + 1;
    expect(watchdog.tick().stalled).toBe(1);

    expect(store.assignments.get(a.id)?.report?.text).toBe("alive but no progress");
  });

  it("never recovers a waiting or blocked assignment", async () => {
    const clock = { now: 0 };
    const { store, engine, watchdog } = setup(clock);
    seed(engine, 1);

    const runtime = new WorkerRuntime(engine, {
      worker: {
        async run() {
          return {
            report: {
              status: "waiting",
              text: "awaiting approval",
              question: "approve?",
              at: clock.now,
            },
            artifacts: [],
          };
        },
      },
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    await runtime.runAll();
    expect(store.assignments.list("waiting")).toHaveLength(1);

    clock.now = 1_000_000; // way past every threshold
    expect(watchdog.tick()).toEqual({ crashed: 0, stalled: 0, deadline: 0 });
    expect(store.assignments.list("waiting")).toHaveLength(1);
  });

  it("recovers a worker that exceeded its deadline", () => {
    const clock = { now: 0 };
    const { store, engine, watchdog } = setup(clock);
    seed(engine, 1);
    const a = store.assignments.list("pending")[0]!;
    engine.claim(a.id);

    clock.now = DEADLINE + 1;
    expect(watchdog.tick().deadline).toBe(1);
    expect(store.assignments.get(a.id)?.report?.text).toBe(
      "execution deadline exceeded",
    );
  });

  it("retries delivery of a completed result without re-executing", () => {
    const clock = { now: 0 };
    const { store, engine } = setup(clock);
    seed(engine, 1);
    const a = store.assignments.list("pending")[0]!;

    engine.claim(a.id);
    engine.complete(a.id, readyResult().report, ["out.json"]);
    expect(store.assignments.get(a.id)?.state).toBe("completed");

    // Simulate a crash before delivery, then recover delivery only.
    const delivered = engine.deliverCompleted();
    expect(delivered).toBe(1);
    expect(store.assignments.get(a.id)?.state).toBe("ended");
    expect(store.assignments.get(a.id)?.report?.status).toBe("ready");
    expect(store.assignments.get(a.id)?.artifacts).toEqual(["out.json"]);
    // No replacement assignment was created: the work was not re-executed.
    expect(store.assignments.listByTicket(a.ticketId)).toHaveLength(1);
  });

  it("does not recover the same assignment twice", () => {
    const clock = { now: 0 };
    const { store, engine, watchdog } = setup(clock);
    seed(engine, 1);
    const a = store.assignments.list("pending")[0]!;
    engine.claim(a.id);

    clock.now = DEADLINE + 1;
    expect(watchdog.tick().deadline).toBe(1);
    expect(watchdog.tick()).toEqual({ crashed: 0, stalled: 0, deadline: 0 });
  });
});

describe("restart with persisted heartbeat state", () => {
  it("persists heartbeat/progress and recovers on restart", () => {
    const clock = { now: 0 };
    const path = tempStorePath();

    const storeA = new Store(path);
    const engineA = new Engine(storeA, {
      policy: () => makePolicy(),
      now: () => clock.now,
    });
    seed(engineA, 1);
    const a = storeA.assignments.list("pending")[0]!;
    engineA.claim(a.id);
    clock.now = 40;
    engineA.heartbeat(a.id);
    engineA.progress(a.id);
    storeA.close();

    const storeB = new Store(path);
    const persisted = storeB.assignments.get(a.id)!;
    expect(persisted.heartbeatAt).toBe(40);
    expect(persisted.progressAt).toBe(40);
    expect(persisted.state).toBe("running");

    const engineB = new Engine(storeB, {
      policy: () => makePolicy(),
      now: () => clock.now,
    });
    const runtimeB = new WorkerRuntime(engineB, {
      worker: { async run() { return readyResult(); } },
      maxWorkers: 1,
      workRoot: "/tmp/orchestra-work",
    });
    const { recovered } = runtimeB.start();
    expect(recovered).toBe(1);
    storeB.close();
  });
});
