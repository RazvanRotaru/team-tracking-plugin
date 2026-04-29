import { describe, expect, it } from "vitest";
import type { Event } from "../../domain/types.js";
import { type TicketFrontmatter, parseTicketFile, renderTicketFile } from "./frontmatter.js";

const baseFm: TicketFrontmatter = {
  type: "task",
  parent: null,
  status: "In Progress",
  priority: "P1",
  labels: [],
  scope: null,
  branch: null,
  pr_url: null,
  update: null,
  progress_summary: null,
  lock: null,
  created: "2026-04-29T10:00:00.000Z",
  updated: "2026-04-29T10:00:00.000Z",
};

const sampleEvents: Event[] = [
  {
    id: "evt_1",
    at: "2026-04-29T10:00:00.000Z",
    type: "created",
    ticket_type: "task",
    parent: null,
    title: "wire retry policy",
    status: "Backlog",
    priority: "P1",
    labels: [],
    scope: null,
  },
  {
    id: "evt_2",
    at: "2026-04-29T10:05:00.000Z",
    type: "lock_change",
    action: "acquire",
    owner: "implementer@dispatch-7",
    recovered_from: null,
    final_status: null,
  },
  {
    id: "evt_3",
    at: "2026-04-29T10:05:01.000Z",
    type: "status_change",
    by: "implementer@dispatch-7",
    from_status: "Todo",
    to_status: "In Progress",
  },
  {
    id: "evt_4",
    at: "2026-04-29T10:30:00.000Z",
    type: "checkpoint",
    by: "implementer@dispatch-7",
    commit_id: "abc1234567890",
    update: "wired retry policy",
    progress_summary: "queue config done;\nretry path 60% drafted",
  },
  {
    id: "evt_5",
    at: "2026-04-29T10:35:00.000Z",
    type: "message",
    from: "orchestrator",
    kind: "nudge",
    body: "stay within auth/ — billing/ is out of scope",
    in_reply_to: null,
  },
  {
    id: "evt_6",
    at: "2026-04-29T10:40:00.000Z",
    type: "log",
    by: "implementer@dispatch-7",
    line: "switched provider from X to Y",
  },
];

describe("renderTicketFile — Events section", () => {
  it("renders human-readable bullets above a collapsed JSONL fence", () => {
    const text = renderTicketFile({
      frontmatter: baseFm,
      body: "task body",
      children: [],
      log: [],
      events: sampleEvents,
    });

    // Section header present, bullets render before the fence.
    expect(text).toContain("## Events\n");

    // Human-readable bullets — one per event, in order.
    expect(text).toContain('- **2026-04-29 10:00:00Z** · created task "wire retry policy" · P1');
    expect(text).toContain(
      "- **2026-04-29 10:05:00Z** · lock · acquire by `implementer@dispatch-7`",
    );
    expect(text).toContain(
      "- **2026-04-29 10:05:01Z** · status · Todo → In Progress · by `implementer@dispatch-7`",
    );
    expect(text).toContain(
      "- **2026-04-29 10:30:00Z** · checkpoint · `implementer@dispatch-7` @ `abc1234`",
    );
    // Newlines in checkpoint progress_summary collapse to a single line.
    expect(text).toContain("  - progress: queue config done; retry path 60% drafted");
    expect(text).toContain("- **2026-04-29 10:35:00Z** · nudge from `orchestrator`");
    expect(text).toContain("  - stay within auth/ — billing/ is out of scope");
    expect(text).toContain(
      "- **2026-04-29 10:40:00Z** · log · `implementer@dispatch-7` · switched provider from X to Y",
    );

    // JSONL block lives inside <details>, after the bullets, in document order.
    const detailsIdx = text.indexOf("<details>");
    const fenceIdx = text.indexOf("```jsonl");
    const summaryIdx = text.indexOf("<summary>Raw event log (JSONL)</summary>");
    expect(detailsIdx).toBeGreaterThan(text.indexOf("## Events"));
    expect(summaryIdx).toBeGreaterThan(detailsIdx);
    expect(fenceIdx).toBeGreaterThan(summaryIdx);
    expect(text.indexOf("</details>")).toBeGreaterThan(fenceIdx);
  });

  it("round-trips through parseTicketFile — events come back identically", () => {
    const text = renderTicketFile({
      frontmatter: baseFm,
      body: "task body",
      children: [],
      log: [],
      events: sampleEvents,
    });
    const parsed = parseTicketFile(text);
    expect(parsed.events).toEqual(sampleEvents);
  });

  it("legacy tickets without the human-readable bullets still parse", () => {
    // Older tickets carry just a bare jsonl fence; new code must still read them.
    const legacy = `---
type: task
parent: null
status: Todo
priority: P2
labels: []
scope: null
branch: null
pr_url: null
update: null
progress_summary: null
lock: null
created: 2026-04-29T10:00:00.000Z
updated: 2026-04-29T10:00:00.000Z
---

task body

## Events

\`\`\`jsonl
${JSON.stringify(sampleEvents[0])}
${JSON.stringify(sampleEvents[1])}
\`\`\`
`;
    const parsed = parseTicketFile(legacy);
    expect(parsed.events).toEqual([sampleEvents[0], sampleEvents[1]]);
  });

  it("omits the Events section entirely when there are no events", () => {
    const text = renderTicketFile({
      frontmatter: baseFm,
      body: "task body",
      children: [],
      log: [],
      events: [],
    });
    expect(text).not.toContain("## Events");
    expect(text).not.toContain("```jsonl");
  });
});
