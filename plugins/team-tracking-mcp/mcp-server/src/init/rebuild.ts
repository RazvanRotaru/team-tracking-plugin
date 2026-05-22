import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import { type Config, loadConfig } from "../config/loader.js";
import { buildAdapter } from "../index.js";

export function rebuildUsage(): string {
  return `usage: team-tracking rebuild-shared-board

Recompute the shared board.md from the underlying ticket files. Use this when
the shared board file is missing, corrupted, or has drifted from the ticket
store (e.g. after a crash mid-write, or after manually editing it).

Reads .team-tracking/config.json from the current working directory. Only
projects with \`useSharedBoard: true\` (the default when \`sharedBoard\` is set)
contribute cards.
`;
}

export async function runRebuildSharedBoard(): Promise<number> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: (e as Error).message })}\n`);
    return 0;
  }

  if (config.adapter !== "obsidian-kanban") {
    process.stdout.write(
      `${JSON.stringify({ error: "rebuild-shared-board only applies to the obsidian-kanban adapter" })}\n`,
    );
    return 0;
  }
  if (!config.adapterConfig.sharedBoard) {
    process.stdout.write(
      `${JSON.stringify({ error: "no sharedBoard configured; nothing to rebuild" })}\n`,
    );
    return 0;
  }

  const built = await buildAdapter(config);
  try {
    if (!(built.adapter instanceof ObsidianKanbanAdapter)) {
      process.stdout.write(
        `${JSON.stringify({ error: "adapter did not resolve to ObsidianKanbanAdapter" })}\n`,
      );
      return 0;
    }
    await built.adapter.rebuildSharedBoard();
    process.stdout.write(
      `${JSON.stringify({ ok: true, path: config.adapterConfig.sharedBoard.path })}\n`,
    );
    return 0;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: (e as Error).message })}\n`);
    return 0;
  } finally {
    await built.dispose();
  }
}
