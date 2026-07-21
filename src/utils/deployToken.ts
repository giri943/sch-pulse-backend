import { randomBytes, createHash } from "node:crypto";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Mint a new deploy token — returns the plaintext (show once), its hash, and a display prefix. */
export function generateDeployToken(): { raw: string; hash: string; prefix: string } {
  const raw = `pdt_${randomBytes(24).toString("hex")}`;
  return { raw, hash: sha256(raw), prefix: `${raw.slice(0, 12)}…` };
}
