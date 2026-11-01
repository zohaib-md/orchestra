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
    model.ts    domain types
    ids.ts      deterministic ids (key)
    errors.ts   UserError + fixed refusal codes
    trigger.ts  canonical Trigger normalization (TriggerInput)
    policy.ts   Policy + deterministic admission gate
    assessor.ts pluggable semantic evaluator (deterministic default)
    engine.ts   the Router (single writer of domain state)
    ports.ts    Repositories + per-repository contracts
  app/
    store.ts    SQLite implementation of Repositories (node:sqlite)
  sources/    Adapters (event streams) → Triggers  [not yet built]
  executor/
    worker.ts   Worker interface (pluggable execution mechanism)
    runtime.ts  WorkerRuntime (dispatch, concurrency, retry, recovery)
  client/     Vue dashboard (imports types only)  [not yet built]
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

## Implementation status

| Milestone | Status |
|-----------|--------|
| V0.1 Event ingestion + deterministic routing | Done |
| V0.2 Tickets & Assignments (dispatch intents) | Done |
| V0.3 Concurrent isolated Workers + retry/recovery | Done |
| V0.4 SQLite persistence & migration | Done |
| V0.5 Watchdog (stall detection) | Not started |
| V0.6 LLM-powered evaluation & execution | Not started |
| V0.7 Vue monitoring dashboard | Not started |

### The pipeline

```
TriggerInput ──receive──▶ Trigger (deduped) ──fan-out──▶ subscribed Tickets
                              │ (else queued)
                              ▼
                      evaluateDue: gate (deterministic) ─▶ assessor (pluggable)
                              │ accept
                              ▼
                        Ticket + Mandate + pending Assignment (dispatch intent)
                              │
                              ▼
                 WorkerRuntime: claim ─▶ run Worker ─▶ report (retry on failure)
```

### Race conditions & known limitations

The design targets a **single process**. The following are safe in-process but
would need strengthening for multi-process deployment:

- **Eval queue**: `evaluateDue` reads pending threads, then `takeThread`s each
  in its own transaction. Two processes could take the same batch. A per-thread
  claim (like the assignment `claim` guard) would close this.
- **Recovery**: `recoverInterrupted` marks `running` assignments interrupted and
  creates replacements; two simultaneously-restarting processes could double
  that work. Needs a startup lock or a guarded transition.
- **Assignment claim** *is* guarded at the database level (conditional
  `UPDATE ... WHERE state = 'pending'`), so duplicate dispatch is already safe.

## Commands

```sh
pnpm dev          # run with tsx watch
pnpm typecheck    # typecheck
pnpm test         # run tests once
pnpm test:watch   # run tests in watch mode
pnpm build        # compile to dist/
pnpm check        # typecheck + test + build
```
