import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import type { Event, TicketRef } from "../domain/types.js";

/**
 * End-to-end check that the `team-tracking listen` CLI works as the
 * background-bash listener described in the skill docs: spawned as a
 * subprocess, it watches a real vault, exits on the first events
 * envelope, and prints JSONL on stdout.
 */
describe("listen CLI e2e (real subprocess)", () => {
  let cwd: string;
  let vault: string;
  let cliEntry: string;
  let tsx: string;
  let proc: ChildProcess | null;

  async function writeConfig(): Promise<void> {
    await fs.mkdir(path.join(cwd, ".team-tracking"), { recursive: true });
    const config = {
      version: 1,
      adapter: "obsidian-kanban",
      adapterConfig: { vaultPath: vault },
      projects: [{ name: "P", adapterProjectRef: "projects/P" }],
      lockTtlSeconds: 1800,
    };
    await fs.writeFile(
      path.join(cwd, ".team-tracking", "config.json"),
      JSON.stringify(config, null, 2),
      "utf8",
    );
  }

  function spawnListen(args: string[]): {
    proc: ChildProcess;
    stdout: Promise<string>;
    exitCode: Promise<number | null>;
  } {
    const p = spawn(tsx, [cliEntry, "listen", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc = p;
    const chunks: Buffer[] = [];
    p.stdout?.on("data", (c) => chunks.push(c as Buffer));
    p.stderr?.on("data", () => {
      /* drop — useful only when debugging the spawned process directly */
    });
    const stdout = new Promise<string>((resolve) => {
      p.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const exitCode = new Promise<number | null>((resolve) => {
      p.on("close", (code) => resolve(code));
    });
    return { proc: p, stdout, exitCode };
  }

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-listen-e2e-"));
    vault = path.join(cwd, "vault");
    await writeConfig();
    const here = path.dirname(fileURLToPath(import.meta.url));
    cliEntry = path.resolve(here, "cli.ts");
    tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");
    proc = null;
  });

  afterEach(async () => {
    if (proc && proc.exitCode === null && !proc.killed) {
      proc.kill("SIGTERM");
    }
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("drains buffered events and exits with code 0", async () => {
    const adapter = new ObsidianKanbanAdapter(vault);
    await adapter.init({ vaultPath: vault });
    const ref: TicketRef = await adapter.createTicket("P", { type: "task", title: "X" });
    const ev: Event = {
      id: "evt_drain",
      at: "2026-04-25T11:00:00Z",
      type: "log",
      by: null,
      line: "buffered",
    };
    await adapter.appendEvent(ref, ev);

    const { stdout, exitCode } = spawnListen([
      "--project",
      "P",
      "--ticket-id",
      ref.id,
      "--timeout-ms",
      "1500",
    ]);
    const out = await stdout;
    const code = await exitCode;
    expect(code).toBe(0);
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const eventsLine = lines.find((l: { type: string }) => l.type === "events") as {
      type: "events";
      ref: TicketRef;
      events: Event[];
    };
    expect(eventsLine).toBeDefined();
    expect(eventsLine.ref.id).toBe(ref.id);
    expect(eventsLine.events.map((e) => e.id)).toContain("evt_drain");
  }, 30_000);

  it("emits a timeout envelope when no events arrive in window", async () => {
    const adapter = new ObsidianKanbanAdapter(vault);
    await adapter.init({ vaultPath: vault });
    const ref = await adapter.createTicket("P", { type: "task", title: "X" });
    const { stdout, exitCode } = spawnListen([
      "--project",
      "P",
      "--ticket-id",
      ref.id,
      "--timeout-ms",
      "300",
    ]);
    const out = await stdout;
    const code = await exitCode;
    expect(code).toBe(0);
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)?.type).toBe("timeout");
  }, 30_000);

  it("delivers a live event appended after spawn via fs.watch", async () => {
    const adapter = new ObsidianKanbanAdapter(vault);
    await adapter.init({ vaultPath: vault });
    const ref = await adapter.createTicket("P", { type: "task", title: "X" });

    const {
      proc: p,
      stdout,
      exitCode,
    } = spawnListen(["--project", "P", "--ticket-id", ref.id, "--timeout-ms", "5000"]);

    // Give the subprocess a moment to register fs.watch before we write.
    await new Promise((r) => setTimeout(r, 400));

    const ev: Event = {
      id: "evt_live",
      at: new Date().toISOString(),
      type: "message",
      from: "orchestrator",
      kind: "nudge",
      body: "live",
      in_reply_to: null,
    };
    await adapter.appendEvent(ref, ev);

    const out = await stdout;
    const code = await exitCode;
    expect(code).toBe(0);
    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const eventsLine = lines.find((l: { type: string }) => l.type === "events") as {
      type: "events";
      ref: TicketRef;
      events: Event[];
    };
    expect(eventsLine).toBeDefined();
    expect(eventsLine.events.map((e) => e.id)).toContain("evt_live");
    // proc reference is just for cleanup safety; confirm it actually exited.
    expect(p.exitCode).toBe(0);
  }, 30_000);
});
