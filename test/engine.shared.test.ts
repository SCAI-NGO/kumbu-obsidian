// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared vaults through the engine: what a refusal does, and conflict copies that name no device.
import { afterEach, describe, expect, test, vi } from "vitest";
import { KumbuApi, type HttpFn } from "../src/api/client";
import { FOLDER_SETTLE_MS, SyncEngine } from "../src/engine/engine";
import { FakeFiles } from "./fakes/fakeFiles";
import { fakeClock, harness, MemoryState, settle } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const READ_ONLY = "write: this key can only read vault Work";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...rest: number[]) => new Uint8Array([...PNG, ...rest]);

describe("a refused change", () => {
  test("a refused edit is listed, and the sync goes on", async () => {
    const h = await harness({ synced: { "plan.md": "one", "b.md": "b" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().mode).not.toBe("offline");
    expect(h.engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: READ_ONLY }]);
    expect(h.files.files.get("plan.md")).toBe("mine");
    expect(h.server.notes.get("plan.md")!.content).toBe("one");
    await h.server.agentWrite("b.md", "b2");
    await h.engine.check(false);
    expect(h.files.files.get("b.md")).toBe("b2");
  });

  test("a refused edit is not sent again until the file changes", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    await h.engine.check(true);
    expect(h.server.count("put")).toBe(1);
    h.files.userEdit("plan.md", "mine again");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.server.count("put")).toBe(2);
  });

  test("a refused new note is listed", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.files.set("new.md", "mine");
    h.engine.localChanged("new.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([{ path: "new.md", reason: "rejected", detail: READ_ONLY }]);
    expect(h.authLost).toBe(0);
  });

  test("a refused trash is listed and the note stays in Kumbu²", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => "rm: this key can only read vault Work";
    h.files.userDelete("plan.md");
    h.engine.localDeleted("plan.md");
    await settle(h);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: "rm: this key can only read vault Work" }]);
    expect(h.server.notes.has("plan.md")).toBe(true);
    await h.engine.check(true);
    expect(h.server.count("remove")).toBe(1);
  });

  test("a refused move lists both names and keeps the file", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userRename("a.md", "b.md");
    h.engine.localRenamed("a.md", "b.md");
    await settle(h);
    expect(h.server.count("move")).toBe(1);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().mode).not.toBe("offline");
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["a.md", "b.md"]);
    expect(h.files.files.get("b.md")).toBe("one");
    expect(h.server.notes.get("a.md")!.content).toBe("one");
    expect(h.server.notes.has("b.md")).toBe(false);
  });

  test("a refused attachment upload is listed", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.refuse = () => "upload: this key can only read vault Work";
    h.files.binaries.set("x.png", png(2));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced).toEqual([{ path: "x.png", reason: "rejected", detail: "upload: this key can only read vault Work" }]);
    expect(h.files.binaries.get("x.png")).toEqual(png(2));
    expect(h.server.files.get("x.png")?.bytes).toEqual(png(1));
  });

  test("a refused attachment trash is listed and the file stays in Kumbu²", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.refuse = () => "rm: this key can only read vault Work";
    h.files.userDelete("x.png");
    h.engine.localDeleted("x.png");
    await settle(h);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["x.png"]);
    expect(h.server.files.has("x.png")).toBe(true);
  });

  test("a device at write can't change the board's file, and the rest still syncs", async () => {
    const h = await harness({ synced: { "Board/Board.md": "board", "plan.md": "one" } });
    const sentence = "write: Only those who may maintain *Work* can change its board's file, Board/Board.md. This key is set to write; it takes a key with maintain.";
    h.server.refuse = (path) => (path === "Board/Board.md" ? sentence : null);
    h.files.userEdit("Board/Board.md", "mine");
    h.engine.localChanged("Board/Board.md");
    h.files.userEdit("plan.md", "two");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([{ path: "Board/Board.md", reason: "rejected", detail: sentence }]);
    expect(h.server.notes.get("plan.md")!.content).toBe("two");
    expect(h.authLost).toBe(0);
  });

  test("keep local refused in a first sync keeps the text and finishes", async () => {
    const h = await harness({ start: false, localOnly: { "d.md": "mine" }, remoteOnly: { "d.md": "kumbu" } });
    h.server.refuse = () => READ_ONLY;
    const summary = await h.engine.firstSync(() => Promise.resolve("local"));
    expect(summary!.notSynced).toContainEqual({ path: "d.md", reason: "rejected", detail: READ_ONLY });
    expect(h.files.files.get("d.md")).toBe("mine");
    expect(h.authLost).toBe(0);
    // The next check finds no base and decides a conflict: the file becomes Kumbu²'s text, and the chosen text moves
    // to a copy. Nothing is lost, though it isn't quite what "keep local" chose; see "Not built".
    await h.engine.check(true);
    expect([...h.files.files.values()].some((text) => text.includes("mine"))).toBe(true);
    expect(h.authLost).toBe(0);
  });
});

describe("over the real client", () => {
  const sync = async (reply: { status: number; body: unknown }) => {
    const http: HttpFn = (r) => {
      if (r.method === "PUT") return Promise.resolve({ status: reply.status, headers: {}, text: JSON.stringify(reply.body) });
      const body = r.url.endsWith("/api/vaults") ? [] : { full: true, cursor: "c", state: "s", damaged: 0, attachments: true, notes: [] };
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
    };
    const files = new FakeFiles();
    files.files.set("plan.md", "mine");
    let authLost = 0;
    const engine = new SyncEngine({
      vault: "Work", device: "Laptop", local: files, remote: new KumbuApi(http, "https://k.example", "Work", "kumbu_x"), state: new MemoryState(), clock: fakeClock,
      onStatus: () => undefined, onConflict: () => undefined, onAuthLost: () => { authLost++; },
    });
    await engine.start();
    return { engine, authLost: () => authLost };
  };

  test("a 403 with a code lists the file and keeps the key", async () => {
    const { engine, authLost } = await sync({ status: 403, body: { error: READ_ONLY, code: "read-only" } });
    expect(authLost()).toBe(0);
    expect(engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: READ_ONLY }]);
    await engine.stop();
  });

  test("a 403 without a code stops the sync as a lost key", async () => {
    const { authLost } = await sync({ status: 403, body: { error: "No." } });
    expect(authLost()).toBe(1);
  });
});

describe("a refused folder marker", () => {
  const EMPTY = new Uint8Array(0);

  test("a refused marker doesn't switch markers off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ start: false });
    h.files.binaries.set("A/.vaultkeep", EMPTY);
    h.files.binaries.set("B/.vaultkeep", EMPTY);
    h.server.refuse = () => READ_ONLY;
    await h.engine.start();
    expect(h.server.count("putFile")).toBe(2);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(h.authLost).toBe(0);
    await h.server.seedFile("C/.vaultkeep", EMPTY);
    await h.engine.check(false);
    expect(h.files.binaries.has("C/.vaultkeep")).toBe(true);
    await h.engine.check(true);
    expect(h.server.count("putFile")).toBe(2);
    warn.mockRestore();
  });

  test("a folder made in a read-only vault stays here, unlisted", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.folders.add("Drafts");
    h.engine.localFolderCreated("Drafts");
    await settle(h, FOLDER_SETTLE_MS + 2000);
    expect(h.files.binaries.has("Drafts/.vaultkeep")).toBe(true);
    expect(h.server.files.has("Drafts/.vaultkeep")).toBe(false);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(h.authLost).toBe(0);
  });
});
