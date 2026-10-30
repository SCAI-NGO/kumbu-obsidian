// SPDX-License-Identifier: AGPL-3.0-or-later
// LocalFiles over node:fs in one folder, for the end-to-end run. The check and the write in writeIf are synchronous,
// as Obsidian's editor and Vault.process are, so nothing else on the event loop can land between them.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { eligibility, isMarker } from "../src/engine/paths";
import type { FileStat, LocalFiles, Version } from "../src/engine/ports";
import { versionOfBytes, versionOfSync } from "../src/engine/version";

export class NodeFiles implements LocalFiles {
  readonly caseInsensitive = false;

  constructor(readonly root: string) {}

  private abs(path: string): string {
    return join(this.root, ...path.split("/"));
  }

  /**
   * The user's side: writes a note as an editor would save it. Through a temp file and a rename, so the engine's
   * asynchronous read never sees a half-written file (Obsidian's adapter has no such gap either).
   */
  write(path: string, content: string): void {
    const file = this.abs(path);
    mkdirSync(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.kumbu-e2e-${process.pid}.tmp`);
    writeFileSync(temp, content, "utf8");
    renameSync(temp, file);
  }

  exists(path: string): boolean {
    return existsSync(this.abs(path));
  }

  textOf(path: string): string | null {
    try {
      return readFileSync(this.abs(path), "utf8");
    } catch {
      return null;
    }
  }

  /** The user's side: moves a note to `.trash`, as Obsidian's default delete does. */
  remove(path: string): void {
    this.toTrash(path);
  }

  list(): Promise<string[]> {
    return Promise.resolve(this.walk().filter((p) => !isMarker(p)));
  }

  listMarkers(): Promise<string[]> {
    return Promise.resolve(this.walk().filter((p) => isMarker(p) && eligibility(p, true) === "sync"));
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), "utf8");
    } catch {
      return null;
    }
  }

  size(path: string): Promise<number | null> {
    try {
      return Promise.resolve(statSync(this.abs(path)).size);
    } catch {
      return Promise.resolve(null);
    }
  }

  stat(path: string): Promise<FileStat | null> {
    try {
      const { size, mtimeMs } = statSync(this.abs(path));
      return Promise.resolve({ size, mtime: mtimeMs });
    } catch {
      return Promise.resolve(null);
    }
  }

  writeIf(path: string, expected: Version | null, content: string): Promise<boolean> {
    const now = this.textOf(path);
    const version = now === null ? null : versionOfSync(now);
    if (version !== expected) return Promise.resolve(false);
    this.write(path, content);
    return Promise.resolve(true);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    try {
      return Promise.resolve(new Uint8Array(readFileSync(this.abs(path))).buffer);
    } catch {
      return Promise.resolve(null);
    }
  }

  async writeBinaryIf(path: string, expected: Version | null, bytes: ArrayBuffer): Promise<boolean> {
    // A marker's content is never compared: it exists or it doesn't.
    if (isMarker(path) && (expected !== null || this.exists(path))) return expected !== null && this.exists(path);
    const now = await this.readBinary(path);
    if ((now === null ? null : await versionOfBytes(now)) !== expected) return false;
    const file = this.abs(path);
    mkdirSync(dirname(file), { recursive: true });
    const temp = join(dirname(file), `.kumbu-e2e-${process.pid}.tmp`);
    writeFileSync(temp, new Uint8Array(bytes));
    renameSync(temp, file);
    return true;
  }

  trashToLocal(path: string): Promise<void> {
    this.toTrash(path);
    return Promise.resolve();
  }

  trashIf(path: string, expected: Version): Promise<boolean> {
    const now = this.textOf(path);
    if (now === null || versionOfSync(now) !== expected) return Promise.resolve(false);
    this.toTrash(path);
    return Promise.resolve(true);
  }

  async trashBinaryIf(path: string, expected: Version): Promise<boolean> {
    if (isMarker(path)) {
      if (!this.exists(path)) return false;
      rmSync(this.abs(path));
      return true;
    }
    const now = await this.readBinary(path);
    if (now === null || (await versionOfBytes(now)) !== expected) return false;
    this.toTrash(path);
    return true;
  }

  rename(from: string, to: string): Promise<void> {
    if (this.exists(to)) return Promise.reject(new Error(`${to} exists already.`));
    mkdirSync(dirname(this.abs(to)), { recursive: true });
    renameSync(this.abs(from), this.abs(to));
    return Promise.resolve();
  }

  removeFolderIfEmpty(path: string): Promise<boolean> {
    if (!this.emptyFolder(path)) return Promise.resolve(false);
    rmdirSync(this.abs(path));
    return Promise.resolve(true);
  }

  isEmptyFolder(path: string): Promise<boolean> {
    return Promise.resolve(this.emptyFolder(path));
  }

  madeFolder(): boolean {
    return false;
  }

  private emptyFolder(path: string): boolean {
    const dir = this.abs(path);
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  }

  /** Every file under the root, dot files included. */
  private walk(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    walk(this.root);
    return out;
  }

  private toTrash(path: string): void {
    if (!this.exists(path)) return;
    let target = `.trash/${path}`;
    for (let i = 1; this.exists(target); i++) target = `.trash/${path.replace(/(\.[^./]+)?$/, ` ${i}$1`)}`;
    mkdirSync(dirname(this.abs(target)), { recursive: true });
    renameSync(this.abs(path), this.abs(target));
  }
}
