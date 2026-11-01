import path from "node:path";
import type { Engine } from "../core/engine.ts";
import type { Assignment, Report } from "../core/model.ts";
import type { Worker, WorkerContext, WorkerResult, WorkerSignals } from "./worker.ts";

export interface WorkerRuntimeOptions {
  worker: Worker;
  /** Maximum number of concurrent workers. */
  maxWorkers: number;
  /** Root directory for per-ticket working directories. */
  workRoot: string;
  now?: () => number;
}

export interface RunSummary {
  completed: number;
  failed: number;
  replaced: number;
}

/**
 * Consumes pending dispatch intents (pending Assignments) and executes them
 * through independent Workers, up to a concurrency limit. It never authorizes
 * work and never mutates domain state directly; all transitions go through
 * the Engine.
 */
export class WorkerRuntime {
  private readonly worker: Worker;
  private readonly maxWorkers: number;
  private readonly workRoot: string;
  private readonly now: () => number;
  private active = 0;
  private stopped = false;

  constructor(
    private readonly engine: Engine,
    options: WorkerRuntimeOptions,
  ) {
    this.worker = options.worker;
    this.maxWorkers = options.maxWorkers;
    this.workRoot = options.workRoot;
    this.now = options.now ?? (() => Date.now());
  }

  /** Recover interrupted executions and deliver stranded results. */
  start(): { recovered: number; delivered: number } {
    return {
      recovered: this.engine.recoverInterrupted(),
      delivered: this.engine.deliverCompleted(),
    };
  }

  stop(): void {
    this.stopped = true;
  }

  /** Dispatch pending work up to the concurrency limit, waiting for it to settle. */
  async runAll(): Promise<RunSummary> {
    const summary: RunSummary = { completed: 0, failed: 0, replaced: 0 };
    while (!this.stopped) {
      const claimed = this.claimBatch();
      if (claimed.length === 0) break;
      const results = await Promise.all(claimed.map((a) => this.execute(a)));
      for (const result of results) {
        if (result.status === "completed") summary.completed++;
        else summary.failed++;
        if (result.replaced) summary.replaced++;
      }
    }
    return summary;
  }

  private claimBatch(): Assignment[] {
    const claimed: Assignment[] = [];
    while (this.active < this.maxWorkers) {
      const next = this.engine.pendingAssignments()[0];
      if (next === undefined) break;
      const running = this.engine.claim(next.id);
      if (running === undefined) continue; // lost a race; try the next one
      claimed.push(running);
      this.active++;
    }
    return claimed;
  }

  private async execute(
    assignment: Assignment,
  ): Promise<{ status: "completed" | "failed"; replaced: boolean }> {
    try {
      let result: WorkerResult;
      try {
        result = await this.runWorker(assignment);
      } catch (err) {
        // Worker crashed. Re-execution is safe: the work never completed.
        this.engine.fail(assignment.id, {
          status: "failed",
          text: err instanceof Error ? err.message : String(err),
          question: null,
          at: this.now(),
        });
        const replacement = this.engine.replaceAssignment(assignment.ticketId);
        return { status: "failed", replaced: replacement !== undefined };
      }

      const report = result.report;
      if (report.status === "waiting" || report.status === "blocked") {
        this.engine.wait(assignment.id, report);
        return { status: "completed", replaced: false };
      }
      // Persist the result durably before finalizing.
      this.engine.complete(assignment.id, report, result.artifacts);
      this.engine.deliver(assignment.id);
      return { status: "completed", replaced: false };
    } finally {
      this.active--;
    }
  }

  private async runWorker(assignment: Assignment): Promise<WorkerResult> {
    const ticket = this.engine.getTicket(assignment.ticketId);
    if (ticket === undefined) {
      throw new Error(`ticket ${assignment.ticketId} not found`);
    }
    const inputs = ticket.origin.triggerIds
      .map((id) => this.engine.getTrigger(id)?.payload)
      .filter((payload): payload is string => payload !== undefined);
    const signals: WorkerSignals = {
      heartbeat: () => this.engine.heartbeat(assignment.id),
      progress: () => this.engine.progress(assignment.id),
    };
    const ctx: WorkerContext = {
      ticket,
      assignment,
      workDir: path.join(this.workRoot, ticket.id),
      inputs,
      signals,
    };
    return this.worker.run(ctx);
  }
}
