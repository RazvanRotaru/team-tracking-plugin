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

export type AllowedStatuses = Record<TicketType, readonly string[]>;

export const DEFAULT_ALLOWED_STATUSES: AllowedStatuses = {
  epic: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  story: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  task: ["Backlog", "Todo", "In Progress", "In Review", "Done"],
  subtask: ["Todo", "In Progress", "Blocked", "Done"],
};

export const TICKET_TYPES: readonly TicketType[] = ["epic", "story", "task", "subtask"];
export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2"];
