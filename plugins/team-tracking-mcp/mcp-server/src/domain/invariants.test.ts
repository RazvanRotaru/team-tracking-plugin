import { describe, expect, it } from "vitest";
import {
  allowedParentTypes,
  isParentRequired,
  validateCreate,
  validateStatusForType,
  validateUpdate,
} from "./invariants.js";
import type { TicketDTO, TicketType } from "./types.js";

const TYPES: TicketType[] = ["epic", "story", "task", "subtask"];

describe("allowedParentTypes", () => {
  it("epic has none", () => {
    expect(allowedParentTypes("epic")).toEqual([]);
  });

  it("story → epic", () => {
    expect(allowedParentTypes("story")).toEqual(["epic"]);
  });

  it("task → story, epic", () => {
    expect(allowedParentTypes("task")).toEqual(["story", "epic"]);
  });

  it("subtask → task, story", () => {
    expect(allowedParentTypes("subtask")).toEqual(["task", "story"]);
  });
});

describe("isParentRequired", () => {
  it("only subtask requires a parent", () => {
    expect(isParentRequired("subtask")).toBe(true);
    expect(isParentRequired("epic")).toBe(false);
    expect(isParentRequired("story")).toBe(false);
    expect(isParentRequired("task")).toBe(false);
  });
});

describe("validateCreate", () => {
  // Property-style: every (childType, parentType) combo, including null parent.
  const cases: Array<{
    child: TicketType;
    parent: TicketType | null;
    expected: "ok" | "EPARENT";
  }> = [];

  for (const child of TYPES) {
    for (const p of [null, ...TYPES] as Array<TicketType | null>) {
      let expected: "ok" | "EPARENT";
      if (child === "epic") {
        expected = p === null ? "ok" : "EPARENT";
      } else if (child === "story") {
        expected = p === null || p === "epic" ? "ok" : "EPARENT";
      } else if (child === "task") {
        expected = p === null || p === "epic" || p === "story" ? "ok" : "EPARENT";
      } else {
        expected = p === "task" || p === "story" ? "ok" : "EPARENT";
      }
      cases.push({ child, parent: p, expected });
    }
  }

  it.each(cases)("$child child with parent=$parent → $expected", ({ child, parent, expected }) => {
    const r = validateCreate({ type: child }, parent === null ? null : { type: parent });
    if (expected === "ok") {
      expect(r.ok).toBe(true);
    } else {
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("EPARENT");
    }
  });
});

describe("validateUpdate", () => {
  const current: Pick<TicketDTO, "type"> = { type: "task" };

  it("plain field updates pass", () => {
    const r = validateUpdate(current, { title: "new", priority: "P0" });
    expect(r.ok).toBe(true);
  });

  it("type change is rejected", () => {
    const r = validateUpdate(current, { type: "story" } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ETYPE_IMMUTABLE");
  });

  it("same-type 'change' passes (no-op)", () => {
    const r = validateUpdate(current, { type: "task" } as never);
    expect(r.ok).toBe(true);
  });

  it("parent change is rejected", () => {
    const r = validateUpdate(current, {
      parent: { project: "P", id: "X" },
    } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ETYPE_IMMUTABLE");
  });
});

describe("validateStatusForType", () => {
  it("subtask accepts Blocked", () => {
    expect(validateStatusForType("subtask", "Blocked").ok).toBe(true);
  });

  it("epic does NOT accept Blocked by default", () => {
    const r = validateStatusForType("epic", "Blocked");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ESTATUS");
  });

  it("epic accepts In Review", () => {
    expect(validateStatusForType("epic", "In Review").ok).toBe(true);
  });

  it("subtask does NOT accept Backlog", () => {
    const r = validateStatusForType("subtask", "Backlog");
    expect(r.ok).toBe(false);
  });

  it("nonsense status rejected for every type", () => {
    for (const t of TYPES) {
      expect(validateStatusForType(t, "Sideways").ok).toBe(false);
    }
  });

  it("custom allowed map overrides defaults", () => {
    const custom = {
      epic: ["X", "Y"],
      story: ["X"],
      task: ["X"],
      subtask: ["X"],
    };
    expect(validateStatusForType("epic", "X", custom).ok).toBe(true);
    expect(validateStatusForType("epic", "Backlog", custom).ok).toBe(false);
  });
});
