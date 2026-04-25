// One-off: populate the Demo project with a small example so the board
// renders something interesting in Obsidian. Idempotent only on a fresh vault.
import { buildAdapter } from "../dist/index.js";
import { loadConfig } from "../dist/config/loader.js";

const config = await loadConfig();
const adapter = await buildAdapter(config);
const project = config.projects[0].name;

const epic = await adapter.createTicket(project, {
  type: "epic",
  title: "Onboarding flow",
  body: "Top-level container for the new-user onboarding work.",
  priority: "P1",
});
await adapter.updateTicket(epic, { status: "In Progress" });

const story = await adapter.createTicket(project, {
  type: "story",
  parent: epic,
  title: "Email verification",
  priority: "P0",
});
await adapter.updateTicket(story, { status: "Todo" });

const sub1 = await adapter.createTicket(project, {
  type: "subtask",
  parent: story,
  title: "Send verification email",
  priority: "P0",
});

const sub2 = await adapter.createTicket(project, {
  type: "subtask",
  parent: story,
  title: "Click-through landing page",
  priority: "P1",
});

const standalone = await adapter.createTicket(project, {
  type: "task",
  title: "Pick a copy reviewer",
  priority: "P2",
});
await adapter.updateTicket(standalone, { status: "Backlog" });

const done = await adapter.createTicket(project, {
  type: "task",
  title: "Spike: shortlist email providers",
  priority: "P2",
});
await adapter.updateTicket(done, { status: "Done" });

await adapter.writeProgress(sub1, {
  update: "drafting templates",
  progress_summary: "two variants in review",
});

console.log("created tickets:");
for (const r of [epic, story, sub1, sub2, standalone, done]) {
  console.log(`  ${r.project}/${r.id}`);
}
