import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

export const ObsidianAdapterConfigSchema = z.object({
  vaultPath: z.string().min(1),
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
});

export const ProjectEntrySchema = z.object({
  name: z.string().min(1),
  adapterProjectRef: z.string().min(1),
});

export const ConfigSchema = z.discriminatedUnion("adapter", [
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
]);

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
