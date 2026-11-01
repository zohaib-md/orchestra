import type { Worker, WorkerContext, WorkerResult } from "../executor/worker.ts";
import type { ModelClient } from "./model.ts";

function buildExecutionPrompt(ctx: WorkerContext): string {
  return [
    "You are an autonomous coding agent executing an authorized task.",
    `Scope: ${ctx.ticket.mandate.scope}`,
    "",
    "Inputs:",
    ...(ctx.inputs.length > 0 ? ctx.inputs : ["  (none)"]),
    "",
    "Produce a concise, concrete result.",
  ].join("\n");
}

/**
 * LLM-backed Worker. Emits heartbeat/progress signals so the Watchdog can
 * distinguish liveness from progress. A model failure rejects the promise,
 * which the Worker Runtime maps to a failed assignment and a bounded retry —
 * reliability stays with the runtime, not the model.
 */
export class LlmWorker implements Worker {
  constructor(private readonly client: ModelClient) {}

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    ctx.signals.heartbeat();
    ctx.signals.progress();
    const output = await this.client.complete(buildExecutionPrompt(ctx));
    ctx.signals.progress();
    return {
      report: { status: "ready", text: output.trim(), question: null, at: Date.now() },
      artifacts: ["result.txt"],
    };
  }
}
