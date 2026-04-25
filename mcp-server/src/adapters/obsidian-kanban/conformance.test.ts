import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runConformance } from "../conformance.js";
import { ObsidianKanbanAdapter } from "./index.js";

runConformance("obsidian-kanban", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-obs-"));
  const adapter = new ObsidianKanbanAdapter(dir);
  await adapter.init({ vaultPath: dir });
  return {
    adapter,
    project: "TestProj",
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
});
