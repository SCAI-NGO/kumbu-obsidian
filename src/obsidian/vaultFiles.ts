// SPDX-License-Identifier: AGPL-3.0-or-later
// LocalFiles over Obsidian's Vault and FileManager.
import { MarkdownView, Platform, TFile, type App } from "obsidian";
import type { LocalFiles, Version } from "../engine/ports";
import { versionOfSync } from "../engine/version";

export class VaultFiles implements LocalFiles {
  /** Where "Plan.md" and "plan.md" are one file: macOS, Windows and the phones; Linux keeps them apart. */
  readonly caseInsensitive = Platform.isMacOS || Platform.isWin || Platform.isMobileApp;

  constructor(private readonly app: App) {}

  list(): Promise<string[]> {
    return Promise.resolve(this.app.vault.getFiles().map((f) => f.path));
  }

  /** The text the user sees: an open editor's, saved or not (Obsidian saves about 2 s after typing), else the file's. */
  async read(path: string): Promise<string | null> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return null;
    const view = this.editorsOf(file)[0];
    // Not cachedRead: a decision needs the text as it is now.
    return view ? view.getViewData() : this.app.vault.read(file);
  }

  size(path: string): Promise<number | null> {
    return Promise.resolve(this.app.vault.getFileByPath(path)?.stat.size ?? null);
  }

  async writeIf(path: string, expected: Version | null, content: string): Promise<boolean> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      if (expected !== null) return false;
      await this.ensureFolder(path);
      try {
        await this.app.vault.create(path, content);
        return true;
      } catch {
        // Created by someone else between the check and the create.
        return false;
      }
    }
    if (expected === null) return false;
    // Typing that is only in an editor must never be replaced: it counts like an edit on disk.
    const editors = this.editorsOf(file);
    if (editors.some((view) => versionOfSync(view.getViewData()) !== expected)) return false;
    // Flushed first, so the editor and the disk hold the same text when process checks and writes.
    for (const view of editors) await view.save();
    let written = false;
    // process reads and writes in one step, so the check and the write can't be split by a keystroke.
    await this.app.vault.process(file, (data) => {
      if (versionOfSync(data) !== expected) return data;
      written = true;
      return content;
    });
    return written;
  }

  async trashToLocal(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    // Chris decided: "Keep Kumbu²" always keeps the local text in Obsidian's .trash, whatever the user's setting.
    if (file) await this.app.vault.trash(file, false);
  }

  async trashByPreference(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.fileManager.trashFile(file);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.app.vault.getFileByPath(from);
    if (!file) return;
    await this.ensureFolder(to);
    await this.app.vault.rename(file, to);
  }

  private editorsOf(file: TFile): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path);
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    for (let i = 1; i <= segments.length; i++) {
      const folder = segments.slice(0, i).join("/");
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (existing instanceof TFile) throw new Error(`${folder} is a file, not a folder.`);
      if (!existing) await this.app.vault.createFolder(folder);
    }
  }
}
