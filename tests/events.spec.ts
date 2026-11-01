import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import { LlmAssessor } from "../src/llm/assessor.ts";
import type { ModelClient, CompletionResult } from "../src/llm/model.ts";
import { makeInputs, makePolicy } from "./helpers.ts";

class ScriptedClient implements ModelClient {
  constructor(private readonly script: Array<string | Error>) {}
  async complete(): Promise<CompletionResult> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? "{}", usage: { promptTokens: 5, completionTokens: 2 } };
  }
}

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

describe("event log", () => {
  it("records the full lifecycle of a ticket", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const engine = new Engine(store, { policy: () => makePolicy() });

    for (const input of makeInputs(1)) engine.receive(input);
    await engine.evaluateDue();

    const assignment = store.assignments.list("pending")[0]!;
    engine.claim(assignment.id);
    engine.complete(assignment.id, { status: "ready", text: "done", question: null, at: 0 });
    engine.deliver(assignment.id);

    const kinds = store.events.list().map((e) => e.kind);
    expect(kinds).toEqual([
      "trigger.received",
      "decision.recorded",
      "ticket.created",
      "assignment.claimed",
      "assignment.completed",
      "assignment.delivered",
    ]);
  });

  it("records failure and recovery events", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const engine = new Engine(store, { policy: () => makePolicy(), maxRetries: 1 });

    for (const input of makeInputs(1)) engine.receive(input);
    await engine.evaluateDue();
    const assignment = store.assignments.list("pending")[0]!;
    engine.claim(assignment.id);
    engine.fail(assignment.id, { status: "failed", text: "boom", question: null, at: 0 });
    engine.replaceAssignment(assignment.ticketId);

    const kinds = store.events.list().map((e) => e.kind);
    expect(kinds).toContain("assignment.failed");
    expect(kinds).toContain("assignment.claimed");
  });

  it("records decision outcome with latency and reason code", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const engine = new Engine(store, { policy: () => makePolicy() });

    for (const input of makeInputs(1)) engine.receive(input);
    await engine.evaluateDue();

    const decision = store.events.list().find((e) => e.kind === "decision.recorded");
    expect(decision?.data.outcome).toBe("accept");
    expect(decision?.data.reasonCode).toBe("addressed");
    expect(typeof decision?.data.latencyMs).toBe("number");
  });

  it("records llm.call events from the assessor and worker", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const assessor = new LlmAssessor(
      new ScriptedClient([JSON.stringify({ outcome: "accept", rule: "fix" })]),
      { model: "deepseek-chat", events: store.events },
    );
    const engine = new Engine(store, { policy: () => makePolicy(), assessor });

    for (const input of makeInputs(1)) engine.receive(input);
    await engine.evaluateDue();

    const calls = store.events.list().filter((e) => e.kind === "llm.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.data).toMatchObject({
      model: "deepseek-chat",
      role: "assessor",
      ok: true,
      usage: { promptTokens: 5, completionTokens: 2 },
    });
  });
});
