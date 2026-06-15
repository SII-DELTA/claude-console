import { describe, expect, it } from "vitest";
import {
  AgentLogSchema,
  AgentSessionSchema,
  ClaudeMessageSchema,
  ClaudeSessionSchema,
  ClientMessageSchema,
  CreateSessionInputSchema,
  FileChangeSchema,
  PairRequestSchema,
  ServerMessageSchema,
} from "./schemas.js";

describe("AgentSessionSchema", () => {
  const valid = {
    id: "s1",
    workspaceId: "w1",
    title: "Demo",
    type: "shell",
    command: "/bin/zsh",
    cwd: "/tmp",
    status: "idle",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
  };

  it("accepts a minimal valid session", () => {
    expect(() => AgentSessionSchema.parse(valid)).not.toThrow();
  });

  it("rejects unknown session type", () => {
    expect(() => AgentSessionSchema.parse({ ...valid, type: "rogue" })).toThrow();
  });

  it("rejects empty id", () => {
    expect(() => AgentSessionSchema.parse({ ...valid, id: "" })).toThrow();
  });

  it("accepts exitCode null", () => {
    expect(() => AgentSessionSchema.parse({ ...valid, exitCode: null })).not.toThrow();
  });
});

describe("AgentLogSchema", () => {
  it("validates levels", () => {
    const base = {
      id: "l1",
      sessionId: "s1",
      timestamp: "2026-05-08T00:00:00.000Z",
      content: "hello",
    };
    for (const level of ["info", "action", "test", "error", "warn"]) {
      expect(() => AgentLogSchema.parse({ ...base, level })).not.toThrow();
    }
    expect(() => AgentLogSchema.parse({ ...base, level: "fatal" })).toThrow();
  });
});

describe("FileChangeSchema", () => {
  it("requires non-negative line counts", () => {
    expect(() =>
      FileChangeSchema.parse({
        id: "f1",
        sessionId: "s1",
        path: "a.ts",
        kind: "modified",
        addedLines: -1,
        removedLines: 0,
        timestamp: "2026-05-08T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("CreateSessionInputSchema", () => {
  it("accepts type-only payload", () => {
    expect(() => CreateSessionInputSchema.parse({ type: "shell" })).not.toThrow();
  });
});

describe("PairRequestSchema", () => {
  it("defaults platform to unknown", () => {
    const v = PairRequestSchema.parse({ pairCode: "12345678", deviceName: "iPhone" });
    expect(v.platform).toBe("unknown");
  });
});

describe("ClientMessageSchema", () => {
  it("discriminates input message", () => {
    const v = ClientMessageSchema.parse({
      type: "client:input",
      sessionId: "s1",
      data: "ls\n",
    });
    expect(v.type).toBe("client:input");
  });

  it("rejects unknown type", () => {
    expect(() => ClientMessageSchema.parse({ type: "client:nope" })).toThrow();
  });
});

describe("ServerMessageSchema", () => {
  it("validates hello", () => {
    const v = ServerMessageSchema.parse({
      type: "server:hello",
      serverVersion: "0.1.0",
      workspaceId: "w1",
      workspaceName: "demo",
      protocolVersion: 1,
    });
    expect(v.type).toBe("server:hello");
  });

  it("validates claude_delta", () => {
    const v = ServerMessageSchema.parse({
      type: "server:claude_delta",
      sessionId: "s1",
      delta: "hello",
      blockKind: "text",
      status: "streaming",
      timestamp: "2026-06-11T00:00:00.000Z",
    });
    expect(v.type).toBe("server:claude_delta");
  });
});

describe("AgentSessionSchema (claude type)", () => {
  it("accepts claude type, rejects copilot", () => {
    const base = {
      id: "s1",
      workspaceId: "w1",
      title: "Demo",
      command: "claude",
      cwd: "/tmp",
      status: "running",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
    };
    expect(() => AgentSessionSchema.parse({ ...base, type: "claude" })).not.toThrow();
    expect(() => AgentSessionSchema.parse({ ...base, type: "copilot" })).toThrow();
  });
});

describe("ClaudeSessionSchema", () => {
  it("requires isLive and structured counts", () => {
    const v = ClaudeSessionSchema.parse({
      id: "abc",
      title: "T",
      workspaceId: "w1",
      cwd: "/tmp",
      sessionFilePath: "/x/abc.jsonl",
      updatedAt: "2026-06-11T00:00:00.000Z",
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolUseCount: 0,
      isLive: true,
    });
    expect(v.isLive).toBe(true);
  });
});

describe("ClaudeMessageSchema", () => {
  it("parses discriminated blocks", () => {
    const v = ClaudeMessageSchema.parse({
      id: "u1",
      sessionId: "s1",
      role: "assistant",
      timestamp: "2026-06-11T00:00:00.000Z",
      blocks: [
        { kind: "thinking", text: "hmm" },
        { kind: "text", text: "hi" },
        { kind: "tool_use", toolName: "Bash", input: { command: "ls" } },
      ],
    });
    expect(v.blocks).toHaveLength(3);
  });
});
