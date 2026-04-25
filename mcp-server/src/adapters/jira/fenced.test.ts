import { describe, expect, it } from "vitest";
import { readFenced, writeFenced } from "./fenced.js";

describe("fenced sections", () => {
  it("reads back what was written", () => {
    const t = writeFenced("hello", "scope", "auth");
    expect(readFenced(t, "scope")).toBe("auth");
  });

  it("preserves prior content above the section", () => {
    const t = writeFenced("# Title\n\nA paragraph.", "update", "wip");
    expect(t).toContain("# Title");
    expect(t).toContain("A paragraph.");
    expect(readFenced(t, "update")).toBe("wip");
  });

  it("overwrites without duplicating", () => {
    let t = writeFenced("x", "scope", "a");
    t = writeFenced(t, "scope", "b");
    const matches = t.match(/<!-- tt:scope -->/g) ?? [];
    expect(matches.length).toBe(1);
    expect(readFenced(t, "scope")).toBe("b");
  });

  it("null clears the section", () => {
    let t = writeFenced("desc", "scope", "a");
    t = writeFenced(t, "scope", null);
    expect(readFenced(t, "scope")).toBeNull();
    expect(t).toContain("desc");
  });

  it("returns null when section is absent", () => {
    expect(readFenced("just text", "scope")).toBeNull();
  });

  it("multi-line value roundtrips", () => {
    const value = "line1\nline2\nline3";
    const t = writeFenced("", "progress", value);
    expect(readFenced(t, "progress")).toBe(value);
  });

  it("two distinct keys do not collide", () => {
    let t = writeFenced("x", "scope", "auth");
    t = writeFenced(t, "branch", "feat/x");
    expect(readFenced(t, "scope")).toBe("auth");
    expect(readFenced(t, "branch")).toBe("feat/x");
  });
});
