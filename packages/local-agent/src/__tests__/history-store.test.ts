import { describe, expect, it } from "vitest";
import { HistoryStore } from "../history-store.js";

const ISO = (n: number) => new Date(2026, 4, 8, 0, 0, n).toISOString();

describe("HistoryStore", () => {
  it("persists and lists sessions", () => {
    const store = new HistoryStore(":memory:");
    store.saveSession({
      id: "s1",
      workspaceId: "w1",
      title: "t",
      type: "shell",
      command: "/bin/sh",
      cwd: "/tmp",
      status: "idle",
      createdAt: ISO(1),
      updatedAt: ISO(2),
    });
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSession("s1")?.title).toBe("t");
  });

  it("appends and queries logs with filters", () => {
    const store = new HistoryStore(":memory:");
    for (let i = 0; i < 3; i++) {
      store.appendLog({
        id: `l${i}`,
        sessionId: "s1",
        timestamp: ISO(i),
        level: i === 1 ? "error" : "info",
        content: `line ${i}`,
      });
    }
    expect(store.getLogs({ sessionId: "s1" })).toHaveLength(3);
    expect(store.getLogs({ sessionId: "s1", level: "error" })).toHaveLength(1);
    expect(store.getLogs({ sessionId: "s1", since: ISO(0) })).toHaveLength(2);
  });

  it("trims logs", () => {
    const store = new HistoryStore(":memory:");
    for (let i = 0; i < 10; i++) {
      store.appendLog({
        id: `l${i}`,
        sessionId: "s1",
        timestamp: ISO(i),
        level: "info",
        content: `line ${i}`,
      });
    }
    store.trimLogs("s1", 3);
    expect(store.getLogs({ sessionId: "s1", limit: 100 })).toHaveLength(3);
  });

  it("cascades delete", () => {
    const store = new HistoryStore(":memory:");
    store.saveSession({
      id: "s1",
      workspaceId: "w1",
      title: "t",
      type: "shell",
      command: "/bin/sh",
      cwd: "/tmp",
      status: "idle",
      createdAt: ISO(1),
      updatedAt: ISO(2),
    });
    store.appendLog({
      id: "l1",
      sessionId: "s1",
      timestamp: ISO(1),
      level: "info",
      content: "x",
    });
    store.deleteSession("s1");
    expect(store.getSession("s1")).toBeNull();
    expect(store.getLogs({ sessionId: "s1" })).toHaveLength(0);
  });

  it("stores file changes", () => {
    const store = new HistoryStore(":memory:");
    store.appendFileChange({
      id: "f1",
      sessionId: "s1",
      path: "a.ts",
      kind: "modified",
      addedLines: 1,
      removedLines: 0,
      timestamp: ISO(1),
    });
    expect(store.listFileChanges("s1")).toHaveLength(1);
  });

  it("stores and revokes devices", () => {
    const store = new HistoryStore(":memory:");
    store.saveDevice({
      id: "d1",
      name: "iPhone",
      platform: "ios",
      pairedAt: ISO(1),
      lastSeenAt: ISO(1),
      revoked: false,
      tokenHash: "h1",
    });
    expect(store.findDeviceByTokenHash("h1")?.id).toBe("d1");
    store.revokeDevice("d1");
    expect(store.findDeviceByTokenHash("h1")).toBeNull();
  });

  it("persists, lists and deletes pending permissions", () => {
    const store = new HistoryStore(":memory:");
    const questions = [{ question: "Pick?", header: "H", multiSelect: false, options: [{ label: "A" }] }];
    store.savePendingPermission({
      requestId: "r1",
      sessionId: "s1",
      toolName: "AskUserQuestion",
      questions,
      createdAt: ISO(1),
    });
    store.savePendingPermission({
      requestId: "r2",
      sessionId: "s1",
      toolName: "AskUserQuestion",
      questions,
      createdAt: ISO(2),
    });
    store.savePendingPermission({
      requestId: "r3",
      sessionId: "s2",
      toolName: "AskUserQuestion",
      questions,
      createdAt: ISO(3),
    });

    expect(store.listPendingPermissions("s1").map((p) => p.requestId)).toEqual(["r1", "r2"]);
    expect(store.getPendingPermission("r1")?.questions).toEqual(questions);

    store.deletePendingPermission("r1");
    expect(store.getPendingPermission("r1")).toBeNull();
    expect(store.listPendingPermissions("s1").map((p) => p.requestId)).toEqual(["r2"]);

    store.deletePendingPermissionsBySession("s1");
    expect(store.listPendingPermissions("s1")).toHaveLength(0);
    expect(store.listPendingPermissions("s2")).toHaveLength(1); // other session untouched
  });

  it("records dismissed question ids (idempotent)", () => {
    const store = new HistoryStore(":memory:");
    store.dismissQuestions("s1", ["q1", "q2"], ISO(1));
    store.dismissQuestions("s1", ["q2", "q3"], ISO(2)); // q2 repeats — ignored
    expect(new Set(store.listDismissedQuestionIds())).toEqual(new Set(["q1", "q2", "q3"]));
  });
});
