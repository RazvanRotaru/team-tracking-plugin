// Populate the Demo project with the structure a real harness-orchestrate
// run produces. Every task is decomposed into pipeline subtasks; the
// orchestrator picks which stages apply per task. The lock + checkpoint
// belong to the active implementation subtask, not to the task itself.
//
// What the demo surfaces:
//   - Epic with story → task → pipeline subtasks (full TDD pipeline)
//   - Story with task → pipeline subtasks (no-TDD variant)
//   - Top-level task with multiple code reviewers (orchestrator-decided)
//   - In-progress implementation subtask carrying a recorded checkpoint
//   - A Done task with all subtasks complete
//
// Idempotent only on a fresh vault. Run after the headless init.

import { randomUUID } from "node:crypto";
import { loadConfig } from "../dist/config/loader.js";
import { buildAdapter } from "../dist/index.js";

const config = await loadConfig();
const adapter = await buildAdapter(config);
const project = config.projects[0].name;

// Helpers ────────────────────────────────────────────────────────────
const createT = (draft) => adapter.createTicket(project, draft);
const setStatus = (ref, status) => adapter.updateTicket(ref, { status });
const setBranch = (ref, branch) => adapter.updateTicket(ref, { branch });

async function fullPipeline(taskRef, prefix = "") {
  // Standard 5-stage pipeline. Defaults: all Todo. Caller drives statuses.
  const tests = await createT({
    type: "subtask",
    parent: taskRef,
    title: `${prefix}Write integration tests`,
    priority: "P1",
  });
  const testReview = await createT({
    type: "subtask",
    parent: taskRef,
    title: `${prefix}Adversarial test review`,
    priority: "P1",
  });
  const impl = await createT({
    type: "subtask",
    parent: taskRef,
    title: `${prefix}Implement`,
    priority: "P0",
  });
  const specReview = await createT({
    type: "subtask",
    parent: taskRef,
    title: `${prefix}Spec compliance review`,
    priority: "P1",
  });
  const codeReview = await createT({
    type: "subtask",
    parent: taskRef,
    title: `${prefix}Adversarial code review`,
    priority: "P1",
  });
  return { tests, testReview, impl, specReview, codeReview };
}

async function minimalPipeline(taskRef) {
  // Orchestrator chose: skip TDD, just implement + one review.
  const impl = await createT({
    type: "subtask",
    parent: taskRef,
    title: "Implement",
    priority: "P0",
  });
  const codeReview = await createT({
    type: "subtask",
    parent: taskRef,
    title: "Adversarial code review",
    priority: "P1",
  });
  return { impl, codeReview };
}

// 1. Epic with two stories ────────────────────────────────────────────

const epic = await createT({
  type: "epic",
  title: "Onboarding flow",
  body:
    "Multi-slice initiative: get a new user from signup to a usable account.\n" +
    "Decomposed into stories per onboarding step.",
  priority: "P1",
});
await setStatus(epic, "In Progress");

const storyEmail = await createT({
  type: "story",
  parent: epic,
  title: "Email verification",
  priority: "P0",
});
await setStatus(storyEmail, "In Progress");

// First task under the email story: full pipeline, mid-implementation.
const taskSendEmail = await createT({
  type: "task",
  parent: storyEmail,
  title: "Send verification email",
  priority: "P0",
});
await setStatus(taskSendEmail, "In Progress");
await setBranch(taskSendEmail, "feat/send-verification");
const sendStages = await fullPipeline(taskSendEmail);
await setStatus(sendStages.tests, "Done");
await setStatus(sendStages.testReview, "Done");
await setStatus(sendStages.impl, "In Progress");
await adapter.writeProgress(sendStages.impl, {
  update: "wiring SMTP provider",
  progress_summary: "queue config done; need retry policy",
});
await adapter.writeLock(sendStages.impl, {
  owner: "implementer@subagent-7",
  token: `tok_${randomUUID()}`,
  acquired_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  last_checkpoint: {
    commit_id: "9d2f1ab",
    update: "happy path through SMTP queue",
    progress_summary: "config + 4 tests green; retry policy outstanding",
    at: new Date(Date.now() - 60_000).toISOString(),
  },
});
// (specReview + codeReview remain Todo — implementer hasn't handed off yet.)

// Second task under the email story: orchestrator skipped TDD here.
const taskLanding = await createT({
  type: "task",
  parent: storyEmail,
  title: "Click-through landing page",
  priority: "P1",
});
await minimalPipeline(taskLanding);

// Second story under the epic.
const storySso = await createT({
  type: "story",
  parent: epic,
  title: "Google SSO",
  priority: "P1",
});
await setStatus(storySso, "Todo");

// Task under SSO: full pipeline, plus an extra reviewer.
const taskOauth = await createT({
  type: "task",
  parent: storySso,
  title: "OAuth flow",
  priority: "P0",
});
const oauthStages = await fullPipeline(taskOauth);
await createT({
  type: "subtask",
  parent: taskOauth,
  title: "Adversarial code review (security focus)",
  priority: "P0",
});
void oauthStages;

// 2. Top-level story (no parent epic) with one task ───────────────────

const storySettings = await createT({
  type: "story",
  title: "Settings page",
  priority: "P1",
});
await setStatus(storySettings, "Todo");

const taskProfile = await createT({
  type: "task",
  parent: storySettings,
  title: "Profile fields",
  priority: "P1",
});
await fullPipeline(taskProfile);

// 3. Top-level task with the active checkpoint ────────────────────────

const taskApi = await createT({
  type: "task",
  title: "Refresh API schemas",
  priority: "P0",
});
await setStatus(taskApi, "In Progress");
await setBranch(taskApi, "feat/refresh-schemas");

const apiStages = await fullPipeline(taskApi);
await setStatus(apiStages.tests, "Done");
await setStatus(apiStages.testReview, "Done");
await setStatus(apiStages.impl, "In Progress");
await adapter.writeProgress(apiStages.impl, {
  update: "regenerating openapi.yaml",
  progress_summary: "v3 spec drafted; examples need backfill",
});
await adapter.writeLock(apiStages.impl, {
  owner: "schema-bot@subagent-42",
  token: `tok_${randomUUID()}`,
  acquired_at: new Date(Date.now() - 8 * 60_000).toISOString(),
  last_checkpoint: {
    commit_id: "a1b2c3d",
    update: "regenerated openapi.yaml from contract types",
    progress_summary: "spec rebuilt; 12 endpoints covered, examples pending",
    at: new Date(Date.now() - 90_000).toISOString(),
  },
});

// 4. A Done task — every pipeline subtask Done ────────────────────────

const taskSpike = await createT({
  type: "task",
  title: "Spike: shortlist email providers",
  priority: "P2",
});
const investigate = await createT({
  type: "subtask",
  parent: taskSpike,
  title: "Investigate provider options",
  priority: "P2",
});
const findings = await createT({
  type: "subtask",
  parent: taskSpike,
  title: "Write findings doc",
  priority: "P2",
});
const peer = await createT({
  type: "subtask",
  parent: taskSpike,
  title: "Peer review",
  priority: "P2",
});
await setStatus(investigate, "Done");
await setStatus(findings, "Done");
await setStatus(peer, "Done");
await setStatus(taskSpike, "Done");

console.log("populated:");
for (const r of [
  epic,
  storyEmail,
  taskSendEmail,
  taskLanding,
  storySso,
  taskOauth,
  storySettings,
  taskProfile,
  taskApi,
  taskSpike,
]) {
  console.log(`  ${r.project}/${r.id}`);
}
