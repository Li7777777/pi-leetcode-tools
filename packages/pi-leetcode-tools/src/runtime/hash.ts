import { createHash } from "node:crypto";

export type HashInput = string | Uint8Array;

export function sha256Hex(input: HashInput): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Digest(input: HashInput): string {
  return `sha256:${sha256Hex(input)}`;
}
