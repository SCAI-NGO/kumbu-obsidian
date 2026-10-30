// SPDX-License-Identifier: AGPL-3.0-or-later
// Folder markers (.vaultkeep) through the engine: synced as empty files, and the folders they keep.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Choice, MergePlan } from "../src/engine/firstSync";
import { MARKER_VERSION } from "../src/engine/version";
import { harness, type Harness } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const EMPTY = new Uint8Array(0);
const putFiles = (h: Harness) => h.server.calls.filter((c) => c.method === "putFile");
const byteLengthOf = (call: { args: unknown[] }) => (call.args[1] as ArrayBuffer).byteLength;

/** Puts a marker on disk, on the server and in the bases, as an earlier sync would have left it. */
async function synced(h: Harness, path: string): Promise<void> {
  await h.server.seedFile(path, EMPTY);
  h.files.binaries.set(path, EMPTY.slice());
  h.state.state.bases[path] = MARKER_VERSION;
  await h.engine.stop();
  await h.engine.start();
  h.server.calls.length = 0;
}

describe("markers sync both ways", () => {
  test("a marker in Kumbu² makes its folder here", async () => {
    const h = await harness({ remoteFiles: { "Drafts/.vaultkeep": EMPTY } });
    expect(h.files.binaries.get("Drafts/.vaultkeep")).toEqual(EMPTY);
    expect(h.state.state.bases["Drafts/.vaultkeep"]).toBe(MARKER_VERSION);
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("a marker here is uploaded empty by the full check", async () => {
    const h = await harness({ start: false });
    h.files.binaries.set("Drafts/.vaultkeep", EMPTY);
    await h.engine.start();
    const puts = putFiles(h);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.args[0]).toBe("Drafts/.vaultkeep");
    expect(puts[0]!.args[2]).toBeNull();
    expect(byteLengthOf(puts[0]!)).toBe(0);
    expect(h.state.state.bases["Drafts/.vaultkeep"]).toBe(MARKER_VERSION);
  });

  test("a marker with content here is sent empty and makes no conflict copy", async () => {
    const kept = await harness({ start: false, remoteFiles: { "Drafts/.vaultkeep": EMPTY } });
    kept.files.binaries.set("Drafts/.vaultkeep", new Uint8Array([1, 2]));
    await kept.engine.start();
    expect(putFiles(kept)).toHaveLength(0);
    expect(kept.conflicts).toEqual([]);
    expect(kept.state.state.bases["Drafts/.vaultkeep"]).toBe(MARKER_VERSION);

    const fresh = await harness({ start: false });
    fresh.files.binaries.set("Drafts/.vaultkeep", new Uint8Array([1, 2]));
    await fresh.engine.start();
    const puts = putFiles(fresh);
    expect(puts).toHaveLength(1);
    expect(byteLengthOf(puts[0]!)).toBe(0);
    expect(fresh.conflicts).toEqual([]);
  });

  test("an nfd folder's marker is the server's nfc one", async () => {
    const nfd = "Bespréchung/.vaultkeep".normalize("NFD");
    const nfc = "Bespréchung/.vaultkeep".normalize("NFC");
    const h = await harness({ start: false, remoteFiles: { [nfc]: EMPTY } });
    h.files.binaries.set(nfd, EMPTY);
    await h.engine.start();
    expect(putFiles(h)).toHaveLength(0);
    expect(h.files.writes).toBe(0);
    expect(Object.keys(h.state.state.bases)).toEqual([nfc]);
  });

  test("other dot files stay ignored beside a marker", async () => {
    const h = await harness({ start: false });
    h.files.files.set(".obsidian/app.json", "{}");
    h.files.binaries.set("Drafts/.DS_Store", new Uint8Array([0]));
    h.files.binaries.set("Drafts/.vaultkeep", EMPTY);
    await h.engine.start();
    expect(putFiles(h).map((c) => c.args[0])).toEqual(["Drafts/.vaultkeep"]);
    expect(h.server.count("put")).toBe(0);
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("a folder holding a marker survives the left-empty sweep", async () => {
    const h = await harness({ synced: { "Drafts/a.md": "a" } });
    await synced(h, "Drafts/.vaultkeep");
    await h.server.agentWrite("Drafts/a.md", null);
    await h.engine.check(false);
    expect(h.files.files.has("Drafts/a.md")).toBe(false);
    expect(h.files.removedFolders).not.toContain("Drafts");
    expect(h.files.binaries.has("Drafts/.vaultkeep")).toBe(true);
  });

  test("a marker removed in Kumbu² takes its empty folder with it", async () => {
    const h = await harness();
    await synced(h, "Drafts/.vaultkeep");
    h.server.agentRemoveFile("Drafts/.vaultkeep");
    await h.engine.check(false);
    expect(h.files.binaries.has("Drafts/.vaultkeep")).toBe(false);
    expect(h.files.removedFolders).toContain("Drafts");
    expect(h.state.state.bases["Drafts/.vaultkeep"]).toBeUndefined();
  });

  test("a marker removed in Kumbu² leaves a folder that still holds notes", async () => {
    const h = await harness({ synced: { "Drafts/a.md": "a" } });
    await synced(h, "Drafts/.vaultkeep");
    h.server.agentRemoveFile("Drafts/.vaultkeep");
    await h.engine.check(false);
    expect(h.files.binaries.has("Drafts/.vaultkeep")).toBe(false);
    expect(h.files.removedFolders).not.toContain("Drafts");
    expect(h.files.files.get("Drafts/a.md")).toBe("a");
  });

  test("a folder moved in Kumbu² moves its marker here", async () => {
    const h = await harness();
    await synced(h, "Old/.vaultkeep");
    await h.server.move("Old/.vaultkeep", "New/.vaultkeep");
    h.server.calls.length = 0;
    await h.engine.check(false);
    expect(h.files.binaries.get("New/.vaultkeep")).toEqual(EMPTY);
    expect(h.files.binaries.has("Old/.vaultkeep")).toBe(false);
    expect(h.files.removedFolders).toContain("Old");
    expect(h.state.state.bases).toEqual({ "New/.vaultkeep": MARKER_VERSION });
  });

  test("markers are ignored on a server without attachments", async () => {
    const h = await harness({ start: false, oldServer: true });
    h.files.binaries.set("Drafts/.vaultkeep", EMPTY);
    await h.engine.start();
    await h.engine.check(true);
    expect(h.server.calls.map((c) => c.method)).toEqual(["versions", "versions"]);
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("the first sync syncs markers but never counts or asks about them", async () => {
    const h = await harness({
      start: false, localOnly: { "a.md": "a", "d.md": "local" }, remoteOnly: { "d.md": "kumbu" },
      remoteFiles: { "B/.vaultkeep": EMPTY, "C/.vaultkeep": EMPTY },
    });
    h.files.binaries.set("A/.vaultkeep", EMPTY);
    h.files.binaries.set("C/.vaultkeep", new Uint8Array([1]));
    const plans: MergePlan[] = [];
    const choose = (plan: MergePlan) => { plans.push(plan); return Promise.resolve<Choice | null>("both"); };
    const summary = await h.engine.firstSync(choose);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ toUpload: ["a.md"], toDownload: [], same: [], differing: ["d.md"], notSynced: [] });
    expect(summary).toEqual({ uploaded: 1, downloaded: 0, unchanged: 0, conflictCopies: 1, notSynced: [] });
    expect(h.state.state.bases).toMatchObject({ "A/.vaultkeep": MARKER_VERSION, "B/.vaultkeep": MARKER_VERSION, "C/.vaultkeep": MARKER_VERSION });
    expect(h.server.files.has("A/.vaultkeep")).toBe(true);
    expect(h.files.binaries.get("B/.vaultkeep")).toEqual(EMPTY);
  });
});
