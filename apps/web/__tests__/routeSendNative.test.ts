import { describe, it, expect } from "vitest";
import { routeSendNative, desktopModeIsNative, type IdeState } from "../lib/store";

const SID = "s1";
const activeIde: IdeState = {
  projects: [{ cwd: "/p", hasVscode: true, hasPlugin: true }],
  sessions: [{ sessionId: SID, cwd: "/p", state: "idle", alive: true, terminal: false, inVscode: true }],
};
const inactiveIde: IdeState = {
  projects: [{ cwd: "/p", hasVscode: true, hasPlugin: true }],
  sessions: [], // session not running on the desktop
};

describe("desktopModeIsNative (pure resolution)", () => {
  it("auto and native → native; takeover → agent", () => {
    expect(desktopModeIsNative("auto")).toBe(true);
    expect(desktopModeIsNative("native")).toBe(true);
    expect(desktopModeIsNative("takeover")).toBe(false);
  });
});

describe("routeSendNative", () => {
  it("returns false without a selected session or without a VSCode window", () => {
    expect(routeSendNative({ selectedId: null, hasVscode: true, ideState: activeIde })).toBe(false);
    expect(routeSendNative({ selectedId: SID, hasVscode: false, ideState: activeIde })).toBe(false);
  });

  it("default (auto) → native for both active and inactive sessions", () => {
    // no route configured → getDesktopRoute defaults to "auto" → native
    expect(routeSendNative({ selectedId: SID, hasVscode: true, ideState: activeIde })).toBe(true);
    expect(routeSendNative({ selectedId: SID, hasVscode: true, ideState: inactiveIde })).toBe(true);
  });
});
