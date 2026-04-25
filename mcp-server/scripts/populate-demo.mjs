// Populate the Demo project with a richer example covering:
//   - epic with stories (and tasks/subtasks nested below)
//   - top-level story with tasks
//   - top-level task with subtasks
//   - an in-progress task showing live progress fields and a recorded
//     checkpoint (lock_state: "committed")
//
// Idempotent only on a fresh vault. Run after the headless init.

import { randomUUID } from "node:crypto";
import { buildAdapter } from "../dist/index.js";
import { loadConfig } from "../dist/config/loader.js";

const config = await loadConfig();
const adapter = await buildAdapter(config);
const project = config.projects[0].name;

// ────────────────────────────────────────────────────────────────────
// 1. Top-level epic with two stories. Each story has a task; one task
//    has subtasks. The board card for the epic surfaces the stories.
// ────────────────────────────────────────────────────────────────────

const epic = await adapter.createTicket(project, {
  type: "epic",
  title: "Onboarding flow",
  body: "Top-level container for the new-user onboarding work.",
  priority: "P1",
});
await adapter.updateTicket(epic, { status: "In Progress" });

const storyEmail = await adapter.createTicket(project, {
  type: "story",
  parent: epic,
  title: "Email verification",
  priority: "P0",
});
await adapter.updateTicket(storyEmail, { status: "In Progress" });

const taskSendEmail = await adapter.createTicket(project, {
  type: "task",
  parent: storyEmail,
  title: "Send verification email",
  priority: "P0",
});
await adapter.updateTicket(taskSendEmail, { status: "In Progress" });

await adapter.createTicket(project, {
  type: "subtask",
  parent: taskSendEmail,
  title: "Render templates",
  priority: "P1",
});
await adapter.createTicket(project, {
  type: "subtask",
  parent: taskSendEmail,
  title: "Wire SMTP queue",
  priority: "P1",
});

const storySso = await adapter.createTicket(project, {
  type: "story",
  parent: epic,
  title: "Google SSO",
  priority: "P1",
});
await adapter.updateTicket(storySso, { status: "Todo" });

// ────────────────────────────────────────────────────────────────────
// 2. Top-level story with two tasks. The story's card surfaces the
//    tasks as sub-bullets.
// ────────────────────────────────────────────────────────────────────

const settingsStory = await adapter.createTicket(project, {
  type: "story",
  title: "Settings page",
  priority: "P1",
});
await adapter.updateTicket(settingsStory, { status: "Todo" });

await adapter.createTicket(project, {
  type: "task",
  parent: settingsStory,
  title: "Profile fields",
  priority: "P1",
});
await adapter.createTicket(project, {
  type: "task",
  parent: settingsStory,
  title: "Notification toggles",
  priority: "P2",
});

// ────────────────────────────────────────────────────────────────────
// 3. Top-level task with two subtasks. The task's card surfaces the
//    subtasks.
// ────────────────────────────────────────────────────────────────────

const reviewerTask = await adapter.createTicket(project, {
  type: "task",
  title: "Pick a copy reviewer",
  priority: "P2",
});
// Leaves at default Backlog.

const briefSub = await adapter.createTicket(project, {
  type: "subtask",
  parent: reviewerTask,
  title: "Write the brief",
  priority: "P2",
});
await adapter.createTicket(project, {
  type: "subtask",
  parent: reviewerTask,
  title: "Send to ops",
  priority: "P2",
});
// Mark one subtask Done to show the [x] tick propagating into the parent
// task's Children section AND into the parent's card sub-bullet.
await adapter.updateTicket(briefSub, { status: "Done" });

// ────────────────────────────────────────────────────────────────────
// 4. In-progress top-level task with a live lock + checkpoint, so the
//    card shows lock_state: "committed" and the visible progress fields
//    are populated.
// ────────────────────────────────────────────────────────────────────

const apiTask = await adapter.createTicket(project, {
  type: "task",
  title: "Refresh API schemas",
  priority: "P0",
});
await adapter.updateTicket(apiTask, {
  status: "In Progress",
  branch: "feat/refresh-schemas",
});
await adapter.writeProgress(apiTask, {
  update: "regenerating openapi.yaml",
  progress_summary: "v3 spec drafted; examples need backfill",
});
// Simulate a specialist that has already committed once.
await adapter.writeLock(apiTask, {
  owner: "schema-bot@subagent-42",
  token: `tok_${randomUUID()}`,
  acquired_at: new Date(Date.now() - 60_000).toISOString(),
  last_checkpoint: {
    commit_id: "a1b2c3d",
    update: "regenerating openapi.yaml",
    progress_summary: "v3 spec drafted; examples need backfill",
    at: new Date().toISOString(),
  },
});

// ────────────────────────────────────────────────────────────────────
// 5. A done task, just to populate the rightmost column.
// ────────────────────────────────────────────────────────────────────

const doneTask = await adapter.createTicket(project, {
  type: "task",
  title: "Spike: shortlist email providers",
  priority: "P2",
});
await adapter.updateTicket(doneTask, { status: "Done" });

console.log("populated:");
for (const r of [epic, storyEmail, taskSendEmail, storySso, settingsStory, reviewerTask, apiTask, doneTask]) {
  console.log(`  ${r.project}/${r.id}`);
}
