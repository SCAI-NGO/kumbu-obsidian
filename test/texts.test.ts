// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import type { NotSynced } from "../src/engine/ports";
import { notSyncedNote, notSyncedSummary, reasonText } from "../src/obsidian/texts";

const tooLarge = (path: string): NotSynced => ({ path, reason: "too-large" });

test("each reason has its sentence", () => {
  expect(reasonText({ path: "report.docx", reason: "unsupported" })).toBe("This plugin syncs notes, PDFs and images only.");
  expect(reasonText({ path: "scan.pdf", reason: "too-large-in-kumbu" })).toBe(
    "Larger than 15 MB in Kumbu², so it isn't downloaded. It stays in Kumbu², where the web app can download it.");
  expect(reasonText({ path: "x.png", reason: "attachment" })).toBe("This Kumbu² server keeps notes only.");
  expect(reasonText({ path: "a.md", reason: "rejected", detail: "Not allowed." })).toBe("Not allowed.");
});

test("too large says the limit of the file's kind", () => {
  expect(reasonText(tooLarge("notes/big.md"))).toBe("Larger than 1 MiB.");
  expect(reasonText(tooLarge("Big.MD"))).toBe("Larger than 1 MiB.");
  for (const image of ["a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "F.PNG"]) {
    expect(reasonText(tooLarge(image))).toBe("Larger than 15 MB. Upload it in the Kumbu² web app, which can make it smaller.");
  }
  expect(reasonText(tooLarge("scans/big.pdf"))).toBe("Larger than 15 MB, the limit for PDFs.");
});

test("unsupported files count by kind like attachments", () => {
  expect(notSyncedSummary([{ path: "a.svg", reason: "unsupported" }, { path: "b.docx", reason: "unsupported" }])).toBe("1 image, 1 file");
});

test("the first sync's summary says why files stay behind", () => {
  expect(notSyncedNote([{ path: "x.png", reason: "attachment" }])).toBe(" (this Kumbu² server keeps notes only)");
  expect(notSyncedNote([{ path: "x.docx", reason: "unsupported" }])).toBe(" (this plugin syncs notes, PDFs and images only)");
  expect(notSyncedNote([tooLarge("a.pdf")])).toBe("");
});
