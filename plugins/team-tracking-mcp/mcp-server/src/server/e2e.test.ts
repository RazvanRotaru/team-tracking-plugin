import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end via stdio: spawns `tsx src/index.ts` as a child process with a
 * temp `./.team-tracking/config.json`, drives the full
 * acquire → checkpoint → simulate-crash → re-acquire → release flow through
 * the MCP protocol over real stdio pipes. No mocks, no in-memory transport.
 */
describe("MCP stdio e2e: full retry-from-checkpoint story", () => {
  let cwd: string;
  let vault: string;
  let client: Client;

  async function callTool(
    name: string,
    args: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const block = (res.content as Array<{ type: string; text: string }>)[0];
    return { text: block?.text ?? "", isError: res.isError === true };
  }

  beforeAll(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-e2e-"));
    vault = path.join(cwd, "vault");
    await fs.mkdir(path.join(cwd, ".team-tracking"), { recursive: true });
    const config = {
      version: 1,
      adapter: "obsidian-kanban",
      adapterConfig: { vaultPath: vault },
      projects: [{ name: "P", adapterProjectRef: "projects/P" }],
      // Tiny TTL so we can trigger the stale-lock path without sleeping forever.
      lockTtlSeconds: 1,
    };
    await fs.writeFile(
      path.join(cwd, ".team-tracking", "config.json"),
      JSON.stringify(config, null, 2),
      "utf8",
    );

    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexTs = path.resolve(here, "..", "index.ts");
    const tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");

    client = new Client({ name: "e2e-client", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: tsx,
      args: [indexTs],
      cwd,
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("read_events / read_project_events surface every recorded mutation", async () => {
    // Fresh ticket — exercise create, status change, message, log, progress.
    const epicCall = await callTool("create_ticket", {
      project: "P",
      draft: { type: "epic", title: "Audit me" },
    });
    expect(epicCall.isError).toBe(false);
    const epic = JSON.parse(epicCall.text) as { project: string; id: string };

    await callTool("update_ticket", { ref: epic, update: { status: "Todo" } });
    await callTool("post_message", {
      ref: epic,
      from: "orchestrator",
      kind: "info",
      body: "kicking off",
    });
    await callTool("append_log", { ref: epic, line: "branch cut" });

    const eventsCall = await callTool("read_events", { ref: epic });
    expect(eventsCall.isError).toBe(false);
    const events = JSON.parse(eventsCall.text) as Array<{ type: string; at: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("status_change");
    expect(types).toContain("message");
    expect(types).toContain("log");

    // since-cursor filter — only most recent should come back.
    const lastAt = events[events.length - 1]?.at;
    expect(lastAt).toBeDefined();
    const filteredCall = await callTool("read_events", {
      ref: epic,
      since: lastAt,
    });
    expect(filteredCall.isError).toBe(false);
    expect(JSON.parse(filteredCall.text)).toEqual([]);

    // types filter narrows.
    const messagesOnlyCall = await callTool("read_events", {
      ref: epic,
      types: ["message"],
    });
    expect(messagesOnlyCall.isError).toBe(false);
    const messagesOnly = JSON.parse(messagesOnlyCall.text) as Array<{ type: string }>;
    expect(messagesOnly.every((e) => e.type === "message")).toBe(true);
    expect(messagesOnly).toHaveLength(1);

    // Project-wide read returns ref+event pairs.
    const projectCall = await callTool("read_project_events", { project: "P" });
    expect(projectCall.isError).toBe(false);
    const projectPairs = JSON.parse(projectCall.text) as Array<{
      ref: { id: string };
      event: { type: string };
    }>;
    expect(projectPairs.length).toBeGreaterThan(0);
    expect(projectPairs.every((p) => p.ref.id === epic.id || typeof p.ref.id === "string")).toBe(
      true,
    );
    expect(projectPairs.some((p) => p.event.type === "message")).toBe(true);
  }, 30_000);

  it("create → acquire → checkpoint → stale → recovered_checkpoint → release", async () => {
    // Create epic → story (story can host a subtask)
    const epicCall = await callTool("create_ticket", {
      project: "P",
      draft: { type: "epic", title: "Build it" },
    });
    expect(epicCall.isError).toBe(false);
    const epic = JSON.parse(epicCall.text) as { project: string; id: string };

    const storyCall = await callTool("create_ticket", {
      project: "P",
      draft: { type: "story", parent: epic, title: "Slice 1" },
    });
    expect(storyCall.isError).toBe(false);
    const story = JSON.parse(storyCall.text) as { project: string; id: string };

    const subCall = await callTool("create_ticket", {
      project: "P",
      draft: { type: "subtask", parent: story, title: "Implement bit" },
    });
    expect(subCall.isError).toBe(false);
    const sub = JSON.parse(subCall.text) as { project: string; id: string };

    // Acquire
    const acq1 = await callTool("acquire_ticket", { ref: sub, owner: "alice" });
    expect(acq1.isError).toBe(false);
    const { lock_token: token1, recovered_checkpoint: rc1 } = JSON.parse(acq1.text) as {
      lock_token: string;
      recovered_checkpoint: { commit_id: string } | null;
    };
    expect(rc1).toBeNull();

    // Commit a checkpoint
    const cp = await callTool("commit_checkpoint", {
      ref: sub,
      lock_token: token1,
      commit_id: "deadbeef",
      update: "halfway through",
      progress_summary: "bit drafted",
    });
    expect(cp.isError).toBe(false);

    // Simulate crash: ttl=1s, wait it out.
    await new Promise((r) => setTimeout(r, 1500));

    // Re-acquire — should return the prior checkpoint as recovered.
    const acq2 = await callTool("acquire_ticket", { ref: sub, owner: "bob" });
    expect(acq2.isError).toBe(false);
    const { lock_token: token2, recovered_checkpoint: rc2 } = JSON.parse(acq2.text) as {
      lock_token: string;
      recovered_checkpoint: { commit_id: string; update: string | null } | null;
    };
    expect(rc2).not.toBeNull();
    expect(rc2?.commit_id).toBe("deadbeef");
    expect(rc2?.update).toBe("halfway through");

    // Release as Done
    const rel = await callTool("release_ticket", {
      ref: sub,
      lock_token: token2,
      final_status: "Done",
    });
    expect(rel.isError).toBe(false);

    // Verify final state on disk: subtask file's frontmatter should reflect Done and no lock.
    const subFile = path.join(vault, "projects", "P", sub.id, "ticket.md");
    const text = await fs.readFile(subFile, "utf8");
    expect(text).toMatch(/^status: Done\b/m);
    expect(text).toMatch(/^lock: null\b/m);
  }, 30_000);
});
