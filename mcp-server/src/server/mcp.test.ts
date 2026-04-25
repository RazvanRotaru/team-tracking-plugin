import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import { buildServer } from "../index.js";

/**
 * End-to-end: spin up the real `McpServer` over an in-memory transport pair,
 * connect a real `Client`, and exercise the lock cycle through the protocol.
 */
describe("MCP wiring (in-memory transport)", () => {
  let dir: string;
  let client: Client;

  async function callTool(
    name: string,
    args: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const block = (res.content as Array<{ type: string; text: string }>)[0];
    return { text: block?.text ?? "", isError: res.isError === true };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-mcp-"));
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const server = buildServer(adapter, 1800);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.1" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists the registered tools", async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "acquire_ticket",
        "append_log",
        "commit_checkpoint",
        "create_ticket",
        "get_ticket",
        "list_board",
        "list_children",
        "release_ticket",
        "report_progress",
        "update_ticket",
      ].sort(),
    );
  });

  it("full create → acquire → checkpoint → release cycle", async () => {
    const create = await callTool("create_ticket", {
      project: "P",
      draft: { type: "task", title: "Build it" },
    });
    expect(create.isError).toBe(false);
    const ref = JSON.parse(create.text) as { project: string; id: string };

    const acq = await callTool("acquire_ticket", { ref, owner: "alice" });
    expect(acq.isError).toBe(false);
    const { lock_token } = JSON.parse(acq.text) as { lock_token: string };

    const cp = await callTool("commit_checkpoint", {
      ref,
      lock_token,
      commit_id: "abc1234",
      update: "halfway",
      progress_summary: "draft done",
    });
    expect(cp.isError).toBe(false);

    const rel = await callTool("release_ticket", {
      ref,
      lock_token,
      final_status: "Done",
    });
    expect(rel.isError).toBe(false);

    const get = await callTool("get_ticket", { ref });
    const ticket = JSON.parse(get.text);
    expect(ticket.status).toBe("Done");
    expect(ticket.lock_state).toBe("free");
  });

  it("invariant violations come back as isError=true with kind prefix", async () => {
    const r = await callTool("create_ticket", {
      project: "P",
      draft: { type: "subtask", title: "X" }, // missing parent
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^EPARENT:/);
  });

  it("acquire while locked returns ELOCKED", async () => {
    const create = await callTool("create_ticket", {
      project: "P",
      draft: { type: "task", title: "T" },
    });
    const ref = JSON.parse(create.text) as { project: string; id: string };
    const a = await callTool("acquire_ticket", { ref, owner: "alice" });
    expect(a.isError).toBe(false);
    const b = await callTool("acquire_ticket", { ref, owner: "bob" });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/^ELOCKED:/);
  });
});
