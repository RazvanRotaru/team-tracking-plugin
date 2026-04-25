// Copy non-TS assets (HTML/CSS/JS for the init webpage) from src/ → dist/.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src", "init", "web");
const dest = path.resolve(here, "..", "dist", "init", "web");

await fs.mkdir(dest, { recursive: true });
const entries = await fs.readdir(src, { withFileTypes: true });
for (const e of entries) {
  if (!e.isFile()) continue;
  await fs.copyFile(path.join(src, e.name), path.join(dest, e.name));
  process.stdout.write(`copied init web asset: ${e.name}\n`);
}
