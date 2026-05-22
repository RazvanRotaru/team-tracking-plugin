import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JiraAdapter, JiraWebhookReceiver } from "./adapters/jira/index.js";
import { ObsidianKanbanAdapter } from "./adapters/obsidian-kanban/index.js";
import type { TrackerAdapter } from "./adapters/types.js";
import { type Config, loadConfig } from "./config/loader.js";
import { RefMutex } from "./server/mutex.js";
import { TicketService } from "./server/service.js";
import { registerTools } from "./server/tools.js";

export const VERSION = "0.0.1";

/**
 * Read a SKILL.md from the plugin's `skills/` tree relative to this
 * bundle. Returns null if the file isn't there (test harnesses bundling
 * just the server, e.g.) so callers can fall back to a name-only
 * addendum without crashing.
 */
function readSkillBody(skillName: string): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../../skills/<name>/SKILL.md
    // src/index.ts (tsx) → ../skills/<name>/SKILL.md
    const candidates = [
      path.resolve(here, "..", "..", "skills", skillName, "SKILL.md"),
      path.resolve(here, "..", "skills", skillName, "SKILL.md"),
    ];
    for (const p of candidates) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        /* try next candidate */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Adapter plus auxiliary lifecycle resources (currently the optional
 * Jira webhook receiver). Callers MUST call `dispose` on shutdown —
 * otherwise the HTTP server keeps the process alive.
 */
export type BuiltAdapter = {
  adapter: TrackerAdapter;
  dispose: () => Promise<void>;
};

export async function buildAdapter(config: Config): Promise<BuiltAdapter> {
  if (config.adapter === "obsidian-kanban") {
    const a = new ObsidianKanbanAdapter(config.adapterConfig.vaultPath);
    await a.init({
      // Forward the adapter-level config plus the top-level projects list so
      // the adapter can resolve per-project `useSharedBoard` flags. The
      // discriminated-union shape means `sharedBoard` is `undefined` when
      // omitted, which the adapter treats as "shared mode off".
      ...config.adapterConfig,
      projects: config.projects,
    });
    return { adapter: a, dispose: async () => {} };
  }
  if (config.adapter === "jira") {
    const cfg = config.adapterConfig;
    let receiver: JiraWebhookReceiver | null = null;
    if (cfg.webhookPort) {
      receiver = new JiraWebhookReceiver();
      await receiver.start(cfg.webhookPort, cfg.webhookHost ?? "127.0.0.1");
    }
    const a = new JiraAdapter({
      baseUrl: cfg.baseUrl,
      email: cfg.email,
      apiToken: cfg.apiToken,
      statusMap: cfg.statusMap,
      customFieldIds: cfg.customFieldIds,
      projects: config.projects,
      watchPollMs: cfg.watchPollMs,
      webhookReceiver: receiver ?? undefined,
    });
    await a.init({});
    return {
      adapter: a,
      dispose: async () => {
        if (receiver) await receiver.stop();
      },
    };
  }
  throw new Error("unknown adapter type");
}

export function buildServer(adapter: TrackerAdapter, ttlSeconds: number): McpServer {
  const mutex = new RefMutex();
  const executeBody = readSkillBody("team-tracking-execute");
  const service = new TicketService(adapter, mutex, {
    ttlSeconds,
    now: () => new Date().toISOString(),
    mintToken: () => `tok_${randomUUID()}`,
    mintMessageId: () => `msg_${randomUUID()}`,
    mintEventId: () => `evt_${randomUUID()}`,
    executorSkills: [{ name: "team-tracking-execute", body: executeBody ?? undefined }],
  });
  const server = new McpServer(
    { name: "team-tracking-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, service);
  return server;
}

export async function main(): Promise<void> {
  const config = await loadConfig();
  const built = await buildAdapter(config);
  const server = buildServer(built.adapter, config.lockTtlSeconds);
  const transport = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    await built.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  await server.connect(transport);
}

const isEntry = (() => {
  try {
    // process.argv[1] resolved against module url. Best-effort entry detection
    // that works for both `node dist/index.js` and `tsx src/index.ts`.
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url.endsWith(argv1) || import.meta.url.endsWith(`${argv1}.js`);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((err) => {
    console.error("[team-tracking-mcp] fatal:", err);
    process.exit(1);
  });
}
