// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import type { NotSynced, SyncStatus } from "../src/engine/ports";
import { choiceIntro, differTitle, notSyncedSummary, resultHeadline, statusText } from "../src/obsidian/texts";

const status = (o: Partial<SyncStatus>): SyncStatus => ({ mode: "live", notSynced: [], conflicts: [], busy: false, lastSyncAt: null, ...o });
const att = (path: string): NotSynced => ({ path, reason: "attachment" });

test("status bar text", () => {
  expect(statusText(status({ notSynced: [att("a.png"), att("b.png"), { path: "c.md", reason: "too-large" }] }))).toBe("Kumbu² ● live · 3 not synced");
  expect(statusText(status({ mode: "polling" }))).toBe("Kumbu² ● polling");
  expect(statusText(status({ mode: "offline", notSynced: [att("a.png")] }))).toBe("Kumbu² ○ offline · 1 not synced");
});
test("the damaged-vault notice is not a file and not counted", () => {
  expect(statusText(status({ notSynced: [{ path: "", reason: "damaged-vault", detail: "x" }] }))).toBe("Kumbu² ● live");
});
test("differ title", () => {
  expect(differTitle(7, "Work")).toBe("7 notes differ between this vault and Work");
  expect(differTitle(1, "Work")).toBe("1 note differs between this vault and Work");
});
test("choice intro", () => {
  expect(choiceIntro(12, 7)).toBe("Same path on both sides, different text. Everything else merges by itself (12 notes). Choose once for all 7:");
  expect(choiceIntro(1, 1)).toBe("Same path on both sides, different text. Everything else merges by itself (1 note). Choose once for all 1:");
});
test("not synced summary groups attachments by kind", () => {
  expect(notSyncedSummary([att("a.png"), att("b.jpg"), att("c.pdf")])).toBe("2 images, 1 PDF");
  expect(notSyncedSummary([att("a.PNG"), att("x/b.webp"), att("c.pdf"), att("d.pdf"), att("e.zip"), att("f")])).toBe("2 images, 2 PDFs, 2 files");
  expect(notSyncedSummary([
    { path: "a.md", reason: "too-large" }, { path: "b.md", reason: "rejected", detail: "x" }, { path: "c.md", reason: "case-clash" },
    { path: "d.md", reason: "case-clash" }, { path: "", reason: "damaged-vault" },
  ])).toBe("1 too large, 1 rejected, 2 case clashes");
  expect(notSyncedSummary([])).toBe("");
});
test("result headline", () => {
  expect(resultHeadline(0)).toBe("✓ Done — no conflicts");
  expect(resultHeadline(1)).toBe("✓ Done — 1 conflict copy");
  expect(resultHeadline(3)).toBe("✓ Done — 3 conflict copies");
});
