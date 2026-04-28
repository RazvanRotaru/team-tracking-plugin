import { describe, expect, it } from "vitest";
import { JiraAdapter } from "./index.js";

type RecordedCall = {
  url: string;
  method: string;
  body: unknown;
};

function makeMockFetch(
  routes: Array<{
    method: string;
    pathRe: RegExp;
    handler: (body: unknown, url: URL) => { status: number; body?: unknown };
  }>,
  recorded: RecordedCall[],
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url: url.pathname + url.search, method, body });

    const route = routes.find((r) => r.method === method && r.pathRe.test(url.pathname));
    if (!route) {
      return new Response(`no mock for ${method} ${url.pathname}`, { status: 500 });
    }
    const r = route.handler(body, url);
    const noBody = r.status === 204 || r.body === undefined;
    return new Response(noBody ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: noBody ? {} : { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const baseConfig = {
  baseUrl: "https://acme.atlassian.net",
  email: "u@a.co",
  apiToken: "tok",
  statusMap: {
    Backlog: "Backlog",
    Todo: "To Do",
    "In Progress": "In Progress",
    "In Review": "In Review",
    Done: "Done",
    Blocked: "Blocked",
  },
  projects: [{ name: "P", adapterProjectRef: "ACME" }],
};

describe("JiraAdapter (mock fetch)", () => {
  it("createTicket POSTs the expected fields and returns the issue key", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "POST",
          pathRe: /^\/rest\/api\/3\/issue$/,
          handler: () => ({ status: 201, body: { id: "10001", key: "ACME-1" } }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    const ref = await a.createTicket("P", {
      type: "task",
      title: "Build it",
      priority: "P0",
      labels: ["x"],
    });
    expect(ref).toEqual({ project: "P", id: "ACME-1" });
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { fields: Record<string, unknown> };
    expect(body.fields.summary).toBe("Build it");
    expect((body.fields.project as { key: string }).key).toBe("ACME");
    expect((body.fields.issuetype as { name: string }).name).toBe("Task");
    expect((body.fields.priority as { name: string }).name).toBe("Highest");
    expect(body.fields.labels).toEqual(["x"]);
  });

  it("getTicket maps Jira status, type, and priority into canonical form", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "GET",
          pathRe: /^\/rest\/api\/3\/issue\/ACME-7/,
          handler: () => ({
            status: 200,
            body: {
              id: "1",
              key: "ACME-7",
              fields: {
                summary: "T",
                description: { type: "doc", version: 1, content: [] },
                status: { name: "In Progress" },
                priority: { name: "High" },
                issuetype: { name: "Task" },
                labels: [],
                created: "2026-04-24T00:00:00Z",
                updated: "2026-04-24T00:00:00Z",
              },
            },
          }),
        },
        {
          method: "POST",
          pathRe: /^\/rest\/api\/3\/search$/,
          handler: () => ({ status: 200, body: { issues: [], total: 0 } }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    const t = await a.getTicket({ project: "P", id: "ACME-7" });
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.title).toBe("T");
    expect(t.status).toBe("In Progress");
    expect(t.priority).toBe("P1");
    expect(t.type).toBe("task");
    expect(t.lock).toBeNull();
  });

  it("writeLock stores JSON in description fenced section when no custom field configured", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "GET",
          pathRe: /^\/rest\/api\/3\/issue\/ACME-1/,
          handler: () => ({
            status: 200,
            body: {
              id: "1",
              key: "ACME-1",
              fields: { description: "" },
            },
          }),
        },
        {
          method: "PUT",
          pathRe: /^\/rest\/api\/3\/issue\/ACME-1/,
          handler: () => ({ status: 204 }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    await a.writeLock(
      { project: "P", id: "ACME-1" },
      {
        owner: "alice",
        token: "tok_x",
        acquired_at: "2026-04-24T10:00:00Z",
        last_checkpoint: null,
      },
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    const body = put?.body as { fields: { description?: unknown } };
    // Description should now contain a fenced lock section with JSON.
    const adf = body.fields.description as {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text =
      adf.content?.flatMap((p) => p.content?.map((c) => c.text ?? "") ?? [""]).join("\n") ?? "";
    expect(text).toContain("<!-- tt:lock -->");
    expect(text).toContain("alice");
  });

  it("appendLog adds a comment in ADF format", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "POST",
          pathRe: /\/comment$/,
          handler: () => ({ status: 201, body: { id: "c1" } }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    await a.appendLog({ project: "P", id: "ACME-1" }, "hello world");
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      body: { content: Array<{ content: Array<{ text: string }> }> };
    };
    expect(body.body.content[0]?.content[0]?.text).toBe("hello world");
  });

  it("appendEvent emits a comment with [event:type] prefix and JSON payload", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "POST",
          pathRe: /\/comment$/,
          handler: () => ({ status: 201, body: { id: "c1" } }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    await a.appendEvent(
      { project: "P", id: "ACME-1" },
      {
        id: "evt_1",
        at: "2026-04-25T10:00:00Z",
        type: "message",
        from: "orchestrator",
        kind: "nudge",
        body: "stay in scope",
        in_reply_to: null,
      },
    );
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      body: { content: Array<{ content: Array<{ text: string }> }> };
    };
    const text = body.body.content[0]?.content[0]?.text ?? "";
    expect(text).toMatch(/^\[event:message\] /);
    expect(text).toContain('"id":"evt_1"');
    expect(text).toContain('"kind":"nudge"');
  });

  it("appendEvent for checkpoint also writes update / progress_summary cache", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "POST",
          pathRe: /\/comment$/,
          handler: () => ({ status: 201, body: { id: "c1" } }),
        },
        {
          method: "GET",
          pathRe: /^\/rest\/api\/3\/issue\/ACME-1/,
          handler: () => ({
            status: 200,
            body: { id: "1", key: "ACME-1", fields: { description: "" } },
          }),
        },
        {
          method: "PUT",
          pathRe: /^\/rest\/api\/3\/issue\/ACME-1/,
          handler: () => ({ status: 204 }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    await a.appendEvent(
      { project: "P", id: "ACME-1" },
      {
        id: "evt_cp",
        at: "2026-04-25T10:00:00Z",
        type: "checkpoint",
        by: "alice",
        commit_id: "abc1234",
        update: "halfway",
        progress_summary: "flow drafted",
      },
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    const body = put?.body as { fields: { description?: unknown } };
    const adf = body.fields.description as {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text =
      adf.content?.flatMap((p) => p.content?.map((c) => c.text ?? "") ?? [""]).join("\n") ?? "";
    expect(text).toContain("<!-- tt:update -->");
    expect(text).toContain("halfway");
    expect(text).toContain("flow drafted");
  });

  it("readEvents parses [event:type] prefixed comments back into Event objects", async () => {
    const calls: RecordedCall[] = [];
    const ev = {
      id: "evt_1",
      at: "2026-04-25T10:00:00Z",
      type: "message" as const,
      from: "orchestrator",
      kind: "nudge",
      body: "stay in scope",
      in_reply_to: null,
    };
    const fetchImpl = makeMockFetch(
      [
        {
          method: "GET",
          pathRe: /\/comment$/,
          handler: () => ({
            status: 200,
            body: {
              comments: [
                { id: "c1", body: "regular log line — should be ignored" },
                { id: "c2", body: `[event:message] ${JSON.stringify(ev)}` },
              ],
            },
          }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    const events = await a.readEvents({ project: "P", id: "ACME-1" });
    expect(events).toEqual([ev]);
  });

  it("readEvents respects since and types filters", async () => {
    const evOld = {
      id: "evt_old",
      at: "2026-04-25T09:00:00Z",
      type: "log" as const,
      by: null,
      line: "ancient",
    };
    const evNew = {
      id: "evt_new",
      at: "2026-04-25T11:00:00Z",
      type: "message" as const,
      from: "orchestrator",
      kind: "nudge",
      body: "fresh",
      in_reply_to: null,
    };
    const calls: RecordedCall[] = [];
    const fetchImpl = makeMockFetch(
      [
        {
          method: "GET",
          pathRe: /\/comment$/,
          handler: () => ({
            status: 200,
            body: {
              comments: [
                { id: "c1", body: `[event:log] ${JSON.stringify(evOld)}` },
                { id: "c2", body: `[event:message] ${JSON.stringify(evNew)}` },
              ],
            },
          }),
        },
      ],
      calls,
    );
    const a = new JiraAdapter({ ...baseConfig, fetchImpl });
    const fresh = await a.readEvents(
      { project: "P", id: "ACME-1" },
      { since: "2026-04-25T10:00:00Z" },
    );
    expect(fresh.map((e) => e.id)).toEqual(["evt_new"]);
    const onlyMessages = await a.readEvents({ project: "P", id: "ACME-1" }, { types: ["message"] });
    expect(onlyMessages.map((e) => e.id)).toEqual(["evt_new"]);
  });
});
