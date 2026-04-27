export type TicketType = "epic" | "story" | "task" | "subtask";
export type Priority = "P0" | "P1" | "P2";
export type LockState = "free" | "in_progress" | "committed";

export type TicketRef = { project: string; id: string };

export type Checkpoint = {
  commit_id: string;
  update: string | null;
  progress_summary: string | null;
  at: string;
};

export type Lock = {
  owner: string;
  token: string;
  acquired_at: string;
  last_checkpoint: Checkpoint | null;
};

export type TicketDTO = {
  ref: TicketRef;
  type: TicketType;
  parent: TicketRef | null;
  title: string;
  body: string;
  status: string;
  priority: Priority;
  labels: string[];
  scope: string | null;
  branch: string | null;
  pr_url: string | null;
  update: string | null;
  progress_summary: string | null;
  lock_state: LockState;
  lock: Lock | null;
  created: string;
  updated: string;
  children: TicketRef[];
};

export type TicketSummaryDTO = {
  ref: TicketRef;
  type: TicketType;
  title: string;
  status: string;
  priority: Priority;
  scope: string | null;
  branch: string | null;
  update: string | null;
  lock_state: LockState;
};

export type CreateTicketDTO = {
  type: TicketType;
  parent?: TicketRef;
  title: string;
  body?: string;
  priority?: Priority;
  labels?: string[];
  scope?: string;
};

export type UpdateDTO = Partial<
  Pick<
    TicketDTO,
    "title" | "body" | "status" | "priority" | "labels" | "scope" | "branch" | "pr_url"
  >
>;

export type ReportProgressDTO = {
  status?: string;
  update?: string;
  progress_summary?: string;
};

export type CommitCheckpointDTO = {
  commit_id: string;
  update?: string;
  progress_summary?: string;
};

/**
 * Per-ticket steering message. Lives inside the unified event log as a
 * `message` event; this type is the projection used by the existing
 * post_message / read_messages tools and by external readers that want
 * just the human-readable conversation.
 *
 * `kind` is free-text; common values are `nudge`, `question`, `response`,
 * `ack`, `info`. Skills define the conventions; the server does not enforce.
 */
export type Message = {
  id: string; // server-minted, e.g. "msg_<uuid>"
  at: string; // ISO-8601
  from: string; // free-text role identifier (e.g. "orchestrator")
  kind: string; // free-text; convention: nudge|question|response|ack|info
  body: string;
  in_reply_to: string | null; // id of the message this answers, if any
};

export type PostMessageDTO = {
  from: string;
  kind?: string; // defaults to "info"
  body: string;
  in_reply_to?: string;
};

/**
 * Unified, append-only event log per ticket. Every state change — messages,
 * checkpoints, progress reports, status flips, lock acquire/release, log
 * lines — flows through this log. It is the single source of truth for the
 * ticket's audit trail; the canonical scalar fields on the ticket
 * (`update`, `progress_summary`, `lock`) are derived projections of the
 * latest relevant event and are kept on the ticket as a read cache.
 *
 * The broker (in-process pub/sub inside the MCP server) fans out new events
 * to subscribed listeners. Both the orchestrator and the specialist read
 * from the same log via the same `since` cursor.
 */
export type EventType =
  | "message"
  | "checkpoint"
  | "progress"
  | "log"
  | "status_change"
  | "lock_change";

type EventBase = {
  id: string; // server-minted, e.g. "evt_<uuid>"
  at: string; // ISO-8601, monotone within a ticket (server enforces)
  type: EventType;
};

export type MessageEvent = EventBase & {
  type: "message";
  from: string;
  kind: string; // free-text: nudge|question|response|ack|info
  body: string;
  in_reply_to: string | null;
};

export type CheckpointEvent = EventBase & {
  type: "checkpoint";
  by: string; // lock owner who recorded the checkpoint
  commit_id: string;
  update: string | null;
  progress_summary: string | null;
};

export type ProgressEvent = EventBase & {
  type: "progress";
  by: string;
  status: string | null;
  update: string | null;
  progress_summary: string | null;
};

export type LogEvent = EventBase & {
  type: "log";
  by: string | null; // null when posted by an orchestrator / unauthenticated caller
  line: string;
};

export type StatusChangeEvent = EventBase & {
  type: "status_change";
  by: string | null;
  from_status: string | null;
  to_status: string;
};

export type LockChangeEvent = EventBase & {
  type: "lock_change";
  action: "acquire" | "release" | "recover";
  owner: string;
  // For "recover": the prior owner whose stale lock was reclaimed.
  recovered_from: string | null;
  final_status: string | null; // for "release", the status set on release
};

export type Event =
  | MessageEvent
  | CheckpointEvent
  | ProgressEvent
  | LogEvent
  | StatusChangeEvent
  | LockChangeEvent;

export type AllowedStatuses = Record<TicketType, readonly string[]>;

export const DEFAULT_ALLOWED_STATUSES: AllowedStatuses = {
  epic: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  story: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  task: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  subtask: ["Todo", "In Progress", "Blocked", "Done"],
};

export const TICKET_TYPES: readonly TicketType[] = ["epic", "story", "task", "subtask"];
export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2"];
