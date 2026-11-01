import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Store } from "../src/app/store.ts";
import { Engine } from "../src/core/engine.ts";
import { createApiServer } from "../src/app/server.ts";
import { makeInputs, makePolicy } from "./helpers.ts";

const servers: Server[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
  for (const store of stores) store.close();
  stores.length = 0;
});

async function startApi(): Promise<{ base: string; store: Store }> {
  const store = new Store(":memory:");
  stores.push(store);
  const engine = new Engine(store, { policy: () => makePolicy() });
  for (const input of makeInputs(2)) engine.receive(input);
  await engine.evaluateDue();

  const server = createApiServer(store, 0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, store };
}

describe("read-only API", () => {
  it("serves overview, tickets, threads, events, assignments, failures, llm", async () => {
    const { base } = await startApi();

    const overview = (await (await fetch(`${base}/api/overview`)).json()) as Record<string, any>;
    expect(overview.tickets.open).toBe(2);
    expect(overview.assignments.pending).toBe(2);
    expect(overview.events).toBeGreaterThan(0);

    const tickets = (await (await fetch(`${base}/api/tickets`)).json()) as unknown[];
    expect(tickets).toHaveLength(2);

    const threads = (await (await fetch(`${base}/api/threads`)).json()) as Array<{
      triggerCount: number;
    }>;
    expect(threads).toHaveLength(2);
    expect(threads.every((t) => t.triggerCount === 1)).toBe(true);

    const events = (await (await fetch(`${base}/api/events`)).json()) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toContain("ticket.created");

    const assignments = (await (await fetch(`${base}/api/assignments`)).json()) as unknown[];
    expect(assignments).toHaveLength(2);

    const failures = (await (await fetch(`${base}/api/failures`)).json()) as unknown[];
    expect(failures).toEqual([]);

    const llm = (await (await fetch(`${base}/api/llm`)).json()) as { total: number };
    expect(llm.total).toBe(0);
  });

  it("serves a ticket detail with its assignments and events", async () => {
    const { base, store } = await startApi();
    const ticketId = store.tickets.list()[0]!.id;
    const detail = (await (
      await fetch(`${base}/api/tickets/${encodeURIComponent(ticketId)}`)
    ).json()) as { ticket: { id: string }; assignments: unknown[]; events: unknown[] };
    expect(detail.ticket.id).toBe(ticketId);
    expect(detail.assignments).toHaveLength(1);
    expect(detail.events.length).toBeGreaterThan(0);
  });

  it("rejects non-GET requests", async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/api/tickets`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
