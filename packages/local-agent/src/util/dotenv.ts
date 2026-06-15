import { readFileSync } from "node:fs";

/**
 * Minimal .env loader (zero deps). Parses `KEY=VALUE` lines, ignores blanks and
 * `#` comments, strips surrounding quotes. Only sets vars NOT already present in
 * process.env, so real environment variables always take precedence.
 * Returns true if the file existed and was read.
 */
export function loadDotenv(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  return true;
}
