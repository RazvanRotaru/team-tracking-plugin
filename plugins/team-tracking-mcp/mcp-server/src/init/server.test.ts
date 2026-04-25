import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/loader.js";
import { runInitWeb } from "./server.js";

describe("init web server", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-web-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("serves index.html on the tokenised URL and saves a posted config", async () => {
    const target = path.join(dir, ".team-tracking", "config.json");
    let urlCaptured = "";
    const done = runInitWeb({
      configPath: target,
      noBrowser: true,
      onUrl: (u) => {
        urlCaptured = u;
      },
      repoRoot: dir,
    });

    // Give the listen callback a tick to fire.
    await new Promise((r) => setImmediate(r));
    expect(urlCaptured).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+$/);

    // GET / with token → 200 HTML, with the token rewritten onto subresource
    // refs so the browser doesn't drop it on the relative CSS/JS fetches.
    const html = await fetch(urlCaptured);
    expect(html.status).toBe(200);
    const htmlText = await html.text();
    const u0 = new URL(urlCaptured);
    const tokenStr = u0.searchParams.get("t") ?? "";
    expect(htmlText).toContain("team-tracking-mcp");
    expect(htmlText).toContain(`href="style.css?t=${tokenStr}"`);
    expect(htmlText).toContain(`src="app.js?t=${tokenStr}"`);

    // GET /style.css with token → 200 CSS
    const css = await fetch(`${u0.origin}/style.css?t=${tokenStr}`);
    expect(css.status).toBe(200);

    // GET / without token → 401
    const noToken = await fetch(urlCaptured.replace(/\?.*/, ""));
    expect(noToken.status).toBe(401);

    // POST /save with token → 200 JSON
    const u = new URL(urlCaptured);
    const save = await fetch(`${u.origin}/save?t=${u.searchParams.get("t")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        adapter: "obsidian-kanban",
        adapterConfig: { vaultPath: path.join(dir, "vault") },
        projects: [{ name: "Acme", adapterProjectRef: "projects/Acme" }],
        lockTtlSeconds: 1800,
      }),
    });
    expect(save.status).toBe(200);

    const result = await done;
    expect(result.configPath).toBe(target);
    expect(result.config.adapter).toBe("obsidian-kanban");
    const reloaded = await loadConfig(target);
    if (reloaded.adapter !== "obsidian-kanban") throw new Error("expected obsidian-kanban");
    expect(reloaded.adapterConfig.vaultPath).toBe(path.join(dir, "vault"));
  }, 10_000);

  it("rejects malformed config with 400", async () => {
    const target = path.join(dir, ".team-tracking", "config.json");
    let urlCaptured = "";
    const done = runInitWeb({
      configPath: target,
      noBrowser: true,
      onUrl: (u) => {
        urlCaptured = u;
      },
      repoRoot: dir,
    });
    await new Promise((r) => setImmediate(r));

    const u = new URL(urlCaptured);
    const bad = await fetch(`${u.origin}/save?t=${u.searchParams.get("t")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, adapter: "wat" }),
    });
    expect(bad.status).toBe(400);

    // Now post a valid one to let the server resolve and shut down.
    const ok = await fetch(`${u.origin}/save?t=${u.searchParams.get("t")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        adapter: "obsidian-kanban",
        adapterConfig: { vaultPath: dir },
        projects: [{ name: "P", adapterProjectRef: "projects/P" }],
        lockTtlSeconds: 1800,
      }),
    });
    expect(ok.status).toBe(200);
    await done;
  }, 10_000);
});
