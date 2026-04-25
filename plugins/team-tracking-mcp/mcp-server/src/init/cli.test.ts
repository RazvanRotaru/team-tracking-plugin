import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import { runHeadlessInit } from "./cli.js";

describe("runHeadlessInit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-init-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a valid obsidian config", async () => {
    const target = path.join(dir, ".team-tracking", "config.json");
    const r = await runHeadlessInit([
      "--adapter",
      "obsidian-kanban",
      "--vault",
      path.join(dir, "vault"),
      "--project",
      "Acme",
      "--config",
      target,
      "--no-gitignore",
    ]);
    expect(r.configPath).toBe(target);
    const loaded = await loadConfig(target);
    expect(loaded.adapter).toBe("obsidian-kanban");
    expect(loaded.projects[0]?.name).toBe("Acme");
  });

  it("writes a valid jira config", async () => {
    const target = path.join(dir, ".team-tracking", "config.json");
    const r = await runHeadlessInit([
      "--adapter",
      "jira",
      "--jira-base-url",
      "https://acme.atlassian.net",
      "--jira-email",
      "user@acme.com",
      "--jira-api-token",
      "secret",
      "--project",
      "Acme",
      "--project-ref",
      "ACME",
      "--config",
      target,
      "--no-gitignore",
    ]);
    expect(r.configPath).toBe(target);
    const loaded = await loadConfig(target);
    if (loaded.adapter !== "jira") throw new Error("expected jira");
    expect(loaded.adapterConfig.baseUrl).toBe("https://acme.atlassian.net");
    expect(loaded.projects[0]?.adapterProjectRef).toBe("ACME");
  });

  it("updates .gitignore in a git repo by default", async () => {
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    const target = path.join(dir, ".team-tracking", "config.json");
    const r = await runHeadlessInit([
      "--adapter",
      "obsidian-kanban",
      "--vault",
      path.join(dir, "vault"),
      "--config",
      target,
    ]);
    expect(r.gitignoreUpdated).toBe(true);
    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".team-tracking/");
  });

  it("rejects missing --adapter", async () => {
    await expect(runHeadlessInit([])).rejects.toThrow(/--adapter/);
  });

  it("rejects obsidian without --vault", async () => {
    await expect(runHeadlessInit(["--adapter", "obsidian-kanban"])).rejects.toThrow(/--vault/);
  });
});
