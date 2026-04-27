import * as net from "node:net";
import { describe, expect, it } from "vitest";
import { buildAdapter } from "./index.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo | null;
      const port = addr?.port ?? 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

describe("buildAdapter (jira) — webhook receiver lifecycle", () => {
  it("starts a webhook receiver when webhookPort is configured and dispose stops it", async () => {
    const port = await freePort();
    const built = await buildAdapter({
      version: 1,
      adapter: "jira",
      adapterConfig: {
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
        webhookPort: port,
      },
      projects: [{ name: "P", adapterProjectRef: "ACME" }],
      lockTtlSeconds: 1800,
    });

    // Receiver should be answering on the configured port.
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      body: JSON.stringify({ webhookEvent: "issue_updated", issue: { key: "ACME-1" } }),
    });
    expect(res.status).toBe(204);

    await built.dispose();

    // Port should be free again — connection refused.
    await expect(
      fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: "{}" }),
    ).rejects.toThrow();
  });

  it("returns a no-op dispose when no webhookPort is configured", async () => {
    const built = await buildAdapter({
      version: 1,
      adapter: "jira",
      adapterConfig: {
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
      },
      projects: [{ name: "P", adapterProjectRef: "ACME" }],
      lockTtlSeconds: 1800,
    });
    // Dispose should resolve cleanly.
    await expect(built.dispose()).resolves.toBeUndefined();
  });
});
