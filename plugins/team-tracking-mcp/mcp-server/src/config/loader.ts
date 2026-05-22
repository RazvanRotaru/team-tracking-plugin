import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export const SharedBoardConfigSchema = z.object({
  /** Vault-relative path to the shared board.md file. e.g. "shared/board.md". */
  path: z.string().min(1),
  /** Vault-relative lockfile path. Defaults to `${path}.lock` when omitted. */
  lockfilePath: z.string().min(1).optional(),
});

export const ObsidianAdapterConfigSchema = z.object({
  vaultPath: z.string().min(1),
  /**
   * When set, opted-in projects (default: all) write their board cards to a
   * single shared board.md instead of per-project board.md files. The
   * project's ticket folder layout is unchanged. Cross-process writes are
   * serialised via an advisory lockfile.
   */
  sharedBoard: SharedBoardConfigSchema.optional(),
});

export const JiraAdapterConfigSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  statusMap: z.record(z.string(), z.string()),
  customFieldIds: z
    .object({
      update: z.string().optional(),
      progress_summary: z.string().optional(),
      lock: z.string().optional(),
      scope: z.string().optional(),
      branch: z.string().optional(),
    })
    .partial()
    .optional(),
  /**
   * When set, the MCP server / listen CLI will start a JiraWebhookReceiver
   * on this port and use it for push delivery. Configure Jira to POST
   * `comment_created` events to `http://<host>:<port>/webhook`. When
   * unset, the adapter falls back to polling.
   */
  webhookPort: z.number().int().positive().optional(),
  /** Bind interface for the webhook receiver. Defaults to 127.0.0.1. */
  webhookHost: z.string().optional(),
  /** Polling interval (ms) when no webhookPort is configured. */
  watchPollMs: z.number().int().positive().optional(),
});

export const ProjectEntrySchema = z.object({
  name: z.string().min(1),
  adapterProjectRef: z.string().min(1),
  /**
   * Per-project opt-out for shared-board mode. Only meaningful when the
   * adapter has `sharedBoard` configured. Defaults to true (project shares
   * the board) when sharedBoard is set; ignored when it isn't.
   */
  useSharedBoard: z.boolean().optional(),
});

export const ConfigSchema = z
  .discriminatedUnion("adapter", [
    z.object({
      version: z.literal(1),
      adapter: z.literal("obsidian-kanban"),
      adapterConfig: ObsidianAdapterConfigSchema,
      projects: z.array(ProjectEntrySchema),
      lockTtlSeconds: z.number().int().positive().default(1800),
    }),
    z.object({
      version: z.literal(1),
      adapter: z.literal("jira"),
      adapterConfig: JiraAdapterConfigSchema,
      projects: z.array(ProjectEntrySchema),
      lockTtlSeconds: z.number().int().positive().default(1800),
    }),
  ])
  .superRefine((cfg, ctx) => {
    if (cfg.adapter !== "obsidian-kanban") return;
    const shared = cfg.adapterConfig.sharedBoard;
    if (!shared) return;
    const norm = shared.path.replace(/^\/+/, "");
    if (norm.startsWith("projects/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adapterConfig", "sharedBoard", "path"],
        message:
          "sharedBoard.path must not live under projects/ (it would collide with a per-project board.md)",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const CONFIG_DIR_NAME = ".team-tracking";
export const CONFIG_FILE_NAME = "config.json";

export function defaultConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

export async function loadConfig(file?: string): Promise<Config> {
  const target = file ?? defaultConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`team-tracking config not found at ${target} (run /team-tracking:init)`);
    }
    throw e;
  }
  const parsed = JSON.parse(raw);
  return ConfigSchema.parse(parsed);
}

export async function saveConfig(config: Config, file?: string): Promise<string> {
  const target = file ?? defaultConfigPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
  return target;
}
