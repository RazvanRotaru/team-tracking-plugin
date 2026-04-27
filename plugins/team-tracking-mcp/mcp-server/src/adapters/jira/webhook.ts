import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Event, TicketRef } from "../../domain/types.js";

/**
 * Parsed `comment_created` payload — the only Jira webhook event we care
 * about, since events flow as comments with the `[event:type]` prefix.
 */
export type JiraCommentCreated = {
  webhookEvent: "comment_created";
  issue: { key: string };
  comment: { id: string; body: string };
};

export type WebhookHandler = (issueKey: string, event: Event) => void;

const EVENT_PREFIX_RE = /^\[event:([a-z_]+)\]\s+/;

function parseJiraEventComment(text: string): Event | null {
  const m = text.match(EVENT_PREFIX_RE);
  if (!m) return null;
  const json = text.slice(m[0].length).trimEnd();
  try {
    const parsed = JSON.parse(json) as Event;
    if (parsed && typeof parsed === "object" && "type" in parsed && "id" in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * HTTP receiver for Jira's outgoing webhooks. Hosts a single POST endpoint
 * (`/webhook` by default). The MCP server / listener CLI calls `start()`,
 * configures Jira to POST to its address, and registers handlers via
 * `on()`. Each registered handler fires for every parsed `[event:type]`
 * comment payload the receiver sees.
 *
 * Multi-tenant: the receiver doesn't filter by project — that's the
 * caller's job. A single receiver can serve multiple JiraAdapter
 * instances; each adapter subscribes via `on()` and filters incoming
 * `issueKey` values against its own project.
 */
export class JiraWebhookReceiver {
  private server: http.Server | null = null;
  private handlers = new Set<WebhookHandler>();
  private readonly path: string;

  constructor(opts: { path?: string } = {}) {
    this.path = opts.path ?? "/webhook";
  }

  on(handler: WebhookHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Start the HTTP server. If `port` is 0, the OS picks a free port and
   * the resolved port is available via `port()` after the promise resolves.
   */
  async start(port = 0, host = "127.0.0.1"): Promise<void> {
    if (this.server) throw new Error("receiver already started");
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        try {
          res.statusCode = 500;
          res.end(`error: ${(e as Error).message}`);
        } catch {
          // Connection already closed; nothing to do.
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  /** Bound port (0 if not started). */
  port(): number {
    const addr = this.server?.address() as AddressInfo | null;
    return addr?.port ?? 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Test seam — feed a payload directly without going through HTTP. Useful
   * for unit tests that want to exercise the dispatch path without binding
   * a port.
   */
  feed(payload: unknown): void {
    this.dispatch(payload);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== this.path) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end("invalid json");
      return;
    }
    this.dispatch(payload);
    res.statusCode = 204;
    res.end();
  }

  private dispatch(payload: unknown): void {
    const ev = this.parseCommentCreated(payload);
    if (!ev) return;
    const event = parseJiraEventComment(ev.comment.body);
    if (!event) return;
    for (const h of this.handlers) {
      try {
        h(ev.issue.key, event);
      } catch {
        // Handlers must not throw — broker is best-effort.
      }
    }
  }

  private parseCommentCreated(payload: unknown): JiraCommentCreated | null {
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    if (p.webhookEvent !== "comment_created") return null;
    const issue = p.issue as { key?: string } | undefined;
    const comment = p.comment as { id?: string; body?: string } | undefined;
    if (!issue?.key || !comment?.body || !comment.id) return null;
    // Jira sends comment.body as either a string (plain) or ADF (object).
    // Our adapter writes plain text via toAdf; on read the comment list
    // returns the original body. For webhook payloads, both shapes can
    // appear — we only handle plain strings here, matching the writer.
    if (typeof comment.body !== "string") return null;
    return {
      webhookEvent: "comment_created",
      issue: { key: issue.key },
      comment: { id: comment.id, body: comment.body },
    };
  }
}

/**
 * Helper used by JiraAdapter.watch when wired to a receiver. Returns an
 * unsubscribe function. Internal-ish — kept here to colocate the wire
 * format with the parser.
 */
export function subscribeReceiver(
  receiver: JiraWebhookReceiver,
  project: string,
  isProjectIssue: (issueKey: string) => boolean,
  callback: (ref: TicketRef, events: Event[]) => void,
): () => void {
  return receiver.on((issueKey, event) => {
    if (!isProjectIssue(issueKey)) return;
    callback({ project, id: issueKey }, [event]);
  });
}
