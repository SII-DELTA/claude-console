import type { IPty, PtyFactory, PtySpawnOptions } from "../pty.js";

export interface MockPtyHandle extends IPty {
  emit(data: string): void;
  exit(code: number | null, signal?: number | null): void;
  written: string[];
  killed: NodeJS.Signals | number | null;
  options: PtySpawnOptions;
}

export function createMockPtyFactory(): {
  factory: PtyFactory;
  ptys: MockPtyHandle[];
  last: () => MockPtyHandle;
} {
  const ptys: MockPtyHandle[] = [];
  const factory: PtyFactory = (opts) => {
    const dataCbs = new Set<(d: string) => void>();
    const exitCbs = new Set<(info: { exitCode: number | null; signal: number | null }) => void>();
    const handle: MockPtyHandle = {
      pid: 1,
      written: [],
      killed: null,
      options: opts,
      write(data) {
        this.written.push(data);
      },
      resize() {},
      kill(signal) {
        this.killed = signal ?? "SIGINT";
        for (const cb of exitCbs) cb({ exitCode: null, signal: 2 });
      },
      onData(cb) {
        dataCbs.add(cb);
      },
      onExit(cb) {
        exitCbs.add(cb);
      },
      emit(data) {
        for (const cb of dataCbs) cb(data);
      },
      exit(code, signal = null) {
        for (const cb of exitCbs) cb({ exitCode: code, signal });
      },
    };
    ptys.push(handle);
    return handle;
  };
  return {
    factory,
    ptys,
    last: () => {
      const p = ptys[ptys.length - 1];
      if (!p) throw new Error("no pty created yet");
      return p;
    },
  };
}
