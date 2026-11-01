import path from "node:path";
import type { Engine } from "../core/engine";
import type { Assignment, Report } from "../core/model";
import type { Worker, WorkerContext, WorkerResult } from "./worker";

export interface WorkerRuntimeOptions {
  worker: Worker;
  /** Maximum number of concurrent workers. */
  maxWorkers: number;
  /** Root directory for per-ticket working directories. */
  workRoot: string;
  /** Replacement assignments allowed after the first attempt, per ticket. */
  maxRetries: number;
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
  private readonly maxRetries: number;
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
    this.maxRetries = options.maxRetries;
    this.now = options.now ?? (() => Date.now());
  }

  /** Recover assignments left in `running` by a previous, dead process. */
  start(): number {
    return this.engine.recoverInterrupted();
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
      const result = await this.runWorker(assignment);
      this.engine.report(assignment.id, result.report, result.artifacts);
      return { status: "completed", replaced: false };
    } catch (err) {
      const report: Report = {
        status: "failed",
        text: err instanceof Error ? err.message : String(err),
        question: null,
        at: this.now(),
      };
      this.engine.report(assignment.id, report);
      const attempts = this.engine.assignmentCount(assignment.ticketId);
      if (attempts <= this.maxRetries) {
        this.engine.replaceAssignment(assignment.ticketId);
        return { status: "failed", replaced: true };
      }
      return { status: "failed", replaced: false };
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
    const ctx: WorkerContext = {
      ticket,
      assignment,
      workDir: path.join(this.workRoot, ticket.id),
      inputs,
    };
    return this.worker.run(ctx);
  }
}
