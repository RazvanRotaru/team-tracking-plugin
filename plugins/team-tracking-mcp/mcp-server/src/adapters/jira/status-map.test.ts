import { describe, expect, it } from "vitest";
import { StatusMapper } from "./status-map.js";

const fwd = {
  Backlog: "Backlog",
  Todo: "To Do",
  "In Progress": "In Progress",
  "In Review": "In Review",
  Done: "Done",
  Blocked: "Blocked",
};

describe("StatusMapper", () => {
  it("forward map: canonical → Jira", () => {
    const m = new StatusMapper(fwd);
    expect(m.toJira("Todo")).toBe("To Do");
    expect(m.toJira("In Progress")).toBe("In Progress");
  });

  it("inverse map: Jira → canonical", () => {
    const m = new StatusMapper(fwd);
    expect(m.fromJira("To Do")).toBe("Todo");
    expect(m.fromJira("Done")).toBe("Done");
  });

  it("hasCanonical / hasJira reflect coverage", () => {
    const m = new StatusMapper(fwd);
    expect(m.hasCanonical("Todo")).toBe(true);
    expect(m.hasCanonical("Sideways")).toBe(false);
    expect(m.hasJira("To Do")).toBe(true);
    expect(m.hasJira("Whatever")).toBe(false);
  });

  it("toJira throws on unknown canonical", () => {
    const m = new StatusMapper(fwd);
    expect(() => m.toJira("Sideways")).toThrow();
  });

  it("fromJira throws on unmapped Jira status", () => {
    const m = new StatusMapper(fwd);
    expect(() => m.fromJira("Whatever")).toThrow();
  });
});
