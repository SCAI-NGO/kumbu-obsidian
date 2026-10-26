// SPDX-License-Identifier: AGPL-3.0-or-later
// The plugin's sentences that depend on numbers, kept apart from the UI so they can be tested.
import type { NotSynced, SyncStatus } from "../engine/ports";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const files = (list: NotSynced[]) => list.filter((n) => n.reason !== "damaged-vault");

export function statusText(s: SyncStatus): string {
  const dot = s.mode === "offline" ? "○" : "●";
  const notSynced = files(s.notSynced).length;
  return `Kumbu² ${dot} ${s.mode}` + (notSynced > 0 ? ` · ${notSynced} not synced` : "");
}

export function differTitle(n: number, vault: string): string {
  return `${n} ${n === 1 ? "note differs" : "notes differ"} between this vault and ${vault}`;
}

export function choiceIntro(merging: number, differing: number): string {
  return `Same path on both sides, different text. Everything else merges by itself (${count(merging, "note", "notes")}). Choose once for all ${differing}:`;
}

export function resultHeadline(conflictCopies: number): string {
  return conflictCopies === 0 ? "✓ Done — no conflicts" : `✓ Done — ${count(conflictCopies, "conflict copy", "conflict copies")}`;
}

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** "2 images, 1 PDF": attachments by kind, then the other reasons. */
export function notSyncedSummary(list: NotSynced[]): string {
  let images = 0, pdfs = 0, others = 0, tooLarge = 0, rejected = 0, clashes = 0;
  for (const n of files(list)) {
    if (n.reason === "attachment") {
      const dot = n.path.lastIndexOf(".");
      const ext = dot > n.path.lastIndexOf("/") ? n.path.slice(dot + 1).toLowerCase() : "";
      if (IMAGES.has(ext)) images++;
      else if (ext === "pdf") pdfs++;
      else others++;
    } else if (n.reason === "too-large") tooLarge++;
    else if (n.reason === "rejected") rejected++;
    else if (n.reason === "case-clash") clashes++;
  }
  const parts: string[] = [];
  if (images) parts.push(count(images, "image", "images"));
  if (pdfs) parts.push(count(pdfs, "PDF", "PDFs"));
  if (others) parts.push(count(others, "file", "files"));
  if (tooLarge) parts.push(`${tooLarge} too large`);
  if (rejected) parts.push(`${rejected} rejected`);
  if (clashes) parts.push(count(clashes, "case clash", "case clashes"));
  return parts.join(", ");
}

export function hasAttachments(list: NotSynced[]): boolean {
  return list.some((n) => n.reason === "attachment");
}

/** One line per file for the settings: path and why. */
export function reasonText(n: NotSynced): string {
  switch (n.reason) {
    case "attachment": return "Attachment: Kumbu² keeps text only.";
    case "too-large": return "Larger than 1 MiB.";
    case "rejected": return n.detail ?? "Refused by the server.";
    case "case-clash": return n.detail ?? "Differs only in case from another note.";
    case "damaged-vault": return n.detail ?? "Some notes in Kumbu² can't be opened.";
  }
}
