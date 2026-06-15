import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotenv } from "../util/dotenv.js";

describe("loadDotenv", () => {
  const keys = ["DOTENV_TEST_A", "DOTENV_TEST_B", "DOTENV_TEST_QUOTED", "DOTENV_TEST_EXISTING"];
  afterEach(() => keys.forEach((k) => delete process.env[k]));

  it("parses KEY=VALUE, skips comments, strips quotes, respects existing env", async () => {
    process.env.DOTENV_TEST_EXISTING = "real";
    const dir = await fs.mkdtemp(join(tmpdir(), "dotenv-"));
    const file = join(dir, ".env");
    await fs.writeFile(
      file,
      ["# a comment", "DOTENV_TEST_A=hello", 'DOTENV_TEST_QUOTED="with spaces"', "", "DOTENV_TEST_EXISTING=fromfile"].join("\n"),
    );
    expect(loadDotenv(file)).toBe(true);
    expect(process.env.DOTENV_TEST_A).toBe("hello");
    expect(process.env.DOTENV_TEST_QUOTED).toBe("with spaces");
    expect(process.env.DOTENV_TEST_EXISTING).toBe("real"); // not overridden
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns false when the file is missing", () => {
    expect(loadDotenv("/no/such/.env")).toBe(false);
  });
});
