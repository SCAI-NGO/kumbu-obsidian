// SPDX-License-Identifier: AGPL-3.0-or-later
// PDFs and images through the engine, on a server that keeps them: binary sync both ways, conflicts, limits.
import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../src/engine/engine";
import { OfflineError, RejectedError } from "../src/engine/ports";
import { versionOfBytes } from "../src/engine/version";
import { announce } from "../src/obsidian/announce";
import { harness, settle, type Harness } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...rest: number[]) => new Uint8Array([...PNG, ...rest]);
const pdf = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  return bytes;
};
const bytesOf = (h: Harness, path: string) => h.files.binaries.get(path);

/** Puts an attachment on disk and in the bases, as an earlier sync would have left it. */
async function synced(h: Harness, path: string, bytes: Uint8Array): Promise<void> {
  await h.server.seedFile(path, bytes);
  h.files.binaries.set(path, bytes.slice());
  h.state.state.bases[path] = await versionOfBytes(bytes);
  await h.engine.stop();
  await h.engine.start();
  h.server.calls.length = 0;
}

describe("attachments sync both ways", () => {
  test("uploads a new png and downloads one the server has", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" }, remoteFiles: { "img/theirs.png": png(2) } });
    h.files.binaries.set("img/mine.png", png(1));
    await h.engine.start();
    expect(h.server.files.get("img/mine.png")?.bytes).toEqual(png(1));
    expect(bytesOf(h, "img/theirs.png")).toEqual(png(2));
    expect(h.state.state.bases["img/mine.png"]).toBe(await versionOfBytes(png(1)));
    expect(h.state.state.bases["img/theirs.png"]).toBe(await versionOfBytes(png(2)));
    expect(h.engine.status().notSynced).toEqual([]);
    // Nothing went through the notes API.
    expect(h.server.notes.has("img/mine.png")).toBe(false);
  });

  test("a changed file is sent whole over its base, and an agent's change arrives", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "x.png", png(1));
    h.files.binaries.set("x.png", png(1, 2, 3));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    const put = h.server.calls.find((c) => c.method === "putFile")!;
    expect(new Uint8Array(put.args[1] as ArrayBuffer)).toEqual(png(1, 2, 3));
    expect(put.args[2]).toBe(await versionOfBytes(png(1)));

    await h.server.seedFile("x.png", png(7));
    await h.engine.check(false);
    expect(bytesOf(h, "x.png")).toEqual(png(7));
  });

  test("a change on both sides gives a conflict copy keeping .png", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "layout_editor_bad1.png", png(1));
    vi.setSystemTime(new Date(2026, 9, 27, 22, 15));
    await h.server.seedFile("layout_editor_bad1.png", png(2));
    h.files.binaries.set("layout_editor_bad1.png", png(3));
    await h.engine.check(false);
    const copy = "layout_editor_bad1 (conflict Laptop 2026-10-27 22-15).png";
    expect(h.conflicts).toEqual([["layout_editor_bad1.png", copy]]);
    expect(bytesOf(h, "layout_editor_bad1.png")).toEqual(png(2));
    expect(bytesOf(h, copy)).toEqual(png(3));
    expect(h.server.files.get(copy)?.bytes).toEqual(png(3));
    expect(h.engine.status().conflicts).toEqual([copy]);
  });

  test("a local delete trashes the attachment in Kumbu²", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "x.pdf", pdf(100));
    h.files.userDelete("x.pdf");
    h.engine.localDeleted("x.pdf");
    await settle(h);
    expect(h.server.files.has("x.pdf")).toBe(false);
    expect(h.state.state.bases["x.pdf"]).toBeUndefined();
  });

  test("a local rename moves the attachment in Kumbu²", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "x.png", png(1));
    h.files.userRename("x.png", "img/y.png");
    h.engine.localRenamed("x.png", "img/y.png");
    await settle(h);
    expect(h.server.calls.map((c) => c.method)).toEqual(["move"]);
    expect(h.server.files.has("x.png")).toBe(false);
    expect(h.server.files.get("img/y.png")?.bytes).toEqual(png(1));
    expect(h.state.state.bases).toMatchObject({ "img/y.png": await versionOfBytes(png(1)) });
  });

  // An incremental answer names deleted paths without a kind: an attachment's extension says what it was.
  test("an attachment trashed in Kumbu² arrives as a path without version or kind and goes to the trash", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "x.png", png(1));
    await h.server.removeFile("x.png", await versionOfBytes(png(1)));
    h.server.calls.length = 0;
    const answer = await h.server.versions(h.state.state.cursor, null);
    expect(answer.entries).toContainEqual({ path: "x.png", version: null });
    await h.engine.check(false);
    expect(h.files.binaries.has("x.png")).toBe(false);
    expect(h.files.systemTrash).toEqual(["x.png"]);
    expect(h.state.state.bases["x.png"]).toBeUndefined();
  });

  test("an attachment trashed in Kumbu² but changed here is uploaded again, not trashed", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    await synced(h, "x.png", png(1));
    await h.server.removeFile("x.png", await versionOfBytes(png(1)));
    h.files.binaries.set("x.png", png(1, 9));
    await h.engine.check(false);
    expect(h.files.systemTrash).toEqual([]);
    expect(h.server.files.get("x.png")?.bytes).toEqual(png(1, 9));
  });

  test("files added while the server couldn't be reached sync once it says it keeps them", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    const at = new Date(Date.now() - 60_000).toISOString();
    h.state.state = { ...h.state.state, cursor: at, lastSyncAt: at, lastFullAt: at };
    h.server.failNext("versions", new OfflineError("down"));
    await h.engine.start();
    h.files.binaries.set("x.png", png(1));
    h.engine.localChanged("x.png");
    expect(h.engine.status().notSynced).toEqual([{ path: "x.png", reason: "attachment" }]);
    // The retry is an incremental check, which knows nothing of x.png: the local side is looked at once more.
    await settle(h, 5000);
    expect(h.server.calls.filter((c) => c.method === "versions").map((c) => c.args[0])).toEqual([null, at]);
    expect(h.server.files.get("x.png")?.bytes).toEqual(png(1));
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("an nfd file name syncs as its nfc spelling", async () => {
    const nfd = "Bespréchung.png";
    const nfc = "Besprechung.png".replace("ec", "éc");
    expect(nfd.normalize("NFC")).toBe(nfc);
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set(nfd, png(1));
    await h.engine.start();
    expect([...h.server.files.keys()]).toEqual([nfc]);
    expect(h.state.state.bases[nfc]).toBe(await versionOfBytes(png(1)));
    // The server's change lands in the file as the file system spells it, not in a second one.
    await h.server.seedFile(nfc, png(2));
    await h.engine.check(false);
    expect([...h.files.binaries.keys()]).toEqual([nfd]);
    expect(bytesOf(h, nfd)).toEqual(png(2));
  });
});

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

  test("the limit is 15 MB exactly", async () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(15_728_640);
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set("fits.pdf", pdf(MAX_ATTACHMENT_BYTES));
    h.files.binaries.set("over.pdf", pdf(MAX_ATTACHMENT_BYTES + 1));
    await h.engine.start();
    expect([...h.server.files.keys()]).toEqual(["fits.pdf"]);
    expect(h.engine.status().notSynced).toEqual([{ path: "over.pdf", reason: "too-large" }]);
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

  test("a file whose content the server refuses is listed with the server's sentence", async () => {
    const h = await harness({ start: false, synced: { "a.md": "one" } });
    h.files.binaries.set("fake.png", new TextEncoder().encode("MZ not an image"));
    const realPut = h.server.putFile.bind(h.server);
    h.server.putFile = (path, bytes, base) => (path === "fake.png"
      ? Promise.reject(new RejectedError("The content of fake.png is not a PNG image.", 400))
      : realPut(path, bytes, base));
    await h.engine.start();
    expect(h.engine.status().notSynced).toEqual([{ path: "fake.png", reason: "rejected", detail: "The content of fake.png is not a PNG image." }]);
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

describe("the first sync", () => {
  test("merges attachments like notes, asking once for the ones that differ", async () => {
    const h = await harness({
      start: false, localOnly: { "a.md": "a" }, remoteFiles: { "same.png": png(1), "differs.png": png(2), "theirs.pdf": pdf(10) },
    });
    h.files.binaries.set("same.png", png(1));
    h.files.binaries.set("differs.png", png(3));
    h.files.binaries.set("mine.png", png(4));
    const summary = await h.engine.firstSync(() => Promise.resolve("kumbu"));
    expect(summary).toMatchObject({ uploaded: 2, downloaded: 2, unchanged: 1, conflictCopies: 0 });
    expect(bytesOf(h, "differs.png")).toEqual(png(2));
    expect(h.files.trash).toEqual(["differs.png"]);
    expect(bytesOf(h, "theirs.pdf")).toEqual(pdf(10));
    expect(h.server.files.get("mine.png")?.bytes).toEqual(png(4));
  });

  test("keep local replaces Kumbu²'s attachment", async () => {
    const h = await harness({ start: false, remoteFiles: { "differs.png": png(2) } });
    h.files.binaries.set("differs.png", png(3));
    const summary = await h.engine.firstSync(() => Promise.resolve("local"));
    expect(summary).toMatchObject({ uploaded: 1, downloaded: 0 });
    expect(h.server.files.get("differs.png")?.bytes).toEqual(png(3));
  });
});
