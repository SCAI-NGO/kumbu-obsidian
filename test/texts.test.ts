// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import type { NotSynced } from "../src/engine/ports";
import { notSyncedNote, notSyncedSummary, reasonText } from "../src/obsidian/texts";

const tooLarge = (path: string): NotSynced => ({ path, reason: "too-large" });

test("each reason has its sentence", () => {
  expect(reasonText({ path: "report.docx", reason: "unsupported" })).toBe("Kumbu² keeps notes, PDFs and images only.");
  expect(reasonText({ path: "x.png", reason: "attachment" })).toBe("Attachment: Kumbu² keeps text only.");
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
  expect(notSyncedNote([{ path: "x.png", reason: "attachment" }])).toBe(" (Kumbu² keeps text only)");
  expect(notSyncedNote([{ path: "x.docx", reason: "unsupported" }])).toBe(" (Kumbu² keeps notes, PDFs and images only)");
  expect(notSyncedNote([tooLarge("a.pdf")])).toBe("");
});
