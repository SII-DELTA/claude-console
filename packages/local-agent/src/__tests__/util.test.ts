import { describe, expect, it } from "vitest";
import { LineBuffer, inferLevel, parseChunk } from "../util/log-parser.js";
import { redactSecrets, generatePairCode, workspaceIdFromPath } from "../util/crypto.js";

describe("inferLevel", () => {
  it("classifies error", () => {
    expect(inferLevel("Error: failed to connect")).toBe("error");
  });
  it("classifies warn", () => {
    expect(inferLevel("warning: deprecated api")).toBe("warn");
  });
  it("classifies test", () => {
    expect(inferLevel("✓ all tests passed")).toBe("test");
  });
  it("classifies action", () => {
    expect(inferLevel("running tool: linter")).toBe("action");
  });
  it("falls back to info", () => {
    expect(inferLevel("hello world")).toBe("info");
  });
});

describe("parseChunk", () => {
  it("splits on newlines and strips ansi", () => {
    const out = parseChunk("\u001b[31mhello\u001b[0m\nworld\n");
    expect(out.map((o) => o.content)).toEqual(["hello", "world"]);
  });
});

describe("LineBuffer", () => {
  it("buffers partial line until newline", () => {
    const buf = new LineBuffer();
    expect(buf.push("hello")).toEqual([]);
    const out = buf.push(" world\nnext line\nrem");
    expect(out.map((l) => l.content)).toEqual(["hello world", "next line"]);
    expect(buf.flush().map((l) => l.content)).toEqual(["rem"]);
  });
});

describe("redactSecrets", () => {
  it("masks bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890xyz");
    expect(out).not.toContain("abcdef1234567890xyz");
  });
});

describe("generatePairCode", () => {
  it("produces digits only and correct length", () => {
    const code = generatePairCode(8);
    expect(code).toMatch(/^\d{8}$/);
  });
});

describe("workspaceIdFromPath", () => {
  it("is deterministic", () => {
    expect(workspaceIdFromPath("/tmp/foo")).toBe(workspaceIdFromPath("/tmp/foo"));
    expect(workspaceIdFromPath("/tmp/foo")).not.toBe(workspaceIdFromPath("/tmp/bar"));
  });
});
