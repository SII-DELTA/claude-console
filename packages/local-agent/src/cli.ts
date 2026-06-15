#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";
import { startAgent } from "./runtime.js";
import { loadDotenv } from "./util/dotenv.js";

interface CliArgs {
  port?: number;
  host?: string;
  workspace?: string;
  storage?: string;
  origin?: string[];
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--port":
      case "-p":
        out.port = Number(next());
        break;
      case "--host":
      case "-H":
        out.host = next();
        break;
      case "--workspace":
      case "-w":
        out.workspace = next();
        break;
      case "--storage":
      case "-s":
        out.storage = next();
        break;
      case "--origin": {
        const v = next();
        if (v) (out.origin ??= []).push(v);
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
        break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const workspaceRoot = resolve(args.workspace ?? process.cwd());
  const storagePath = resolve(args.storage ?? `${process.env.HOME ?? "."}/.mac-agent`);

  // Load .env (first match wins; real env vars always take precedence). Looks in
  // the workspace root, the cwd, then the global storage dir.
  const envCandidates = [
    resolve(workspaceRoot, ".env"),
    resolve(process.cwd(), ".env"),
    resolve(storagePath, ".env"),
  ];
  for (const p of envCandidates) {
    if (loadDotenv(p)) {
      process.stdout.write(`[agent] loaded env from ${p}\n`);
      break;
    }
  }

  const handle = await startAgent({
    port: args.port ?? 7345,
    // host unset -> runtime uses MAC_AGENT_BIND or 127.0.0.1 (loopback by default)
    host: args.host,
    workspaceRoot,
    workspaceName: process.env.MAC_WORKSPACE_NAME,
    storagePath,
    allowedOrigins: args.origin ?? ["*"],
    serverVersion: process.env.MAC_VERSION ?? "0.1.0",
    whisperApiKey: process.env.MAC_WHISPER_API_KEY,
  });

  const isForked = typeof process.send === "function";
  const selfToken = isForked ? handle.auth.registerSelfToken("vscode-host") : undefined;

  const ready = {
    type: "ready" as const,
    ok: true,
    url: handle.url,
    wsUrl: handle.wsUrl,
    workspaceId: handle.workspaceId,
    pairCode: handle.pairCode,
    port: handle.port,
    selfToken,
  };

  if (isForked && process.send) {
    process.send(ready);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(ready, null, 2));
  }

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    try {
      await handle.stop();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("disconnect", () => void shutdown(0));
  process.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { type?: string }).type === "shutdown") {
      void shutdown(0);
    }
  });
}

const USAGE = `mac-agent — Mobile Agent Console local daemon

Usage:
  mac-agent [options]

Options:
  -p, --port <port>          Port to listen on (default 7345)
  -H, --host <host>          Host to bind (default MAC_AGENT_BIND or 127.0.0.1)
  -w, --workspace <path>     Workspace root (default cwd)
  -s, --storage <path>       Storage directory (default ~/.mac-agent)
      --origin <origin>      Allowed CORS origin (repeatable, default *)
  -h, --help                 Show help
`;

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[mac-agent] failed to start:", err);
    process.exit(1);
  });
}
