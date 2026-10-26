// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import type { App } from "obsidian";
import { MarkdownView, TFile } from "./fakes/obsidian";
import { VaultFiles } from "../src/obsidian/vaultFiles";
import { versionOfSync } from "../src/engine/version";

/** A vault of files on disk and editors open on some of them, shaped like the parts of App the adapter uses. */
function fakeApp(disk: Record<string, string>) {
  const files = new Map(Object.entries(disk));
  const views: MarkdownView[] = [];
  const processed: string[] = [];
  const app = {
    vault: {
      getFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
      getAbstractFileByPath: (p: string) => (files.has(p) ? new TFile(p) : null),
      read: (f: TFile) => Promise.resolve(files.get(f.path)!),
      process: (f: TFile, fn: (data: string) => string) => {
        processed.push(f.path);
        const next = fn(files.get(f.path)!);
        files.set(f.path, next);
        for (const v of views) if (v.file?.path === f.path) v.buffer = next;
        return Promise.resolve(next);
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
    fileManager: {},
  };
  const open = (path: string, buffer: string) => {
    const view = new MarkdownView(new TFile(path), buffer, (text) => files.set(path, text));
    views.push(view);
    return view;
  };
  return { app: app as unknown as App, files, open, processed };
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

test("an open editor that matches is saved first, then written", async () => {
  const f = fakeApp({ "a.md": "base" });
  const view = f.open("a.md", "typed and matching");
  const files = new VaultFiles(f.app);
  expect(await files.writeIf("a.md", versionOfSync("typed and matching"), "agent text")).toBe(true);
  expect(view.saves).toBe(1);
  expect(f.files.get("a.md")).toBe("agent text");
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
