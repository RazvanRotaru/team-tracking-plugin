import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";

/**
 * End-to-end check that the executor protocol is fully callable from
 * `bash` via the `team-tracking <subcommand>` CLI — i.e. specialists
 * whose host doesn't grant the matching MCP tools can still acquire,
 * checkpoint, and release a ticket.
 */
describe("exec CLI e2e (real subprocess)", () => {
  let cwd: string;
  let vault: string;
  let cliEntry: string;
  let tsx: string;

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

  function run(args: string[]): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const p = spawn(tsx, [cliEntry, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      p.stdout?.on("data", (c) => out.push(c as Buffer));
      p.stderr?.on("data", () => {
        /* swallow */
      });
      p.on("close", (code) => resolve({ stdout: Buffer.concat(out).toString("utf8"), code }));
      p.on("error", reject);
    });
  }

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-exec-e2e-"));
    vault = path.join(cwd, "vault");
    await writeConfig();
    const here = path.dirname(fileURLToPath(import.meta.url));
    cliEntry = path.resolve(here, "cli.ts");
    tsx = path.resolve(here, "..", "..", "node_modules", ".bin", "tsx");
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("acquire → checkpoint → release happy path", async () => {
    const adapter = new ObsidianKanbanAdapter(vault);
    await adapter.init({ vaultPath: vault });
    const ref = await adapter.createTicket("P", { type: "task", title: "X" });
    await adapter.updateTicket(ref, { status: "Todo" });

    const acq = await run([
      "acquire",
      "--project",
      "P",
      "--id",
      ref.id,
      "--owner",
      "alice@dispatch-1",
    ]);
    expect(acq.code).toBe(0);
    const acqResult = JSON.parse(acq.stdout.trim()) as {
      lock_token: string;
      recovered_checkpoint: unknown;
      system_addendum: string;
    };
    expect(typeof acqResult.lock_token).toBe("string");
    expect(acqResult.lock_token.length).toBeGreaterThan(0);
    expect(acqResult.recovered_checkpoint).toBeNull();
    // The addendum must name the protocol skill and inline its body.
    expect(acqResult.system_addendum).toContain("Use skill team-tracking-execute");
    expect(acqResult.system_addendum).toContain("--- team-tracking-execute ---");

    const cp = await run([
      "checkpoint",
      "--project",
      "P",
      "--id",
      ref.id,
      "--token",
      acqResult.lock_token,
      "--commit",
      "abc1234",
      "--update",
      "halfway",
      "--progress",
      "flow drafted",
    ]);
    expect(cp.code).toBe(0);
    expect(cp.stdout.trim()).toBe('"ok"');

    const rel = await run([
      "release",
      "--project",
      "P",
      "--id",
      ref.id,
      "--token",
      acqResult.lock_token,
      "--status",
      "Done",
    ]);
    expect(rel.code).toBe(0);
    expect(rel.stdout.trim()).toBe('"ok"');

    // Verify final state via the adapter.
    const after = await adapter.getTicket(ref);
    expect(after?.status).toBe("Done");
    expect(after?.lock).toBeNull();
  }, 30_000);

  it("log subcommand needs no lock token and emits a `log` event", async () => {
    const adapter = new ObsidianKanbanAdapter(vault);
    await adapter.init({ vaultPath: vault });
    const ref = await adapter.createTicket("P", { type: "task", title: "X" });

    const r = await run([
      "log",
      "--project",
      "P",
      "--id",
      ref.id,
      "--line",
      "decided to use Y because Z",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('"ok"');

    const events = await adapter.readEvents(ref);
    const logEv = events.find((e) => e.type === "log");
    expect(logEv).toBeDefined();
    if (logEv?.type !== "log") return;
    expect(logEv.line).toBe("decided to use Y because Z");
  }, 30_000);

  it("missing required arg → JSON error envelope, exit 0", async () => {
    const r = await run(["acquire", "--project", "P"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { error?: string };
    expect(parsed.error).toContain("missing --id");
  }, 30_000);
});
