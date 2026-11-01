import { describe, expect, it } from "vitest";
import { key } from "../src/core/ids.ts";

describe("key", () => {
  it("is deterministic for equal inputs", () => {
    expect(key("a", "b")).toBe(key("a", "b"));
  });

  it("differs when any input differs", () => {
    expect(key("a", "b")).not.toBe(key("a", "c"));
    expect(key("a", "b")).not.toBe(key("b", "a"));
  });

  it("differs from a single joined string", () => {
    expect(key("ab", "c")).not.toBe(key("a", "bc"));
  });

  it("produces a stable hexadecimal id", () => {
    expect(key("source", "evt-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
