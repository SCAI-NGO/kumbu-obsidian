// SPDX-License-Identifier: AGPL-3.0-or-later
// Paths between the Obsidian vault and the server, and the names derived from them.
import { versionOfSync } from "./version";

/** "Besprechung März.md" → "/Work/Besprechung März.md", NFC (macOS and some Android file systems hand out NFD). */
export function toApiPath(vault: string, path: string): string {
  return `/${vault}/${path}`.normalize("NFC");
}

export function fromApiPath(vault: string, apiPath: string): string {
  const prefix = `/${vault}/`;
  const nfc = apiPath.normalize("NFC");
  const p = prefix.normalize("NFC");
  return nfc.startsWith(p) ? nfc.slice(p.length) : nfc.replace(/^\/+/, "");
}

/** The note's REST URL path, each segment encoded like the web app's noteUrl. */
export function urlFor(vault: string, path: string): string {
  return apiUrl("notes", vault, path);
}

/** The attachment's REST URL path (GET/PUT/DELETE /api/files), encoded as a note's. */
export function fileUrlFor(vault: string, path: string): string {
  return apiUrl("files", vault, path);
}

function apiUrl(api: "notes" | "files", vault: string, path: string): string {
  const segments = [vault, ...path.normalize("NFC").split("/")];
  return `/api/${api}/` + segments.map(encodeURIComponent).join("/");
}

export function eligibility(path: string): "sync" | "attachment" | "ignored" {
  const segments = path.split("/");
  if (segments.some((s) => s.startsWith("."))) return "ignored";
  return path.toLowerCase().endsWith(".md") ? "sync" : "attachment";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "projects/Plan.md" → "projects/Plan (conflict Laptop 2026-10-27 10-15).md", local time. */
export function conflictCopyPath(path: string, device: string, at: Date): string {
  const stem = path.replace(/\.md$/i, "");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return `${stem} (conflict ${device} ${stamp}).md`;
}

export function slug(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * SecretStorage ids must be lowercase alphanumerics and dashes. SecretStorage is shared by every vault of the app,
 * so a short hash of the exact Kumbu² vault name and the Obsidian vault's name keeps ids apart that the slug folds
 * together ("Büro" and "Buro", names without Latin letters, two Obsidian vaults paired with one Kumbu² vault).
 */
export function secretId(vault: string, device: string, localVault: string): string {
  const hash = versionOfSync(`${vault}\n${localVault}`).slice(0, 6);
  return ["kumbu", slug(vault), hash, slug(device)].filter((part) => part !== "").join("-");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function defaultDeviceName(platform: string, random: () => number): string {
  const pick = () => CROCKFORD[Math.min(CROCKFORD.length - 1, Math.floor(random() * CROCKFORD.length))];
  return `${platform}-${pick()}${pick()}`;
}

/** At most 32 characters: letters, digits, spaces, "-" and "_" (the server cuts writer labels at " ("). */
export function isValidDeviceName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 32 && /^[\p{L}\p{N} _-]+$/u.test(trimmed);
}

export function isAllowedServerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
}

const URL_RULE = "The server URL must start with https:// (http:// only for localhost).";

/** Null when a key may be sent to this server, else the sentence to show. */
export function serverProblem(url: string): string | null {
  return isAllowedServerUrl(url) ? null : URL_RULE;
}
