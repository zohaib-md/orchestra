import type { Worker, WorkerContext, WorkerResult } from "../executor/worker.ts";
import type { EventSink } from "../core/ports.ts";
import type { CompletionResult, ModelClient, TokenUsage } from "./model.ts";

export interface LlmWorkerOptions {
  model?: string;
  events?: EventSink;
}

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
  private readonly model: string;
  private readonly events: EventSink | undefined;

  constructor(
    private readonly client: ModelClient,
    options: LlmWorkerOptions = {},
  ) {
    this.model = options.model ?? "llm";
    this.events = options.events;
  }

  async run(ctx: WorkerContext): Promise<WorkerResult> {
    ctx.signals.heartbeat();
    ctx.signals.progress();

    const started = Date.now();
    let result: CompletionResult;
    try {
      result = await this.client.complete(buildExecutionPrompt(ctx));
    } catch (err) {
      this.record(started, false, null, err, ctx);
      throw err;
    }
    this.record(started, true, result.usage, null, ctx);

    ctx.signals.progress();
    return {
      report: { status: "ready", text: result.text.trim(), question: null, at: Date.now() },
      artifacts: ["result.txt"],
    };
  }

  private record(
    started: number,
    ok: boolean,
    usage: TokenUsage | null,
    error: unknown,
    ctx: WorkerContext,
  ): void {
    if (this.events === undefined) return;
    const data: Record<string, unknown> = {
      model: this.model,
      role: "worker",
      latencyMs: Date.now() - started,
      ok,
    };
    if (usage !== null) data["usage"] = { ...usage };
    if (error !== null) data["error"] = error instanceof Error ? error.message : String(error);
    this.events.append({
      at: Date.now(),
      kind: "llm.call",
      ticketId: ctx.ticket.id,
      assignmentId: ctx.assignment.id,
      triggerId: null,
      threadId: null,
      data,
    });
  }
}
