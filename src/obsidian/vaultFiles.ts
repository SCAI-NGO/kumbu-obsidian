// SPDX-License-Identifier: AGPL-3.0-or-later
// LocalFiles over Obsidian's Vault and FileManager.
import { MarkdownView, Platform, TFile, type App, type Editor } from "obsidian";
import type { LocalFiles, Version } from "../engine/ports";
import { versionOfBytes, versionOfSync } from "../engine/version";

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
    return view ? view.editor.getValue() : this.app.vault.read(file);
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
    const editors = this.editorsOf(file);
    if (editors.length > 0) {
      // Open in an editor: typing that isn't saved yet counts like an edit on disk. The check and the replacement
      // happen in one synchronous step through the editor, so no keystroke can come between them; whatever is
      // typed afterwards lands on top of the new text and is saved (and uploaded) as an edit of its own.
      if (editors.some((view) => versionOfSync(view.editor.getValue()) !== expected)) return false;
      // Views of one file share their text in Obsidian; the others follow the first.
      for (const view of editors) if (view.editor.getValue() !== content) replaceText(view.editor, content);
      await editors[0]!.save();
      return true;
    }
    let written = false;
    // process reads and writes in one step; the editors are asked again inside it, for a file opened meanwhile.
    await this.app.vault.process(file, (data) => {
      if (versionOfSync(data) !== expected) return data;
      if (this.editorsOf(file).some((view) => versionOfSync(view.editor.getValue()) !== expected)) return data;
      written = true;
      return content;
    });
    return written;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const file = this.app.vault.getFileByPath(path);
    return file ? this.app.vault.readBinary(file) : null;
  }

  /**
   * An attachment has no editor and Vault has no `process` for bytes, so the check reads the file right before the
   * write: only another program writing the same file in that moment could come between them.
   */
  async writeBinaryIf(path: string, expected: Version | null, bytes: ArrayBuffer): Promise<boolean> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      if (expected !== null) return false;
      await this.ensureFolder(path);
      try {
        await this.app.vault.createBinary(path, bytes);
        return true;
      } catch {
        // Created by someone else between the check and the create.
        return false;
      }
    }
    if (expected === null) return false;
    if ((await versionOfBytes(await this.app.vault.readBinary(file))) !== expected) return false;
    await this.app.vault.modifyBinary(file, bytes);
    return true;
  }

  async trashToLocal(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    // Chris decided: "Keep Kumbu²" always keeps the local text in Obsidian's .trash, whatever the user's setting.
    if (file) await this.app.vault.trash(file, false);
  }

  async trashIf(path: string, expected: Version): Promise<boolean> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return false;
    // The disk first; then the editors are checked and the trash started in one synchronous step, so a keystroke
    // (an event, never a microtask) can't come between the last check and the trash. Typing reaches the disk only
    // through the editor, which is what is checked last.
    if (versionOfSync(await this.app.vault.read(file)) !== expected) return false;
    if (this.editorsOf(file).some((view) => versionOfSync(view.editor.getValue()) !== expected)) return false;
    await this.app.fileManager.trashFile(file);
    return true;
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.app.vault.getFileByPath(from);
    if (!file) return;
    await this.ensureFolder(to);
    await this.app.vault.rename(file, to);
  }

  async removeFolderIfEmpty(path: string): Promise<boolean> {
    const folder = this.app.vault.getFolderByPath(path);
    if (!folder || folder.children.length > 0) return false;
    // Obsidian's index leaves out dot files (".DS_Store", a ".git" folder); the adapter lists what is on disk.
    const listed = await this.app.vault.adapter.list(path);
    if (listed.files.length > 0 || listed.folders.length > 0) return false;
    await this.app.vault.delete(folder);
    return true;
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

/** Replaces an editor's text, keeping the cursor and the scroll position as far as the new text allows. */
function replaceText(editor: Editor, content: string): void {
  const offset = editor.posToOffset(editor.getCursor());
  const { top, left } = editor.getScrollInfo();
  editor.setValue(content);
  editor.setCursor(editor.offsetToPos(Math.min(offset, content.length)));
  editor.scrollTo(left, top);
}
