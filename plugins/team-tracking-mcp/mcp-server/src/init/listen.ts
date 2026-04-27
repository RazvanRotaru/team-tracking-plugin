import { type Config, loadConfig } from "../config/loader.js";
import type { Event, TicketRef } from "../domain/types.js";
import { buildAdapter } from "../index.js";
import { Subscription, type SubscriptionScope } from "../server/subscription.js";

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

export function listenUsage(): string {
  return `usage: team-tracking listen [options]

  --project <name>      project to subscribe to (required unless --ticket-id covers a single project)
  --ticket-id <id>      subscribe to a single ticket within the project (default: project-wide)
  --since <iso-ts>      only deliver events with at > <iso-ts>
  --types <a,b,c>       comma-separated event types to include
  --timeout-ms <ms>     max wait before exiting with a timeout envelope (default: 300000 = 5min)

Output: one JSON object per line on stdout. Exit code is always 0; transport
errors come through stdout as {"type":"error","reason":"..."}.

Envelope shapes:
  {"type":"events","ref":{"project":"P","id":"..."},"events":[...]}
  {"type":"timeout"}
  {"type":"error","reason":"..."}
`;
}

export async function runListen(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const project = typeof args.project === "string" ? args.project : null;
  if (!project) {
    process.stderr.write(`missing --project\n\n${listenUsage()}`);
    return 2;
  }
  const ticketId = typeof args["ticket-id"] === "string" ? args["ticket-id"] : null;
  const since = typeof args.since === "string" ? args.since : undefined;
  const typesArg = typeof args.types === "string" ? args.types : null;
  const types = typesArg
    ? (typesArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as ReadonlyArray<Event["type"]>)
    : undefined;
  const timeoutMs = typeof args["timeout-ms"] === "string" ? Number(args["timeout-ms"]) : 300_000;

  let config: Config;
  try {
    config = await loadConfig();
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ type: "error", reason: (e as Error).message })}\n`);
    return 0;
  }

  const adapter = await buildAdapter(config);
  const ticket: TicketRef | undefined = ticketId ? { project, id: ticketId } : undefined;
  const scope: SubscriptionScope = { project, ticket };
  const sub = new Subscription(adapter, scope, { since, types, timeoutMs });

  const handleSigint = (): void => {
    sub.cancel();
  };
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigint);

  try {
    for await (const env of sub.stream()) {
      process.stdout.write(`${JSON.stringify(env)}\n`);
      if (env.type === "events" || env.type === "error") {
        sub.cancel();
        break;
      }
      if (env.type === "timeout") {
        break;
      }
    }
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigint);
  }
  return 0;
}
