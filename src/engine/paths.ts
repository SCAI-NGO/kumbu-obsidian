// SPDX-License-Identifier: AGPL-3.0-or-later
// Paths between the Obsidian vault and the server, and the names derived from them.

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
  const segments = [vault, ...path.normalize("NFC").split("/")];
  return "/api/notes/" + segments.map(encodeURIComponent).join("/");
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

/** SecretStorage ids must be lowercase alphanumerics and dashes. */
export function secretId(vault: string, device: string): string {
  return `kumbu-${slug(vault)}-${slug(device)}`;
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
