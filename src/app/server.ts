import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Repositories } from "../core/ports.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function overview(repos: Repositories): unknown {
  const countBy = <T extends string>(items: Array<{ state: T }>): Record<T, number> => {
    const out = {} as Record<T, number>;
    for (const item of items) out[item.state] = (out[item.state] ?? 0) + 1;
    return out;
  };
  const assignments = repos.assignments.list();
  const failed = assignments.filter((a) => a.report?.status === "failed").length;
  return {
    tickets: countBy(repos.tickets.list()),
    assignments: countBy(assignments),
    triggers: repos.triggers.list().length,
    threads: repos.threads.list().length,
    events: repos.events.list().length,
    failures: failed,
  };
}

function failures(repos: Repositories): unknown {
  return repos.assignments
    .list()
    .filter((a) => a.report?.status === "failed")
    .map((a) => ({
      assignment: a,
      ticket: repos.tickets.get(a.ticketId) ?? null,
    }));
}

function llmStats(repos: Repositories): unknown {
  const calls = repos.events.list().filter((e) => e.kind === "llm.call");
  const errors = calls.filter((c) => c.data.ok === false).length;
  const latencies = calls.map((c) => Number(c.data.latencyMs ?? 0));
  const avgLatencyMs =
    latencies.length === 0
      ? 0
      : latencies.reduce((a, b) => a + b, 0) / latencies.length;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const call of calls) {
    const usage = call.data.usage as
      | { promptTokens?: number; completionTokens?: number }
      | undefined;
    if (usage !== undefined) {
      promptTokens += usage.promptTokens ?? 0;
      completionTokens += usage.completionTokens ?? 0;
    }
  }
  return { total: calls.length, errors, avgLatencyMs, promptTokens, completionTokens, calls };
}

function parseLimit(url: string | undefined): number | undefined {
  if (url === undefined) return undefined;
  const q = new URLSearchParams(url.split("?")[1] ?? "");
  const raw = q.get("limit");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function notFound(res: ServerResponse): void {
  json(res, 404, { error: "not_found" });
}

/**
 * Read-only HTTP API. It only reads from the Store and never mutates domain
 * state — the Engine is the sole writer. The dashboard consumes this.
 */
export function handleRequest(repos: Repositories, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }
  const url = req.url ?? "/";
  const path = url.split("?")[0] ?? "/";

  if (path === "/api/overview") return json(res, 200, overview(repos));
  if (path === "/api/tickets") return json(res, 200, repos.tickets.list());
  if (path === "/api/threads") {
    const threads = repos.threads.list().map((t) => ({
      ...t,
      triggerCount: repos.triggers.listByThread(t.id).length,
    }));
    return json(res, 200, threads);
  }
  if (path === "/api/triggers") return json(res, 200, repos.triggers.list());
  if (path === "/api/assignments") return json(res, 200, repos.assignments.list());
  if (path === "/api/events") return json(res, 200, repos.events.list(parseLimit(url)));
  if (path === "/api/failures") return json(res, 200, failures(repos));
  if (path === "/api/llm") return json(res, 200, llmStats(repos));

  const ticketMatch = /^\/api\/tickets\/([^/]+)$/.exec(path);
  if (ticketMatch !== null) {
    const id = decodeURIComponent(ticketMatch[1]!);
    const ticket = repos.tickets.get(id);
    if (ticket === undefined) return notFound(res);
    return json(res, 200, {
      ticket,
      assignments: repos.assignments.listByTicket(id),
      events: repos.events.byTicket(id),
    });
  }

  const threadMatch = /^\/api\/threads\/([^/]+)$/.exec(path);
  if (threadMatch !== null) {
    const id = decodeURIComponent(threadMatch[1]!);
    const thread = repos.threads.get(id);
    if (thread === undefined) return notFound(res);
    return json(res, 200, { thread, triggers: repos.triggers.listByThread(id) });
  }

  return notFound(res);
}

export function createApiServer(repos: Repositories, port = 8787): Server {
  const server = createServer((req, res) => handleRequest(repos, req, res));
  server.listen(port);
  return server;
}
