// SPDX-License-Identifier: AGPL-3.0-or-later
// What the plugin announces of the engine's "not synced" list: files too large, and a server without attachments.
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../src/engine/engine";
import { announce } from "../src/obsidian/announce";
import { harness, settle } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...rest: number[]) => new Uint8Array([...PNG, ...rest]);
const pdf = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
};

describe("limits and what stays on the list", () => {
  test("a 16 MB pdf is not synced and announced once across two syncs", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set("scans/big.pdf", pdf(16 * 1024 * 1024));
    let announced: string[] = [];
    const notices: string[] = [];
    const sizeOf = (p: string) => h.files.binaries.get(p)?.byteLength ?? null;
    for (let sync = 0; sync < 2; sync++) {
      if (sync === 0) await h.engine.start();
      else await h.engine.check(true);
      const result = announce(announced, h.engine.status().notSynced, sizeOf);
      announced = result.announced;
      notices.push(...result.notices);
    }
    expect(h.server.count("putFile")).toBe(0);
    expect(h.server.files.size).toBe(0);
    expect(h.engine.status().notSynced).toEqual([{ path: "scans/big.pdf", reason: "too-large" }]);
    expect(notices).toEqual(["Kumbu² Sync: scans/big.pdf isn't synced. Larger than 15 MB, the limit for PDFs."]);
    expect(announced).toEqual(["scans/big.pdf"]);
  });

  test("several files too large in one sync share one notice", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    for (const p of ["a.pdf", "b.png", "c.pdf"]) h.files.binaries.set(p, pdf(MAX_ATTACHMENT_BYTES + 1));
    await h.engine.start();
    const sizeOf = (p: string) => h.files.binaries.get(p)?.byteLength ?? null;
    const step = announce([], h.engine.status().notSynced, sizeOf);
    expect(step.notices).toEqual(["Kumbu² Sync: 3 files are too large to sync. The settings list them under “Not synced”, with what to do."]);
    expect(step.announced).toEqual(["a.pdf", "b.png", "c.pdf"]);
    expect(announce(step.announced, h.engine.status().notSynced, sizeOf).notices).toEqual([]);
  });

  test("a file that shrinks below the limit syncs and is forgotten, so growing again is announced again", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(png());
    h.files.binaries.set("photo.png", big);
    const sizeOf = (p: string) => h.files.binaries.get(p)?.byteLength ?? null;
    await h.engine.start();
    let step = announce([], h.engine.status().notSynced, sizeOf);
    expect(step.notices).toEqual([
      "Kumbu² Sync: photo.png isn't synced. Larger than 15 MB. Upload it in the Kumbu² web app, which can make it smaller.",
    ]);

    // Before a check knows of it (a restart), a file that is still too large stays announced.
    step = announce(step.announced, [], sizeOf);
    expect(step.announced).toEqual(["photo.png"]);

    h.files.binaries.set("photo.png", png(1));
    h.engine.localChanged("photo.png");
    await settle(h, 2000);
    expect(h.server.files.get("photo.png")?.bytes).toEqual(png(1));
    step = announce(step.announced, h.engine.status().notSynced, sizeOf);
    expect(step).toEqual({ announced: [], notices: [], changed: true });

    h.files.binaries.set("photo.png", big);
    h.engine.localChanged("photo.png");
    await settle(h, 2000);
    step = announce(step.announced, h.engine.status().notSynced, sizeOf);
    expect(step.notices).toHaveLength(1);
    expect(h.server.files.get("photo.png")?.bytes).toEqual(png(1));
  });

  test("a deleted too-large file leaves the list and is forgotten", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set("big.pdf", pdf(MAX_ATTACHMENT_BYTES + 1));
    const sizeOf = (p: string) => h.files.binaries.get(p)?.byteLength ?? null;
    await h.engine.start();
    const first = announce([], h.engine.status().notSynced, sizeOf);
    h.files.userDelete("big.pdf");
    h.engine.localDeleted("big.pdf");
    await settle(h);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(announce(first.announced, h.engine.status().notSynced, sizeOf).announced).toEqual([]);
  });

  test("a docx stays on the list without a notice", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set("report.docx", new Uint8Array([0x50, 0x4b, 3, 4]));
    h.files.binaries.set("drawing.svg", new TextEncoder().encode("<svg/>"));
    await h.engine.start();
    const notSynced = h.engine.status().notSynced;
    expect(notSynced).toEqual([{ path: "drawing.svg", reason: "unsupported" }, { path: "report.docx", reason: "unsupported" }]);
    expect(announce([], notSynced, () => 4).notices).toEqual([]);
    expect(h.server.files.size).toBe(0);
    expect(h.server.count("putFile")).toBe(0);
  });

  test("a note larger than 1 MiB is announced too, with the notes' limit", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.files.set("big.md", "x".repeat(1_048_577));
    await h.engine.start();
    const step = announce([], h.engine.status().notSynced, (p) => (p === "big.md" ? 1_048_577 : null));
    expect(step.notices).toEqual(["Kumbu² Sync: big.md isn't synced. Larger than 1 MiB."]);
  });
});

describe("a server without attachments", () => {
  test("keeps today's behaviour: attachments listed, nothing sent", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" }, oldServer: true });
    h.files.binaries.set("x.png", png(1));
    h.files.binaries.set("big.pdf", pdf(MAX_ATTACHMENT_BYTES + 1));
    await h.engine.start();
    await h.engine.check(true);
    expect(h.engine.status().notSynced).toEqual([{ path: "big.pdf", reason: "attachment" }, { path: "x.png", reason: "attachment" }]);
    expect(announce([], h.engine.status().notSynced, () => 1).notices).toEqual([]);
    expect(h.server.calls.map((c) => c.method)).toEqual(["versions", "versions"]);
  });
});
