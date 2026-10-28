// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import type { App } from "obsidian";
import { MarkdownView, TFile, TFolder } from "./fakes/obsidian";
import { VaultFiles } from "../src/obsidian/vaultFiles";
import { versionOfBytes, versionOfSync } from "../src/engine/version";

/** A vault of files on disk and editors open on some of them, shaped like the parts of App the adapter uses. */
function fakeApp(disk: Record<string, string>) {
  const files = new Map(Object.entries(disk));
  const views: MarkdownView[] = [];
  const processed: string[] = [];
  let whileProcessing: (() => void) | null = null;
  let whileReading: (() => void) | null = null;
  const trashed: string[] = [];
  const app = {
    vault: {
      getFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
      getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
      // Asynchronous like Obsidian's: an editor can change while the disk is read.
      read: async (f: TFile) => {
        const data = files.get(f.path)!;
        await Promise.resolve();
        whileReading?.();
        whileReading = null;
        return data;
      },
      // Asynchronous like Obsidian's: it reads the file first, then runs the callback and writes in one step.
      process: async (f: TFile, fn: (data: string) => string) => {
        processed.push(f.path);
        await Promise.resolve();
        whileProcessing?.();
        whileProcessing = null;
        const data = files.get(f.path)!;
        const next = fn(data);
        files.set(f.path, next);
        // Obsidian reloads an open editor from an external change.
        if (next !== data) for (const v of views) if (v.file?.path === f.path) v.buffer = next;
        return next;
      },
      create: (p: string, text: string) => {
        if (files.has(p)) return Promise.reject(new Error("File already exists."));
        files.set(p, text);
        return Promise.resolve(new TFile(p));
      },
      createFolder: () => Promise.resolve(),
      getFiles: () => [...files.keys()].map((p) => new TFile(p)),
    },
    workspace: { getLeavesOfType: (type: string) => (type === "markdown" ? views.map((view) => ({ view })) : []) },
    fileManager: {
      trashFile: (f: TFile) => { trashed.push(f.path); files.delete(f.path); return Promise.resolve(); },
    },
  };
  const open = (path: string, buffer: string) => {
    const view = new MarkdownView(new TFile(path), buffer, (text) => files.set(path, text));
    views.push(view);
    return view;
  };
  const duringProcess = (fn: () => void) => { whileProcessing = fn; };
  const duringRead = (fn: () => void) => { whileReading = fn; };
  return { app: app as unknown as App, files, open, processed, duringProcess, duringRead, trashed };
}

test("read gives the text in an open editor, saved or not", async () => {
  const f = fakeApp({ "a.md": "on disk" });
  f.open("a.md", "on disk, and typed");
  expect(await new VaultFiles(f.app).read("a.md")).toBe("on disk, and typed");
});

test("a write never replaces text that is only in an open editor", async () => {
  const f = fakeApp({ "a.md": "base" });
  f.open("a.md", "base plus unsaved typing");
  const files = new VaultFiles(f.app);
  // Disk is still at the expected version; the editor is not.
  expect(await files.writeIf("a.md", versionOfSync("base"), "agent text")).toBe(false);
  expect(f.files.get("a.md")).toBe("base");
});

test("an open editor that matches is replaced through the editor and saved", async () => {
  const f = fakeApp({ "a.md": "base" });
  const view = f.open("a.md", "typed and matching");
  const files = new VaultFiles(f.app);
  expect(await files.writeIf("a.md", versionOfSync("typed and matching"), "agent text")).toBe(true);
  expect(view.buffer).toBe("agent text");
  expect(f.files.get("a.md")).toBe("agent text");
});

test("a keystroke while the editor is being saved is never overwritten", async () => {
  const f = fakeApp({ "a.md": "base" });
  const view = f.open("a.md", "base");
  view.whileSaving = () => { view.buffer += " typed"; };
  f.duringProcess(() => { view.buffer += " typed"; });
  const files = new VaultFiles(f.app);
  await files.writeIf("a.md", versionOfSync("base"), "agent text");
  // Typed after the check: it stays in the editor, on top of whatever is there now.
  expect(view.buffer).toContain(" typed");
});

test("the editor's cursor and scroll stay where they were, as far as the new text allows", async () => {
  const f = fakeApp({ "a.md": "line one\nline two" });
  const view = f.open("a.md", "line one\nline two");
  view.editor.setCursor({ line: 1, ch: 4 });
  view.editor.scrollTo(0, 120);
  await new VaultFiles(f.app).writeIf("a.md", versionOfSync("line one\nline two"), "line one\nline 2 and more");
  expect(view.editor.getCursor()).toEqual({ line: 1, ch: 4 });
  expect(view.editor.getScrollInfo()).toEqual({ top: 120, left: 0 });
});

test("a file opened and typed in while it is written is not overwritten", async () => {
  const f = fakeApp({ "a.md": "base" });
  f.duringProcess(() => { f.open("a.md", "base and typing"); });
  expect(await new VaultFiles(f.app).writeIf("a.md", versionOfSync("base"), "agent text")).toBe(false);
  expect(f.files.get("a.md")).toBe("base");
});

test("a changed file on disk is not written", async () => {
  const f = fakeApp({ "a.md": "changed" });
  expect(await new VaultFiles(f.app).writeIf("a.md", versionOfSync("base"), "agent text")).toBe(false);
  expect(f.files.get("a.md")).toBe("changed");
});

test("a create that meets a file made meanwhile reports false", async () => {
  const f = fakeApp({});
  const files = new VaultFiles(f.app);
  const create = f.app.vault.create.bind(f.app.vault);
  (f.app.vault as { create: unknown }).create = (p: string, t: string) => {
    f.files.set(p, "someone else");
    return create(p, t);
  };
  expect(await files.writeIf("n.md", null, "mine")).toBe(false);
  expect(f.files.get("n.md")).toBe("someone else");
});

test("trashIf trashes a note whose disk and editor text are still the expected version", async () => {
  const f = fakeApp({ "a.md": "base" });
  f.open("a.md", "base");
  expect(await new VaultFiles(f.app).trashIf("a.md", versionOfSync("base"))).toBe(true);
  expect(f.trashed).toEqual(["a.md"]);
});

test("trashIf keeps a note with unsaved typing in an open editor", async () => {
  const f = fakeApp({ "a.md": "base" });
  f.open("a.md", "base plus unsaved typing");
  expect(await new VaultFiles(f.app).trashIf("a.md", versionOfSync("base"))).toBe(false);
  expect(f.trashed).toEqual([]);
});

test("trashIf keeps a note typed in while its file is read", async () => {
  const f = fakeApp({ "a.md": "base" });
  const view = f.open("a.md", "base");
  f.duringRead(() => { view.buffer += " typed"; });
  expect(await new VaultFiles(f.app).trashIf("a.md", versionOfSync("base"))).toBe(false);
  expect(f.trashed).toEqual([]);
});

test("trashIf keeps a note changed on disk", async () => {
  const f = fakeApp({ "a.md": "changed" });
  expect(await new VaultFiles(f.app).trashIf("a.md", versionOfSync("base"))).toBe(false);
  expect(f.trashed).toEqual([]);
});

describe("binary files", () => {
  /** A vault of binary files, with the Vault calls the adapter uses for them. */
  function binaryApp(disk: Record<string, Uint8Array>) {
    const files = new Map(Object.entries(disk).map(([p, b]) => [p, b.slice().buffer]));
    let whileReading: (() => void) | null = null;
    const app = {
      vault: {
        getFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
        getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
        readBinary: async (f: TFile) => {
          const data = files.get(f.path)!;
          await Promise.resolve();
          whileReading?.();
          whileReading = null;
          return data;
        },
        createBinary: (p: string, data: ArrayBuffer) => {
          if (files.has(p)) return Promise.reject(new Error("File already exists."));
          files.set(p, data);
          return Promise.resolve(new TFile(p));
        },
        modifyBinary: (f: TFile, data: ArrayBuffer) => { files.set(f.path, data); return Promise.resolve(); },
        createFolder: () => Promise.resolve(),
      },
    };
    return { app: app as unknown as App, files, duringRead: (fn: () => void) => { whileReading = fn; } };
  }
  const bytes = (...b: number[]) => new Uint8Array(b);

  test("readBinary gives the bytes as they are, null for a missing file", async () => {
    const f = binaryApp({ "a.png": bytes(0x89, 0x0d, 0x0a) });
    const files = new VaultFiles(f.app);
    expect(new Uint8Array((await files.readBinary("a.png"))!)).toEqual(bytes(0x89, 0x0d, 0x0a));
    expect(await files.readBinary("b.png")).toBeNull();
  });

  test("writeBinaryIf creates a missing file, never one made meanwhile", async () => {
    const f = binaryApp({});
    const files = new VaultFiles(f.app);
    expect(await files.writeBinaryIf("img/a.png", null, bytes(1, 2).buffer)).toBe(true);
    expect(new Uint8Array(f.files.get("img/a.png")!)).toEqual(bytes(1, 2));
    expect(await files.writeBinaryIf("img/a.png", null, bytes(3).buffer)).toBe(false);
    expect(new Uint8Array(f.files.get("img/a.png")!)).toEqual(bytes(1, 2));
  });

  test("writeBinaryIf replaces a file only at the expected version", async () => {
    const f = binaryApp({ "a.png": bytes(1, 2) });
    const files = new VaultFiles(f.app);
    expect(await files.writeBinaryIf("a.png", await versionOfBytes(bytes(9)), bytes(3).buffer)).toBe(false);
    expect(await files.writeBinaryIf("a.png", null, bytes(3).buffer)).toBe(false);
    expect(new Uint8Array(f.files.get("a.png")!)).toEqual(bytes(1, 2));
    expect(await files.writeBinaryIf("a.png", await versionOfBytes(bytes(1, 2)), bytes(3).buffer)).toBe(true);
    expect(new Uint8Array(f.files.get("a.png")!)).toEqual(bytes(3));
  });

  test("writeBinaryIf passes on a failed create that no other file explains", async () => {
    const f = binaryApp({});
    (f.app.vault as { createBinary: unknown }).createBinary = () => Promise.reject(new Error("The disk is full."));
    await expect(new VaultFiles(f.app).writeBinaryIf("a.png", null, bytes(1).buffer)).rejects.toThrow("The disk is full.");
  });

  test("writeBinaryIf with a version for a missing file writes nothing", async () => {
    const f = binaryApp({});
    expect(await new VaultFiles(f.app).writeBinaryIf("a.png", "aaaaaaaaaaaa", bytes(3).buffer)).toBe(false);
    expect(f.files.size).toBe(0);
  });
});

describe("removeFolderIfEmpty", () => {
  /** A folder as Obsidian's index has it (no dot files) and as the adapter lists it on disk (dot files too). */
  function folderApp(indexed: string[], onDisk: string[]) {
    const deleted: string[] = [];
    const app = {
      vault: {
        getFolderByPath: (p: string) => (p === "a" ? Object.assign(new TFolder("a"), { children: indexed.map((c) => new TFile(c)) }) : null),
        adapter: { list: () => Promise.resolve({ files: onDisk, folders: [] }) },
        delete: (f: TFolder) => { deleted.push(f.path); return Promise.resolve(); },
      },
    };
    return { app: app as unknown as App, deleted };
  }

  test("deletes an empty folder through the vault", async () => {
    const f = folderApp([], []);
    expect(await new VaultFiles(f.app).removeFolderIfEmpty("a")).toBe(true);
    expect(f.deleted).toEqual(["a"]);
  });

  test("keeps a folder with a file in it, of any kind", async () => {
    const f = folderApp(["a/picture.png"], ["a/picture.png"]);
    expect(await new VaultFiles(f.app).removeFolderIfEmpty("a")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("keeps a folder whose only file is a dot file Obsidian doesn't index", async () => {
    const f = folderApp([], ["a/.DS_Store"]);
    expect(await new VaultFiles(f.app).removeFolderIfEmpty("a")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("does nothing for a folder that isn't there", async () => {
    const f = folderApp([], []);
    expect(await new VaultFiles(f.app).removeFolderIfEmpty("gone")).toBe(false);
    expect(f.deleted).toEqual([]);
  });
});
