/**
 * Status mapping between our canonical vocabulary and a Jira project's
 * workflow statuses. Configured in `config.adapterConfig.statusMap`.
 *
 * Canonical → Jira via `toJira`. Jira → canonical via `fromJira`. Round-trip
 * is required: every status read from Jira must be mappable back.
 */
export type StatusMap = Readonly<Record<string, string>>;

export class StatusMapper {
  private readonly forward: StatusMap;
  private readonly inverse: StatusMap;

  constructor(forward: StatusMap) {
    this.forward = { ...forward };
    const inv: Record<string, string> = {};
    for (const [k, v] of Object.entries(forward)) {
      inv[v] = k;
    }
    this.inverse = inv;
  }

  toJira(canonical: string): string {
    const j = this.forward[canonical];
    if (j === undefined) {
      throw new Error(`canonical status "${canonical}" is not mapped to any Jira status`);
    }
    return j;
  }

  fromJira(jira: string): string {
    const c = this.inverse[jira];
    if (c === undefined) {
      throw new Error(`Jira status "${jira}" is not in the inverse status map`);
    }
    return c;
  }

  hasCanonical(c: string): boolean {
    return c in this.forward;
  }

  hasJira(j: string): boolean {
    return j in this.inverse;
  }
}

export const PRIORITY_TO_JIRA: Record<"P0" | "P1" | "P2", string> = {
  P0: "Highest",
  P1: "High",
  P2: "Medium",
};

export const PRIORITY_FROM_JIRA: Record<string, "P0" | "P1" | "P2"> = {
  Highest: "P0",
  High: "P1",
  Medium: "P2",
  Low: "P2",
  Lowest: "P2",
};

export const ISSUE_TYPE_FROM_NEUTRAL: Record<string, string> = {
  epic: "Epic",
  story: "Story",
  task: "Task",
  subtask: "Sub-task",
};

export const ISSUE_TYPE_TO_NEUTRAL: Record<string, "epic" | "story" | "task" | "subtask"> = {
  Epic: "epic",
  Story: "story",
  Task: "task",
  "Sub-task": "subtask",
  Subtask: "subtask",
};
