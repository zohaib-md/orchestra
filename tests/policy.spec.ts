import { describe, expect, it } from "vitest";
import { gate, sourcePart } from "../src/core/policy.ts";
import type { Trigger } from "../src/core/model.ts";
import { makePolicy, SOURCE } from "./helpers.ts";

function trigger(actor: string, kind = "issue"): Trigger {
  return {
    id: "t",
    sourceId: SOURCE,
    externalId: "e",
    actor,
    kind,
    payload: "{}",
    createdAt: 0,
    threadIds: ["thread-1"],
    disposition: null,
  };
}

describe("gate", () => {
  it("admits an allowed person with explicit strength", () => {
    const result = gate(makePolicy(), trigger("alice"));
    expect(result).toEqual({
      admitted: true,
      strength: "explicit",
      basis: "addressed",
      actorKind: "person",
    });
  });

  it("admits a listed bot with inferred strength", () => {
    const result = gate(makePolicy(), trigger("ci-bot", "comment"));
    expect(result).toEqual({
      admitted: true,
      strength: "inferred",
      basis: "bot",
      actorKind: "bot",
    });
  });

  it("rejects an unknown actor", () => {
    expect(gate(makePolicy(), trigger("mallory"))).toEqual({
      admitted: false,
      actorKind: "other",
    });
  });

  it("treats an unknown Source as empty (no one allowed)", () => {
    const result = gate(makePolicy(), trigger("alice"));
    expect(result.admitted).toBe(true);
    expect(sourcePart(makePolicy(), "source:unknown")).toEqual({
      allowed: [],
      bots: [],
    });
    expect(gate(makePolicy(), { ...trigger("alice"), sourceId: "source:unknown" })).toEqual({
      admitted: false,
      actorKind: "other",
    });
  });
});
