import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig } from "../config/loader.js";
import type { Result } from "../domain/result.js";
import { buildAdapter } from "../index.js";
import { RefMutex } from "../server/mutex.js";
import { type ServiceOptions, TicketService } from "../server/service.js";

type Args = Record<string, string | boolean>;

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing --${key}`);
  return v;
}

function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Read the bundled team-tracking-execute SKILL.md so the CLI's
 * `acquire` returns the same inlined system_addendum as the MCP tool.
 * Mirrors the lookup logic in `index.ts`.
 */
function readExecuteSkillBody(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "..", "..", "..", "skills", "team-tracking-execute", "SKILL.md"),
      path.resolve(here, "..", "..", "skills", "team-tracking-execute", "SKILL.md"),
    ];
    for (const p of candidates) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        /* try next candidate */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildServiceOptions(): ServiceOptions {
  return {
    ttlSeconds: 1800,
    now: () => new Date().toISOString(),
    mintToken: () => `tok_${randomUUID()}`,
    mintMessageId: () => `msg_${randomUUID()}`,
    mintEventId: () => `evt_${randomUUID()}`,
    executorSkills: [{ name: "team-tracking-execute", body: readExecuteSkillBody() ?? undefined }],
  };
}

const SUBCOMMANDS = ["acquire", "checkpoint", "release", "progress", "log", "message"] as const;
export type ExecSubcommand = (typeof SUBCOMMANDS)[number];

export function isExecSubcommand(s: string): s is ExecSubcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

export function execUsage(): string {
  return `usage: team-tracking <subcommand> [options]

Subcommands (all require --project and --id, except where noted):

  acquire     --owner R@D
              acquire the lock; output {lock_token, recovered_checkpoint, system_addendum}

  checkpoint  --token T --commit SHA [--update '...'] [--progress '...']
              record a durable checkpoint at a git SHA

  release    --token T --status STATUS
              release the lock and set final status (typically Done | Blocked | In Review)

  progress   --token T [--status STATUS] [--update '...'] [--progress '...']
              update visible pulse fields between commits

  log         --line '...'
              append an audit line; no lock token required

  message     --from R --body '...' [--kind nudge|question|response|ack|info] [--in-reply-to ID]
              post a steering message on the ticket

Output: a single JSON line on stdout. On success, the call result; on error,
{ "error": "<kind>: <message>" }. Exit code: 0 for the entire CLI; transport
errors are surfaced through stdout, not the exit code.
`;
}

export async function runExec(
  subcommand: ExecSubcommand,
  argv: readonly string[],
): Promise<number> {
  const args = parseArgs(argv);
  let config: Config;
  try {
    config = await loadConfig();
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: (e as Error).message })}\n`);
    return 0;
  }

  const built = await buildAdapter(config);
  const service = new TicketService(built.adapter, new RefMutex(), buildServiceOptions());

  try {
    const project = reqString(args, "project");
    const id = reqString(args, "id");
    const ref = { project, id };

    let result: unknown;
    switch (subcommand) {
      case "acquire": {
        const owner = reqString(args, "owner");
        result = await service.acquireTicket(ref, owner);
        break;
      }
      case "checkpoint": {
        const lockToken = reqString(args, "token");
        const commitId = reqString(args, "commit");
        result = await service.commitCheckpoint(ref, {
          lock_token: lockToken,
          commit_id: commitId,
          update: optString(args, "update"),
          progress_summary: optString(args, "progress"),
        });
        break;
      }
      case "release": {
        const lockToken = reqString(args, "token");
        const finalStatus = reqString(args, "status");
        result = await service.releaseTicket(ref, {
          lock_token: lockToken,
          final_status: finalStatus,
        });
        break;
      }
      case "progress": {
        const lockToken = reqString(args, "token");
        result = await service.reportProgress(ref, {
          lock_token: lockToken,
          status: optString(args, "status"),
          update: optString(args, "update"),
          progress_summary: optString(args, "progress"),
        });
        break;
      }
      case "log": {
        const line = reqString(args, "line");
        result = await service.appendLog(ref, line);
        break;
      }
      case "message": {
        const from = reqString(args, "from");
        const body = reqString(args, "body");
        result = await service.postMessage(ref, {
          from,
          body,
          kind: optString(args, "kind"),
          in_reply_to: optString(args, "in-reply-to"),
        });
        break;
      }
    }

    process.stdout.write(`${JSON.stringify(unwrap(result))}\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: (e as Error).message })}\n`);
    return 0;
  } finally {
    await built.dispose();
  }
}

/**
 * Service methods that return a Result<T, DomainError> get unwrapped here
 * so the CLI emits either the raw value or a structured error envelope —
 * never a leaky Result wrapper. `appendLog` returns void on success which
 * we surface as `"ok"` to stay consistent with the existing tool layer.
 */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "ok" in value) {
    const r = value as Result<unknown, { kind: string; message: string }>;
    if (r.ok) return r.value === undefined ? "ok" : r.value;
    return { error: `${r.error.kind}: ${r.error.message}` };
  }
  return value;
}
