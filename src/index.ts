import { Store } from "./app/store";
import { Engine } from "./core/engine";
import { createApiServer } from "./app/server";
import type { Policy } from "./core/policy";

const dbPath = process.env.ORCHESTRA_DB ?? "./orchestra.db";
const port = Number(process.env.PORT ?? 8787);

const store = new Store(dbPath);

// The Engine is the single writer of domain state. Sources, the Worker
// Runtime and the Watchdog are wired here as they are added.
const policy: Policy = { version: "demo", rules: [], sources: {} };
new Engine(store, { policy: () => policy });

createApiServer(store, port);
console.log(`Orchestra API listening on http://localhost:${port}`);
