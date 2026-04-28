import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, TicketRef } from "../../domain/types.js";
import { JiraAdapter } from "./index.js";
import { JiraWebhookReceiver, subscribeReceiver } from "./webhook.js";

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

describe("JiraWebhookReceiver — dispatch", () => {
  let receiver: JiraWebhookReceiver;

  beforeEach(() => {
    receiver = new JiraWebhookReceiver();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it("parses comment_created payload and emits the parsed Event to handlers", () => {
    const ev: Event = {
      id: "evt_1",
      at: "2026-04-25T10:00:00Z",
      type: "message",
      from: "orchestrator",
      kind: "nudge",
      body: "stay",
      in_reply_to: null,
    };
    const seen: Array<[string, Event]> = [];
    receiver.on((key, e) => seen.push([key, e]));
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-1" },
      comment: { id: "c1", body: `[event:message] ${JSON.stringify(ev)}` },
    });
    expect(seen).toEqual([["ACME-1", ev]]);
  });

  it("ignores comment payloads without an [event:type] prefix", () => {
    const seen: Array<[string, Event]> = [];
    receiver.on((key, e) => seen.push([key, e]));
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-1" },
      comment: { id: "c1", body: "ordinary comment, not an event" },
    });
    expect(seen).toEqual([]);
  });

  it("ignores non-comment_created webhook events", () => {
    const seen: Array<[string, Event]> = [];
    receiver.on((key, e) => seen.push([key, e]));
    receiver.feed({
      webhookEvent: "issue_updated",
      issue: { key: "ACME-1" },
    });
    expect(seen).toEqual([]);
  });

  it("supports unsubscribe", () => {
    const seen: Array<[string, Event]> = [];
    const unsubscribe = receiver.on((key, e) => seen.push([key, e]));
    const ev: Event = {
      id: "evt_1",
      at: "2026-04-25T10:00:00Z",
      type: "log",
      by: null,
      line: "x",
    };
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-1" },
      comment: { id: "c1", body: `[event:log] ${JSON.stringify(ev)}` },
    });
    unsubscribe();
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-1" },
      comment: { id: "c2", body: `[event:log] ${JSON.stringify(ev)}` },
    });
    expect(seen).toHaveLength(1);
  });
});

describe("JiraWebhookReceiver — HTTP", () => {
  let receiver: JiraWebhookReceiver;

  beforeEach(async () => {
    receiver = new JiraWebhookReceiver();
    await receiver.start(0);
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it("accepts POST /webhook with JSON body and dispatches", async () => {
    const ev: Event = {
      id: "evt_http",
      at: "2026-04-25T10:00:00Z",
      type: "message",
      from: "orchestrator",
      kind: "nudge",
      body: "via http",
      in_reply_to: null,
    };
    const seen: Array<[string, Event]> = [];
    receiver.on((key, e) => seen.push([key, e]));

    const res = await fetch(`http://127.0.0.1:${receiver.port()}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhookEvent: "comment_created",
        issue: { key: "ACME-7" },
        comment: { id: "c1", body: `[event:message] ${JSON.stringify(ev)}` },
      }),
    });
    expect(res.status).toBe(204);
    expect(seen).toEqual([["ACME-7", ev]]);
  });

  it("returns 404 for non-/webhook paths", async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port()}/somewhere-else`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${receiver.port()}/webhook`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("JiraAdapter.watch with webhook receiver", () => {
  let receiver: JiraWebhookReceiver;

  beforeEach(() => {
    receiver = new JiraWebhookReceiver();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it("subscribes to the receiver and filters to project-prefixed issues", async () => {
    const adapter = new JiraAdapter({
      ...baseConfig,
      webhookReceiver: receiver,
      // No fetchImpl needed — webhook path doesn't hit REST.
    });

    const seen: Array<{ ref: TicketRef; events: Event[] }> = [];
    const unsubscribe = await adapter.watch("P", (ref, events) => {
      seen.push({ ref, events });
    });

    const ev: Event = {
      id: "evt_1",
      at: "2026-04-25T10:00:00Z",
      type: "message",
      from: "orchestrator",
      kind: "nudge",
      body: "in scope",
      in_reply_to: null,
    };
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-42" },
      comment: { id: "c1", body: `[event:message] ${JSON.stringify(ev)}` },
    });
    // Different project — should be filtered out.
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "OTHER-1" },
      comment: { id: "c2", body: `[event:message] ${JSON.stringify(ev)}` },
    });

    expect(seen).toEqual([{ ref: { project: "P", id: "ACME-42" }, events: [ev] }]);
    await unsubscribe();
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-99" },
      comment: { id: "c3", body: `[event:message] ${JSON.stringify(ev)}` },
    });
    // No new entries after unsubscribe.
    expect(seen).toHaveLength(1);
  });
});

describe("subscribeReceiver helper", () => {
  it("filters by issue predicate before invoking the callback", () => {
    const receiver = new JiraWebhookReceiver();
    const seen: Array<{ ref: TicketRef; events: Event[] }> = [];
    const unsubscribe = subscribeReceiver(
      receiver,
      "P",
      (key) => key === "ACME-1",
      (ref, events) => seen.push({ ref, events }),
    );
    const ev: Event = {
      id: "evt_1",
      at: "2026-04-25T10:00:00Z",
      type: "log",
      by: null,
      line: "x",
    };
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-1" },
      comment: { id: "c1", body: `[event:log] ${JSON.stringify(ev)}` },
    });
    receiver.feed({
      webhookEvent: "comment_created",
      issue: { key: "ACME-2" },
      comment: { id: "c2", body: `[event:log] ${JSON.stringify(ev)}` },
    });
    expect(seen).toEqual([{ ref: { project: "P", id: "ACME-1" }, events: [ev] }]);
    unsubscribe();
  });
});
