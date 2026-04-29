import * as path from "node:path";
import { ensureGitignored, isGitRepo } from "../config/gitignore.js";
import { type Config, ConfigSchema, defaultConfigPath, saveConfig } from "../config/loader.js";

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

function usage(): string {
  return `usage: team-tracking init --adapter <obsidian-kanban|jira> [options]

  --adapter              obsidian-kanban | jira
  --vault                (obsidian) path to vault root
  --project              project name (e.g. Acme)
  --project-ref          adapter-side project ref (default: project name for obsidian)
  --lock-ttl             lock TTL in seconds (default: 1800)
  --jira-base-url        (jira) Atlassian base URL
  --jira-email           (jira) account email
  --jira-api-token       (jira) API token
  --jira-webhook-port    (jira, optional) port for the webhook receiver. when set,
                         configure Jira to POST comment_created events to
                         http://<host>:<port>/webhook for push delivery.
                         when unset, the adapter polls.
  --jira-webhook-host    (jira, optional) bind interface for the webhook receiver
                         (default: 127.0.0.1). use 0.0.0.0 if Jira reaches you
                         from another host.
  --jira-watch-poll-ms   (jira, optional) polling interval in ms for the
                         poll-based fallback (default: 10000)
  --no-gitignore         skip updating .gitignore
  --config               output path (default: ./.team-tracking/config.json)
  --headless             non-interactive (currently the only mode)

webpage flow (no adapter args):
  --bind <host>        interface to bind on (default: 127.0.0.1).
                       use a LAN/Tailscale IP or 0.0.0.0 to reach from
                       another machine. token still gates auth.
  --no-browser         don't open a browser, just print the URL
`;
}

export async function runHeadlessInit(argv: readonly string[]): Promise<{
  configPath: string;
  config: Config;
  gitignoreUpdated: boolean | null;
}> {
  const args = parseArgs(argv);
  const adapter = args.adapter;
  if (typeof adapter !== "string") {
    throw new Error(`missing --adapter\n\n${usage()}`);
  }

  const projectName = typeof args.project === "string" ? args.project : "Default";
  const lockTtlSeconds = typeof args["lock-ttl"] === "string" ? Number(args["lock-ttl"]) : 1800;

  let config: Config;
  if (adapter === "obsidian-kanban") {
    if (typeof args.vault !== "string") {
      throw new Error("obsidian-kanban requires --vault <path>");
    }
    const adapterProjectRef =
      typeof args["project-ref"] === "string" ? args["project-ref"] : `projects/${projectName}`;
    config = ConfigSchema.parse({
      version: 1,
      adapter: "obsidian-kanban",
      adapterConfig: { vaultPath: path.resolve(args.vault) },
      projects: [{ name: projectName, adapterProjectRef }],
      lockTtlSeconds,
    });
  } else if (adapter === "jira") {
    const baseUrl = args["jira-base-url"];
    const email = args["jira-email"];
    const apiToken = args["jira-api-token"];
    if (typeof baseUrl !== "string" || typeof email !== "string" || typeof apiToken !== "string") {
      throw new Error("jira requires --jira-base-url, --jira-email, --jira-api-token");
    }
    const adapterProjectRef =
      typeof args["project-ref"] === "string" ? args["project-ref"] : projectName;
    const adapterConfig: Record<string, unknown> = {
      baseUrl,
      email,
      apiToken,
      statusMap: {
        Backlog: "Backlog",
        Todo: "To Do",
        "In Progress": "In Progress",
        "In Review": "In Review",
        Done: "Done",
        Blocked: "Blocked",
      },
    };
    if (typeof args["jira-webhook-port"] === "string") {
      adapterConfig.webhookPort = Number(args["jira-webhook-port"]);
    }
    if (typeof args["jira-webhook-host"] === "string") {
      adapterConfig.webhookHost = args["jira-webhook-host"];
    }
    if (typeof args["jira-watch-poll-ms"] === "string") {
      adapterConfig.watchPollMs = Number(args["jira-watch-poll-ms"]);
    }
    config = ConfigSchema.parse({
      version: 1,
      adapter: "jira",
      adapterConfig,
      projects: [{ name: projectName, adapterProjectRef }],
      lockTtlSeconds,
    });
  } else {
    throw new Error(`unknown adapter "${adapter}"`);
  }

  const target = typeof args.config === "string" ? path.resolve(args.config) : defaultConfigPath();
  const written = await saveConfig(config, target);

  let gitignoreUpdated: boolean | null = null;
  if (args["no-gitignore"] !== true) {
    const repoRoot = path.dirname(path.dirname(written)); // strip /.team-tracking/config.json
    if (await isGitRepo(repoRoot)) {
      const r = await ensureGitignored(repoRoot);
      gitignoreUpdated = r.changed;
    }
  }

  return { configPath: written, config, gitignoreUpdated };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (first === "listen") {
    const { runListen, listenUsage } = await import("./listen.js");
    if (argv[1] === "--help" || argv[1] === "-h") {
      process.stdout.write(listenUsage());
      return;
    }
    const code = await runListen(argv.slice(1));
    process.exitCode = code;
    return;
  }

  if (typeof first === "string") {
    const { runExec, execUsage, isExecSubcommand } = await import("./exec.js");
    if (isExecSubcommand(first)) {
      if (argv[1] === "--help" || argv[1] === "-h") {
        process.stdout.write(execUsage());
        return;
      }
      const code = await runExec(first, argv.slice(1));
      process.exitCode = code;
      return;
    }
  }

  // Strip a leading literal "init" subcommand if present.
  const rest = first === "init" ? argv.slice(1) : argv;

  // Webpage-mode flags (don't trigger headless mode):
  const webOnlyFlags = new Set(["--no-browser", "--bind"]);
  const hasHeadlessArgs = rest.some(
    (a, i) => a.startsWith("--") && !webOnlyFlags.has(a) && !(rest[i - 1] === "--bind"),
  );

  let result: {
    configPath: string;
    config: Config;
    gitignoreUpdated: boolean | null;
  };
  if (!hasHeadlessArgs) {
    const bindIdx = rest.indexOf("--bind");
    const bindHost = bindIdx >= 0 ? rest[bindIdx + 1] : undefined;
    const { runInitWeb } = await import("./server.js");
    result = await runInitWeb({
      onUrl: (url) => process.stdout.write(`open in your browser: ${url}\n`),
      noBrowser: rest.includes("--no-browser"),
      host: bindHost,
    });
  } else {
    result = await runHeadlessInit(rest);
  }

  const { configPath, config, gitignoreUpdated } = result;
  process.stdout.write(
    `${[
      `wrote ${configPath}`,
      `adapter: ${config.adapter}`,
      `projects: ${config.projects.map((p) => p.name).join(", ")}`,
      gitignoreUpdated === true ? "updated .gitignore" : "",
      gitignoreUpdated === false ? ".gitignore already up to date" : "",
    ]
      .filter(Boolean)
      .join("\n")}\n`,
  );
}

const isEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url.endsWith(argv1) || import.meta.url.endsWith(`${argv1}.js`);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
