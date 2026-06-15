import { createHash, randomBytes } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Numeric pair code (8 digits). Easy to read on a phone screen.
 */
export function generatePairCode(length = 8): string {
  const max = 10 ** length;
  const n = randomBytes(8).readBigUInt64BE(0) % BigInt(max);
  return n.toString().padStart(length, "0");
}

export function workspaceIdFromPath(absolutePath: string): string {
  return sha256(absolutePath).slice(0, 16);
}

const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /token=([A-Za-z0-9._\-+/=]+)/gi,
  /"token"\s*:\s*"([^"]+)"/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pat of TOKEN_PATTERNS) {
    out = out.replace(pat, (m) => m.replace(/[A-Za-z0-9._\-+/=]{8,}/g, "***"));
  }
  return out;
}
