# Orchestra

An experimental runtime for building persistent, event-driven AI agent systems
with centralized orchestration, isolated task execution and durable state.

> Learning project. We build the orchestration infrastructure ourselves rather
> than calling a multi-agent framework.

## The target

An event-driven multi-agent orchestration engine:

1. Event ingestion
2. Deterministic event filtering
3. A central Router
4. Task/Ticket creation
5. Isolated concurrent Workers
6. Persistent task states
7. Worker failure and reassignment

## Stack

- **TypeScript** + **Node.js** + **SQLite** (durable, transactional state)
- **Vue** dashboard (lightweight)

## Architecture

Clean-onion layout. Rules live in the core; adapters translate the outside world.

```
src/
  core/       Pure domain logic — zero I/O, imports nothing from app/sources
  app/        Services: Router, Store, Effects, Outbox, scheduler
  sources/    Adapters (event streams) → Triggers
  executor/   Worker session + directory management
  client/     Vue dashboard (imports types only)
tests/
```

### Guiding principles

- **One writer per state.** Each kind of state (Trigger, Ticket, Assignment, …)
  has exactly one module allowed to write it; everyone else reads or asks.
- **One transaction per command.** A command changes its aggregates atomically.
- **Write-then-act.** Persist intent (Effects/Outbox) before performing side
  effects, so a crash never loses or duplicates work.
- **Commands vs. facts.** Imperative methods (`stopTicket`) may be refused;
  past-tense methods (`assignmentStarted`) record what an adapter did.
- **Reserve a human slot.** Cap concurrent workers, but always keep one extra
  slot for human-initiated actions.

## Domain model

| Concept    | Meaning |
|------------|---------|
| Source     | A stream of events; holds its read position |
| Trigger    | One immutable event (idempotent: twice = one ticket) |
| Thread     | Related triggers in time order |
| Eval       | The judgment on a batch of triggers: accept / stop / ignore |
| Ticket     | A unit of authorized work (owns scope + state) |
| Assignment | A ticket bound to one worker instance |
| Executor   | The worker session + its directory |
| Channel    | The write side: where replies go |

## Commands

```sh
pnpm dev          # run with tsx watch
pnpm typecheck    # typecheck
pnpm test         # run tests once
pnpm test:watch   # run tests in watch mode
pnpm build        # compile to dist/
pnpm check        # typecheck + test + build
```
