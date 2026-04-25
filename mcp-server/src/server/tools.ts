import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DomainError } from "../domain/errors.js";
import type { Result } from "../domain/result.js";
import type { TicketService } from "./service.js";

const RefSchema = {
  project: z.string().min(1),
  id: z.string().min(1),
};

const TicketRefSchema = z.object(RefSchema);

const PrioritySchema = z.enum(["P0", "P1", "P2"]);
const TicketTypeSchema = z.enum(["epic", "story", "task", "subtask"]);

const CreateTicketSchema = {
  project: z.string().min(1),
  draft: z.object({
    type: TicketTypeSchema,
    parent: TicketRefSchema.optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    priority: PrioritySchema.optional(),
    labels: z.array(z.string()).optional(),
    scope: z.string().optional(),
  }),
};

const UpdateTicketSchema = {
  ref: TicketRefSchema,
  update: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.string().optional(),
    priority: PrioritySchema.optional(),
    labels: z.array(z.string()).optional(),
    scope: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    pr_url: z.string().nullable().optional(),
  }),
};

const AcquireSchema = {
  ref: TicketRefSchema,
  owner: z.string().min(1),
};

const CommitCheckpointSchema = {
  ref: TicketRefSchema,
  lock_token: z.string().min(1),
  commit_id: z.string().min(1),
  update: z.string().optional(),
  progress_summary: z.string().optional(),
};

const ReleaseSchema = {
  ref: TicketRefSchema,
  lock_token: z.string().min(1),
  final_status: z.string().min(1),
};

const ReportProgressSchema = {
  ref: TicketRefSchema,
  lock_token: z.string().min(1),
  status: z.string().optional(),
  update: z.string().optional(),
  progress_summary: z.string().optional(),
};

const AppendLogSchema = {
  ref: TicketRefSchema,
  line: z.string().min(1),
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok<T>(value: T): ToolResult {
  const text = value === undefined ? '"ok"' : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function fail(e: DomainError): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${e.kind}: ${e.message}` }],
  };
}

function unwrap<T>(r: Result<T, DomainError>): ToolResult {
  return r.ok ? ok(r.value) : fail(r.error);
}

export function registerTools(server: McpServer, service: TicketService): void {
  server.registerTool(
    "list_board",
    {
      description:
        "List top-level tickets on the board (In Progress > Todo > Backlog). " +
        "Excludes In Review and Done by default.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) => ok(await service.listBoard(project)),
  );

  server.registerTool(
    "get_ticket",
    {
      description:
        "Read a single ticket including its frontmatter, body, lock state, and child refs.",
      inputSchema: { ref: TicketRefSchema },
    },
    async ({ ref }) => {
      const t = await service.getTicket(ref);
      if (!t) return fail({ kind: "ENOTFOUND", message: `ticket ${ref.id} not found` });
      return ok(t);
    },
  );

  server.registerTool(
    "list_children",
    {
      description: "List the immediate children (resolved as full TicketDTOs) of a ticket.",
      inputSchema: { ref: TicketRefSchema },
    },
    async ({ ref }) => ok(await service.listChildren(ref)),
  );

  server.registerTool(
    "create_ticket",
    {
      description:
        "Create a ticket. Parent type rules: epic→null, story→{epic,null}, task→{story,epic,null}, subtask→{task,story}.",
      inputSchema: CreateTicketSchema,
    },
    async ({ project, draft }) => unwrap(await service.createTicket(project, draft)),
  );

  server.registerTool(
    "update_ticket",
    {
      description: "Update a ticket's mutable fields. Cannot change type or parent.",
      inputSchema: UpdateTicketSchema,
    },
    async ({ ref, update }) => unwrap(await service.updateTicket(ref, update)),
  );

  server.registerTool(
    "acquire_ticket",
    {
      description:
        "Acquire the lock for a ticket. Returns a lock_token that must accompany subsequent " +
        "checkpoint/release/report calls. If a previous lock was stale, returns recovered_checkpoint.",
      inputSchema: AcquireSchema,
    },
    async ({ ref, owner }) => unwrap(await service.acquireTicket(ref, owner)),
  );

  server.registerTool(
    "commit_checkpoint",
    {
      description:
        "Record a durable checkpoint (git SHA + optional update + progress_summary). " +
        "Caller must already have created the commit; the server does not verify the SHA.",
      inputSchema: CommitCheckpointSchema,
    },
    async ({ ref, lock_token, commit_id, update, progress_summary }) =>
      unwrap(
        await service.commitCheckpoint(ref, {
          lock_token,
          commit_id,
          update,
          progress_summary,
        }),
      ),
  );

  server.registerTool(
    "release_ticket",
    {
      description:
        "Release the lock and set the ticket's final status (typically Done or Blocked).",
      inputSchema: ReleaseSchema,
    },
    async ({ ref, lock_token, final_status }) =>
      unwrap(await service.releaseTicket(ref, { lock_token, final_status })),
  );

  server.registerTool(
    "report_progress",
    {
      description:
        "Update the visible pulse fields (status / update / progress_summary) without recording " +
        "a checkpoint. Useful between commits.",
      inputSchema: ReportProgressSchema,
    },
    async ({ ref, lock_token, status, update, progress_summary }) =>
      unwrap(
        await service.reportProgress(ref, {
          lock_token,
          status,
          update,
          progress_summary,
        }),
      ),
  );

  server.registerTool(
    "append_log",
    {
      description:
        "Append a single line to the ticket's audit log. Not gated on a lock token; anyone may log.",
      inputSchema: AppendLogSchema,
    },
    async ({ ref, line }) => unwrap(await service.appendLog(ref, line)),
  );
}
