import type { Engine } from "../core/engine.ts";
import type { Assignment } from "../core/model.ts";

export interface WatchdogOptions {
  /** If no heartbeat for this long, the worker is treated as crashed. */
  heartbeatTimeoutMs: number;
  /** If no progress for this long (while heartbeating), the worker is stuck. */
  progressTimeoutMs: number;
  /** Absolute execution deadline from start. */
  deadlineMs: number;
  now?: () => number;
}

export interface WatchdogReport {
  crashed: number;
  stalled: number;
  deadline: number;
}

export type StallKind = "crashed" | "stalled" | "deadline";

export interface Verdict {
  kind: StallKind;
  reason: string;
}

/**
 * Pure classification of a running Assignment. The first match wins.
 * `heartbeatTimeoutMs > progressTimeoutMs` is what distinguishes a live-but-
 * stuck worker (fresh heartbeat, stale progress) from a crashed one.
 */
export function classify(
  assignment: Assignment,
  now: number,
  options: WatchdogOptions,
): Verdict | "ok" {
  const startedAt = assignment.startedAt ?? 0;
  if (now - startedAt > options.deadlineMs) {
    return { kind: "deadline", reason: "execution deadline exceeded" };
  }
  const lastHeartbeat = assignment.heartbeatAt ?? startedAt;
  if (now - lastHeartbeat > options.heartbeatTimeoutMs) {
    return { kind: "crashed", reason: "no heartbeat" };
  }
  const lastProgress = assignment.progressAt ?? startedAt;
  if (now - lastProgress > options.progressTimeoutMs) {
    return { kind: "stalled", reason: "alive but no progress" };
  }
  return "ok";
}

/**
 * Detects stale or interrupted executions. Scans only `running` assignments:
 * `waiting` and `completed` assignments are never recovered here.
 */
export class Watchdog {
  private readonly now: () => number;

  constructor(
    private readonly engine: Engine,
    private readonly options: WatchdogOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Scan and recover ineligible running assignments. */
  tick(): WatchdogReport {
    const now = this.now();
    const report: WatchdogReport = { crashed: 0, stalled: 0, deadline: 0 };
    for (const assignment of this.engine.runningAssignments()) {
      const verdict = classify(assignment, now, this.options);
      if (verdict === "ok") continue;

      this.engine.fail(assignment.id, {
        status: "failed",
        text: verdict.reason,
        question: null,
        at: now,
      });
      this.engine.replaceAssignment(assignment.ticketId);

      if (verdict.kind === "deadline") report.deadline++;
      else if (verdict.kind === "crashed") report.crashed++;
      else report.stalled++;
    }
    return report;
  }
}
