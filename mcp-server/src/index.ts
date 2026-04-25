import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JiraAdapter } from "./adapters/jira/index.js";
import { ObsidianKanbanAdapter } from "./adapters/obsidian-kanban/index.js";
import type { TrackerAdapter } from "./adapters/types.js";
import { type Config, loadConfig } from "./config/loader.js";
import { RefMutex } from "./server/mutex.js";
import { TicketService } from "./server/service.js";
import { registerTools } from "./server/tools.js";

export const VERSION = "0.0.1";

export async function buildAdapter(config: Config): Promise<TrackerAdapter> {
  if (config.adapter === "obsidian-kanban") {
    const a = new ObsidianKanbanAdapter(config.adapterConfig.vaultPath);
    await a.init(config.adapterConfig);
    return a;
  }
  if (config.adapter === "jira") {
    const a = new JiraAdapter({
      baseUrl: config.adapterConfig.baseUrl,
      email: config.adapterConfig.email,
      apiToken: config.adapterConfig.apiToken,
      statusMap: config.adapterConfig.statusMap,
      customFieldIds: config.adapterConfig.customFieldIds,
      projects: config.projects,
    });
    await a.init({});
    return a;
  }
  throw new Error("unknown adapter type");
}

export function buildServer(adapter: TrackerAdapter, ttlSeconds: number): McpServer {
  const mutex = new RefMutex();
  const service = new TicketService(adapter, mutex, {
    ttlSeconds,
    now: () => new Date().toISOString(),
    mintToken: () => `tok_${randomUUID()}`,
    mintMessageId: () => `msg_${randomUUID()}`,
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
  const adapter = await buildAdapter(config);
  const server = buildServer(adapter, config.lockTtlSeconds);
  const transport = new StdioServerTransport();
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
