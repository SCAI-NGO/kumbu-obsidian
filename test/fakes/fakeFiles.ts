// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory LocalFiles. `caseInsensitive` makes lookups ignore case, as on macOS, Windows and Android.
import type { LocalFiles, Version } from "../../src/engine/ports";
import { versionOf, versionOfBytes, versionOfSync } from "../../src/engine/version";

export class FakeFiles implements LocalFiles {
  readonly files = new Map<string, string>();
  /** Files written as bytes (attachments), apart from the text files; a path is in one map at most. */
  readonly binaries = new Map<string, Uint8Array>();
  /** Open editors with text not saved yet (as Obsidian holds it for about 2 s), by stored path. */
  readonly editors = new Map<string, string>();
  readonly trash: string[] = [];
  readonly systemTrash: string[] = [];
  /** Folders with no file in them, which a map of files can't show: made by the user, or left behind by a file. */
  readonly folders = new Set<string>();
  readonly removedFolders: string[] = [];
  caseInsensitive = false;
  /** Runs inside writeIf after the check and before the write, to model a race the real adapter can't have. */
  beforeWrite: ((path: string) => void) | null = null;
  /** Runs when the engine trashes a file, before any check there: a keystroke between the engine's read and the trash. */
  beforeTrash: ((path: string) => void) | null = null;
  writes = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [p, t] of Object.entries(initial)) this.files.set(p, t);
  }

  userEdit(path: string, content: string): void {
    this.files.set(this.existing(path) ?? path, content);
  }

  /** Typing that is only in an open editor: no file change, no event yet. */
  userTypes(path: string, content: string): void {
    this.editors.set(this.existing(path) ?? path, content);
  }

  userDelete(path: string): void {
    const p = this.existing(path);
    if (p !== undefined) this.forget(p);
  }

  userRename(from: string, to: string): void {
    const p = this.existing(from);
    if (p === undefined) return;
    const text = this.files.get(p);
    const bytes = this.binaries.get(p);
    this.forget(p);
    if (bytes !== undefined) this.binaries.set(to, bytes);
    else this.files.set(to, text!);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys(), ...this.binaries.keys()]);
  }

  read(path: string): Promise<string | null> {
    const p = this.existing(path);
    return Promise.resolve(p === undefined ? null : (this.editors.get(p) ?? this.textOf(p)));
  }

  size(path: string): Promise<number | null> {
    const p = this.existing(path);
    return Promise.resolve(p === undefined ? null : this.bytesOf(p).byteLength);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    const p = this.existing(path);
    return Promise.resolve(p === undefined ? null : this.bytesOf(p).slice().buffer);
  }

  async writeBinaryIf(path: string, expected: Version | null, bytes: ArrayBuffer): Promise<boolean> {
    const p = this.existing(path);
    const now = p === undefined ? null : await versionOfBytes(this.bytesOf(p));
    if (now !== expected) return false;
    if (p === undefined && this.clashes(path)) return false;
    this.beforeWrite?.(path);
    this.writes++;
    this.files.delete(p ?? path);
    this.binaries.set(p ?? path, new Uint8Array(bytes.slice(0)));
    return true;
  }

  async writeIf(path: string, expected: Version | null, content: string): Promise<boolean> {
    const p = this.existing(path);
    const now = p === undefined ? null : await versionOf(this.editors.get(p) ?? this.textOf(p));
    if (now !== expected) return false;
    if (p === undefined && this.clashes(path)) return false;
    this.beforeWrite?.(path);
    this.writes++;
    this.binaries.delete(p ?? path);
    this.files.set(p ?? path, content);
    if (p !== undefined && this.editors.has(p)) this.editors.set(p, content);
    return true;
  }

  trashToLocal(path: string): Promise<void> {
    this.remove(path, this.trash);
    return Promise.resolve();
  }

  trashIf(path: string, expected: Version): Promise<boolean> {
    this.beforeTrash?.(path);
    const p = this.existing(path);
    if (p === undefined || versionOfSync(this.editors.get(p) ?? this.textOf(p)) !== expected) return Promise.resolve(false);
    this.editors.delete(p);
    this.remove(path, this.systemTrash);
    return Promise.resolve(true);
  }

  rename(from: string, to: string): Promise<void> {
    this.userRename(from, to);
    return Promise.resolve();
  }

  removeFolderIfEmpty(path: string): Promise<boolean> {
    const inside = (p: string) => p.startsWith(`${path}/`);
    const empty = ![...this.files.keys(), ...this.binaries.keys()].some(inside) && ![...this.folders].some(inside);
    if (!this.folders.has(path) || !empty) return Promise.resolve(false);
    this.folders.delete(path);
    this.removedFolders.push(path);
    return Promise.resolve(true);
  }

  private remove(path: string, into: string[]): void {
    const p = this.existing(path);
    if (p === undefined) return;
    this.forget(p);
    into.push(p);
  }

  /** Deletes a file and keeps its folders, as a file system does. */
  private forget(path: string): void {
    this.files.delete(path);
    this.binaries.delete(path);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) this.folders.add(segments.slice(0, i).join("/"));
  }

  /** Exact, like Obsidian's getFileByPath: no NFC or case folding, so an engine call with the wrong spelling fails here too. */
  private existing(path: string): string | undefined {
    return this.files.has(path) || this.binaries.has(path) ? path : undefined;
  }

  /** A text file's text; a binary file's bytes read as UTF-8, as Obsidian's read would. */
  private textOf(path: string): string {
    const bytes = this.binaries.get(path);
    return bytes === undefined ? this.files.get(path)! : new TextDecoder().decode(bytes);
  }

  /** A binary file's bytes; a text file's UTF-8, as on disk. */
  private bytesOf(path: string): Uint8Array {
    return this.binaries.get(path) ?? new TextEncoder().encode(this.files.get(path));
  }

  /** On a case-insensitive file system another spelling of the same name is the same file: a create fails. */
  private clashes(path: string): boolean {
    const nfc = path.normalize("NFC").toLowerCase();
    return [...this.files.keys(), ...this.binaries.keys()].some((k) => k !== path && (k.normalize("NFC") === path.normalize("NFC")
      || (this.caseInsensitive && k.normalize("NFC").toLowerCase() === nfc)));
  }
}
