// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory LocalFiles. `caseInsensitive` makes lookups ignore case, as on macOS, Windows and Android.
import type { LocalFiles, Version } from "../../src/engine/ports";
import { versionOf, versionOfSync } from "../../src/engine/version";

export class FakeFiles implements LocalFiles {
  readonly files = new Map<string, string>();
  /** Open editors with text not saved yet (as Obsidian holds it for about 2 s), by stored path. */
  readonly editors = new Map<string, string>();
  readonly trash: string[] = [];
  readonly systemTrash: string[] = [];
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
    if (p !== undefined) this.files.delete(p);
  }

  userRename(from: string, to: string): void {
    const p = this.existing(from);
    if (p === undefined) return;
    const text = this.files.get(p)!;
    this.files.delete(p);
    this.files.set(to, text);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  read(path: string): Promise<string | null> {
    const p = this.existing(path);
    return Promise.resolve(p === undefined ? null : (this.editors.get(p) ?? this.files.get(p)!));
  }

  size(path: string): Promise<number | null> {
    const p = this.existing(path);
    return Promise.resolve(p === undefined ? null : new TextEncoder().encode(this.files.get(p) as string).byteLength);
  }

  async writeIf(path: string, expected: Version | null, content: string): Promise<boolean> {
    const p = this.existing(path);
    const now = p === undefined ? null : await versionOf(this.editors.get(p) ?? this.files.get(p)!);
    if (now !== expected) return false;
    if (p === undefined && this.clashes(path)) return false;
    this.beforeWrite?.(path);
    this.writes++;
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
    if (p === undefined || versionOfSync(this.editors.get(p) ?? this.files.get(p)!) !== expected) return Promise.resolve(false);
    this.editors.delete(p);
    this.remove(path, this.systemTrash);
    return Promise.resolve(true);
  }

  rename(from: string, to: string): Promise<void> {
    this.userRename(from, to);
    return Promise.resolve();
  }

  private remove(path: string, into: string[]): void {
    const p = this.existing(path);
    if (p === undefined) return;
    this.files.delete(p);
    into.push(p);
  }

  /** Exact, like Obsidian's getFileByPath: no NFC or case folding, so an engine call with the wrong spelling fails here too. */
  private existing(path: string): string | undefined {
    return this.files.has(path) ? path : undefined;
  }

  /** On a case-insensitive file system another spelling of the same name is the same file: a create fails. */
  private clashes(path: string): boolean {
    const nfc = path.normalize("NFC").toLowerCase();
    return [...this.files.keys()].some((k) => k !== path && (k.normalize("NFC") === path.normalize("NFC")
      || (this.caseInsensitive && k.normalize("NFC").toLowerCase() === nfc)));
  }
}
