import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignored } from "./gitignore.js";
import { type Config, loadConfig, saveConfig } from "./loader.js";

describe("config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-cfg-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("save → load roundtrip (obsidian)", async () => {
    const cfg: Config = {
      version: 1,
      adapter: "obsidian-kanban",
      adapterConfig: { vaultPath: path.join(dir, "vault") },
      projects: [{ name: "Autopilot", adapterProjectRef: "projects/Autopilot" }],
      lockTtlSeconds: 1800,
    };
    const target = path.join(dir, ".team-tracking", "config.json");
    await saveConfig(cfg, target);
    const loaded = await loadConfig(target);
    expect(loaded).toEqual(cfg);
  });

  it("loadConfig surfaces a clear error when file is missing", async () => {
    await expect(loadConfig(path.join(dir, "nope.json"))).rejects.toThrow(/config not found/);
  });

  it("rejects malformed config", async () => {
    const target = path.join(dir, "bad.json");
    await fs.writeFile(target, JSON.stringify({ version: 1, adapter: "wat" }), "utf8");
    await expect(loadConfig(target)).rejects.toThrow();
  });
});

describe("ensureGitignored", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-gi-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates .gitignore if missing", async () => {
    const r = await ensureGitignored(dir);
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(text).toContain(".team-tracking/");
  });

  it("appends to existing .gitignore preserving prior content", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\ndist\n", "utf8");
    const r = await ensureGitignored(dir);
    expect(r.changed).toBe(true);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    expect(text.split("\n")).toContain("node_modules");
    expect(text.split("\n")).toContain(".team-tracking/");
  });

  it("is idempotent", async () => {
    await ensureGitignored(dir);
    const r2 = await ensureGitignored(dir);
    expect(r2.changed).toBe(false);
    const text = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
    const occurrences = text.split("\n").filter((l) => l.trim() === ".team-tracking/").length;
    expect(occurrences).toBe(1);
  });

  it("respects pre-existing entry without trailing slash", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), ".team-tracking\n", "utf8");
    const r = await ensureGitignored(dir);
    expect(r.changed).toBe(false);
  });
});
