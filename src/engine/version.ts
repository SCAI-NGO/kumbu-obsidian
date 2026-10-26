// SPDX-License-Identifier: AGPL-3.0-or-later
// Version tokens exactly as the server computes them (VersionToken.Of).
import type { Version } from "./ports";

export const MAX_BYTES = 1_048_576;

const encoder = new TextEncoder();

export function normaliseText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function byteSize(text: string): number {
  return encoder.encode(normaliseText(text)).byteLength;
}

export async function versionOf(text: string): Promise<Version> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normaliseText(text)));
  return toHex(new Uint8Array(digest)).slice(0, 12);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
