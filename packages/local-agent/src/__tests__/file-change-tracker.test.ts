import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../bus.js";
import { HistoryStore } from "../history-store.js";
import { SessionManager } from "../session-manager.js";
import { FileChangeTracker } from "../file-change-tracker.js";
import { createMockPtyFactory } from "./mock-pty.js";
import type { FileChange } from "@mac/shared";

let workspace: string;
let store: HistoryStore;
let bus: Bus;
let sessions: SessionManager;
let tracker: FileChangeTracker;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "mac-agent-fct-"));
  store = new HistoryStore(":memory:");
  bus = new Bus();
  const { factory } = createMockPtyFactory();
  sessions = new SessionManager(store, bus, {
    workspaceId: "w1",
    workspaceRoot: workspace,
    defaultCommands: { shell: "/bin/sh", claude: "x", custom: "" },
    ptyFactory: factory,
  });
  // Seed an active session so tracker has somewhere to attribute changes.
  sessions.create({ type: "shell" });
  tracker = new FileChangeTracker(store, bus, sessions, { workspaceRoot: workspace });
  await tracker.start();
});

afterEach(async () => {
  await tracker.stop();
  store.close();
  rmSync(workspace, { recursive: true, force: true });
});

function nextChange(timeoutMs = 8_000): Promise<FileChange> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("file change timeout")), timeoutMs);
    bus.on("session:file_changed", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
}

describe("FileChangeTracker", () => {
  it("emits added on new file", async () => {
    const path = join(workspace, "a.txt");
    const promise = nextChange();
    writeFileSync(path, "hello\n");
    const c = await promise;
    expect(c.kind).toBe("added");
    expect(c.path).toBe("a.txt");
  });

  it("emits modified on change", async () => {
    const path = join(workspace, "b.txt");
    writeFileSync(path, "v1\n");
    await new Promise((r) => setTimeout(r, 350));
    const promise = nextChange();
    writeFileSync(path, "v2\n");
    const c = await promise;
    expect(["modified", "added"]).toContain(c.kind);
  });

  it("emits deleted on unlink", async () => {
    const path = join(workspace, "c.txt");
    writeFileSync(path, "x");
    await new Promise((r) => setTimeout(r, 350));
    const promise = nextChange();
    unlinkSync(path);
    const c = await promise;
    expect(c.kind).toBe("deleted");
  });
});
