import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { workspaceIdFromPath } from "./util/crypto.js";
import type { Workspace } from "@mac/shared";

export class WorkspaceReader {
  private workspace: Workspace;
  private readonly initialWorkspace: Workspace;

  constructor(rootPath: string, name?: string) {
    const abs = resolve(rootPath);
    this.workspace = {
      id: workspaceIdFromPath(abs),
      name: name ?? basename(abs),
      rootPath: abs,
    };
    this.initialWorkspace = this.workspace;
  }

  current(): Workspace {
    return this.workspace;
  }

  list(): Workspace[] {
    const byId = new Map<string, Workspace>();
    for (const ws of [this.initialWorkspace, this.workspace, ...this.discoverCodeWorkspaces()]) {
      byId.set(ws.id, ws);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  switchTo(input: { workspaceId?: string; rootPath?: string }): Workspace | null {
    const target = input.rootPath
      ? this.fromRoot(input.rootPath)
      : this.list().find((ws) => ws.id === input.workspaceId);
    if (!target) return null;
    this.workspace = target;
    return target;
  }

  private fromRoot(rootPath: string): Workspace {
    const abs = resolve(rootPath);
    return {
      id: workspaceIdFromPath(abs),
      name: basename(abs),
      rootPath: abs,
    };
  }

  private discoverCodeWorkspaces(): Workspace[] {
    const roots = [
      process.env.NEXRA_VSCODE_USER_DATA_DIR,
      process.env.VSCODE_USER_DATA_DIR,
      join(homedir(), "Library", "Application Support", "Code"),
    ].filter((value): value is string => Boolean(value));
    const workspaces: Workspace[] = [];
    for (const userDataDir of roots) {
      const storageRoot = join(userDataDir, "User", "workspaceStorage");
      if (!existsSync(storageRoot)) continue;
      for (const entry of safeList(storageRoot)) {
        const workspaceJson = join(storageRoot, entry, "workspace.json");
        try {
          const raw = JSON.parse(readFileSync(workspaceJson, "utf8")) as {
            folder?: string;
            workspace?: string;
          };
          const root = raw.folder ? fileURLToPath(raw.folder) : raw.workspace ? fileURLToPath(raw.workspace) : undefined;
          if (!root) continue;
          const ws = this.fromRoot(root);
          workspaces.push(ws);
        } catch {
          // Ignore unrelated or stale VS Code workspace records.
        }
      }
    }
    return workspaces;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
