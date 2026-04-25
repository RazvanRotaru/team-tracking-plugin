import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "./loader.js";

export const GITIGNORE_LINE = `${CONFIG_DIR_NAME}/`;

/**
 * Ensure `<repo>/.gitignore` lists `.team-tracking/`. Creates the file if
 * missing. Idempotent: running twice doesn't duplicate the line.
 */
export async function ensureGitignored(repoRoot: string): Promise<{
  changed: boolean;
  path: string;
}> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(GITIGNORE_LINE) || lines.includes(CONFIG_DIR_NAME)) {
    return { changed: false, path: gitignorePath };
  }

  const trailingNewline = existing.length === 0 || existing.endsWith("\n");
  const sep = trailingNewline ? "" : "\n";
  const next = `${existing}${sep}${GITIGNORE_LINE}\n`;
  await fs.writeFile(gitignorePath, next, "utf8");
  return { changed: true, path: gitignorePath };
}

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(repoRoot, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
}
