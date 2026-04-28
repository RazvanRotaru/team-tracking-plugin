import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import { saveConfig } from "../config/loader.js";
import type { Event } from "../domain/types.js";
import { runListen } from "./listen.js";

describe("listen CLI", () => {
  let dir: string;
  let cwd: string;
  let stdoutChunks: string[];
  let originalWrite: typeof process.stdout.write;
  let originalCwd: () => string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-listen-"));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-listen-cwd-"));
    await saveConfig(
      {
        version: 1,
        adapter: "obsidian-kanban",
        adapterConfig: { vaultPath: dir },
        projects: [{ name: "P", adapterProjectRef: "projects/P" }],
        lockTtlSeconds: 1800,
      },
      path.join(cwd, ".team-tracking", "config.json"),
    );
    stdoutChunks = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === "string") stdoutChunks.push(chunk);
      else stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    originalCwd = process.cwd;
    process.cwd = () => cwd;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    process.cwd = originalCwd;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("drains buffered events and exits", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const ref = await adapter.createTicket("P", { type: "task", title: "T" });
    const ev: Event = {
      id: "evt_drain",
      at: "2026-04-25T11:00:00Z",
      type: "log",
      by: null,
      line: "buffered",
    };
    await adapter.appendEvent(ref, ev);

    const code = await runListen(["--project", "P", "--ticket-id", ref.id, "--timeout-ms", "500"]);

    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const eventsLine = lines.find((l) => l.type === "events");
    expect(eventsLine).toBeDefined();
    expect(eventsLine.events.map((e: Event) => e.id)).toContain("evt_drain");
  });

  it("returns timeout envelope when no events arrive in window", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const ref = await adapter.createTicket("P", { type: "task", title: "T" });
    const code = await runListen(["--project", "P", "--ticket-id", ref.id, "--timeout-ms", "200"]);
    expect(code).toBe(0);
    const out = stdoutChunks.join("");
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)?.type).toBe("timeout");
  });

  it("missing --project prints to stderr and returns non-zero", async () => {
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === "string") stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runListen([]);
      expect(code).not.toBe(0);
      expect(stderrChunks.join("")).toContain("missing --project");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });
});
