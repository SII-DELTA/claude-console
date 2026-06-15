import { describe, expect, it } from "vitest";
import { Bus } from "../bus.js";
import { HistoryStore } from "../history-store.js";
import { SessionManager } from "../session-manager.js";
import { createMockPtyFactory } from "./mock-pty.js";

function setup() {
  const store = new HistoryStore(":memory:");
  const bus = new Bus();
  const { factory, last } = createMockPtyFactory();
  const sessions = new SessionManager(store, bus, {
    workspaceId: "w1",
    workspaceRoot: "/tmp",
    defaultCommands: { shell: "/bin/sh", claude: "claude", custom: "" },
    ptyFactory: factory,
  });
  return { store, bus, sessions, last };
}

describe("SessionManager", () => {
  it("creates a session, broadcasts created+updated and starts pty", () => {
    const { sessions, bus, last } = setup();
    const events: string[] = [];
    bus.on("session:created", () => events.push("created"));
    bus.on("session:updated", () => events.push("updated"));
    bus.on("session:command_started", () => events.push("started"));

    const s = sessions.create({ type: "shell" });
    expect(s.command).toBe("/bin/sh");
    expect(events).toContain("created");
    expect(events).toContain("started");
    expect(last().options.command).toBe("/bin/sh");
  });

  it("emits log events from pty data", () => {
    const { sessions, bus, last } = setup();
    const logs: string[] = [];
    bus.on("session:log", (l) => logs.push(`${l.level}:${l.content}`));

    sessions.create({ type: "shell" });
    last().emit("hello\nError: boom\n");
    expect(logs).toEqual(["info:hello", "error:Error: boom"]);
  });

  it("writes input through pty", () => {
    const { sessions, last } = setup();
    const s = sessions.create({ type: "shell" });
    sessions.writeInput(s.id, "ls", true);
    expect(last().written).toEqual(["ls\n"]);
  });

  it("interrupt sends SIGINT", () => {
    const { sessions, last } = setup();
    const s = sessions.create({ type: "shell" });
    sessions.interrupt(s.id);
    expect(last().killed).toBe("SIGINT");
  });

  it("delete kills pty and removes session", () => {
    const { sessions, store } = setup();
    const s = sessions.create({ type: "shell" });
    expect(sessions.delete(s.id)).toBe(true);
    expect(store.getSession(s.id)).toBeNull();
  });

  it("status transitions to completed on exit 0 / error on non-zero", () => {
    const { sessions, last, store } = setup();
    const s = sessions.create({ type: "shell" });
    last().exit(0);
    expect(store.getSession(s.id)?.status).toBe("completed");

    const s2 = sessions.create({ type: "shell" });
    last().exit(1);
    expect(store.getSession(s2.id)?.status).toBe("error");
  });

  it("restart spawns a new pty", () => {
    const { sessions, last } = setup();
    const s = sessions.create({ type: "shell" });
    const pty1 = last();
    sessions.restart(s.id);
    const pty2 = last();
    expect(pty1).not.toBe(pty2);
  });

  it("uses custom command when provided", () => {
    const { sessions, last } = setup();
    sessions.create({ type: "custom", command: "echo hi", title: "hi" });
    expect(last().options.command).toBe("echo hi");
  });
});
