// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory RemoteApi that behaves like the server's endpoints, with scripted holds and failures.
import {
  OfflineError, RejectedError,
  type DeleteResult, type FileDeleteResult, type FileKind, type FilePutResult, type MoveResult, type PutResult,
  type RemoteApi, type RemoteEntry, type RemoteFile, type RemoteNote, type Version, type VersionsAnswer,
} from "../../src/engine/ports";
import { normaliseText, versionOf, versionOfBytes } from "../../src/engine/version";

type Method = keyof RemoteApi;
interface StoredNote { content: string; lastWriter: string; at: string; version: Version; }
interface StoredFile { bytes: Uint8Array; lastWriter: string; at: string; version: Version; }

const OVERLAP_MS = 5 * 60_000;

export class FakeServer implements RemoteApi {
  readonly notes = new Map<string, StoredNote>();
  /** Attachments, by path. */
  readonly files = new Map<string, StoredFile>();
  /** False: a server from before attachments, which ignores attachments=1 and answers 404 on /api/files. */
  attachmentsSupported = true;
  /** Every path touched, with the server time of the touch, for since answers. */
  readonly touches: { path: string; at: number }[] = [];
  readonly calls: { method: Method; args: unknown[] }[] = [];
  damaged = 0;
  /** Paths whose stored note doesn't open: in neither list of an answer, only counted in `damaged`. */
  readonly damagedPaths = new Set<string>();
  /** The writer label the device's own writes get. */
  deviceWriter = "Work – Obsidian Laptop";
  private readonly holds = new Map<Method, Promise<void>[]>();
  private readonly failures = new Map<Method, Error[]>();
  private readonly dropped = new Set<Method>();

  constructor(private readonly now: () => number = Date.now) {}

  async seed(path: string, content: string, writer = "agent"): Promise<void> {
    await this.store(path, content, writer);
  }

  async seedFile(path: string, bytes: Uint8Array, writer = "agent"): Promise<void> {
    await this.storeFile(path, bytes, writer);
  }

  /**
   * An agent's edit (content) or delete (null), stamped with the clock, or with `at` for a write stamped before it
   * was committed (the case the server's 5-minute overlap is for).
   */
  agentWrite(path: string, content: string | null, at?: number): Promise<string | undefined> {
    if (content === null) {
      const previous = this.notes.get(path)?.content;
      this.notes.delete(path);
      this.touch(path, at);
      return Promise.resolve(previous);
    }
    return this.store(path, content, "agent", at);
  }

  /** The stored note stops opening (as the server's damaged notes): gone from every list, counted in damaged. */
  damage(path: string): void {
    this.notes.delete(path);
    this.damagedPaths.add(path);
    this.damaged++;
    this.touch(path);
  }

  /** Pauses the next call of that method until the returned function is called. */
  hold(method: Method): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const list = this.holds.get(method) ?? [];
    list.push(gate);
    this.holds.set(method, list);
    return release;
  }

  failNext(method: Method, error: Error): void {
    const list = this.failures.get(method) ?? [];
    list.push(error);
    this.failures.set(method, list);
  }

  /** The next put is applied, but its answer is lost on the way back. */
  dropResponseOfNext(method: "put"): void {
    this.dropped.add(method);
  }

  count(method: Method): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async versions(since: string | null, state: string | null): Promise<VersionsAnswer> {
    await this.enter("versions", [since, state]);
    const cursorAt = this.now();
    const cursor = new Date(cursorAt).toISOString();
    const sinceAt = since === null ? NaN : Date.parse(since);
    const attachments = this.attachmentsSupported;
    // As the server: with attachments, every entry has its kind; without, attachments are nowhere in the answer.
    const entry = (path: string, version: Version, kind: FileKind): RemoteEntry => (attachments ? { path, version, kind } : { path, version });
    const files = attachments ? this.files : new Map<string, StoredFile>();
    if (Number.isNaN(sinceAt)) {
      const entries: RemoteEntry[] = [
        ...[...this.notes].map(([path, n]) => entry(path, n.version, "note")),
        ...[...files].map(([path, f]) => entry(path, f.version, kindOf(path))),
      ];
      return { full: true, entries, cursor, state: "s" + String(cursorAt), damaged: this.damaged, unchanged: false, attachments };
    }
    const touched = new Set(this.touches.filter((t) => t.at > sinceAt - OVERLAP_MS).map((t) => t.path)
      .filter((path) => attachments || kindOf(path) === "note"));
    const entries: RemoteEntry[] = [...touched]
      .filter((path) => this.notes.has(path) || files.has(path) || !this.damagedPaths.has(path))
      .map((path) => {
        const n = this.notes.get(path) ?? files.get(path);
        return n ? entry(path, n.version, kindOf(path)) : { path, version: null };
      });
    return { full: false, entries, cursor, state: null, damaged: this.damaged, unchanged: false, attachments };
  }

  async read(path: string): Promise<RemoteNote | null> {
    await this.enter("read", [path]);
    const n = this.notes.get(path);
    return n ? { path, content: n.content, version: n.version, lastWriter: n.lastWriter, lastWriteAt: n.at } : null;
  }

  async put(path: string, content: string, base: Version | null): Promise<PutResult> {
    await this.enter("put", [path, content, base]);
    const existing = this.notes.get(path);
    if (existing && existing.version !== base) return { ok: false, conflict: { content: existing.content, version: existing.version } };
    // A base for a note that is gone is the server's 404, which the client turns into a create.
    await this.store(path, content, this.deviceWriter);
    return this.leave("put", { ok: true, version: this.notes.get(path)!.version });
  }

  async remove(path: string, base: Version): Promise<DeleteResult> {
    await this.enter("remove", [path, base]);
    const existing = this.notes.get(path);
    if (!existing) return { ok: false, conflict: null };
    if (existing.version !== base) return { ok: false, conflict: { content: existing.content, version: existing.version } };
    this.notes.delete(path);
    this.touch(path);
    return { ok: true };
  }

  async move(from: string, to: string): Promise<MoveResult> {
    await this.enter("move", [from, to]);
    const file = this.attachmentsSupported ? this.files.get(from) : undefined;
    if (file) {
      // As the server's mv: an attachment keeps its format, so its extension.
      if (this.files.has(to) || this.notes.has(to) || kindOf(to) !== kindOf(from)) return { ok: false };
      this.files.delete(from);
      this.files.set(to, { ...file, lastWriter: this.deviceWriter + " (mv)" });
      this.touch(from);
      this.touch(to);
      return { ok: true, version: file.version };
    }
    const existing = this.notes.get(from);
    if (!existing || this.notes.has(to) || this.files.has(to)) return { ok: false };
    this.notes.delete(from);
    this.notes.set(to, { ...existing, lastWriter: this.deviceWriter + " (mv)" });
    this.touch(from);
    this.touch(to);
    return { ok: true, version: existing.version };
  }

  async readFile(path: string): Promise<RemoteFile | null> {
    await this.enter("readFile", [path]);
    const f = this.attachmentsSupported ? this.files.get(path) : undefined;
    return f ? { bytes: f.bytes.slice().buffer, version: f.version } : null;
  }

  async putFile(path: string, bytes: ArrayBuffer, base: Version | null): Promise<FilePutResult> {
    await this.enter("putFile", [path, bytes, base]);
    if (!this.attachmentsSupported) throw new RejectedError("Not found.", 404);
    const existing = this.files.get(path);
    if (existing && existing.version !== base) return { ok: false, conflict: { version: existing.version } };
    await this.storeFile(path, new Uint8Array(bytes), this.deviceWriter);
    return { ok: true, version: this.files.get(path)!.version };
  }

  async removeFile(path: string, base: Version): Promise<FileDeleteResult> {
    await this.enter("removeFile", [path, base]);
    const existing = this.attachmentsSupported ? this.files.get(path) : undefined;
    if (!existing) return { ok: false, conflict: null };
    if (existing.version !== base) return { ok: false, conflict: { version: existing.version } };
    this.files.delete(path);
    this.touch(path);
    return { ok: true };
  }

  private async storeFile(path: string, bytes: Uint8Array, writer: string, at = this.now()): Promise<void> {
    const copy = bytes.slice();
    this.files.set(path, { bytes: copy, lastWriter: writer, at: new Date(at).toISOString(), version: await versionOfBytes(copy) });
    this.touch(path, at);
  }

  /** Returns the text it replaced, as it was at the moment of the write (a blind write, like an agent's). */
  private async store(path: string, content: string, writer: string, at = this.now()): Promise<string | undefined> {
    const text = normaliseText(content);
    const version = await versionOf(text);
    const previous = this.notes.get(path)?.content;
    this.notes.set(path, { content: text, lastWriter: writer, at: new Date(at).toISOString(), version });
    this.touch(path, at);
    return previous;
  }

  private touch(path: string, at = this.now()): void {
    this.touches.push({ path, at });
  }

  private async enter(method: Method, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const gate = this.holds.get(method)?.shift();
    if (gate) await gate;
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
  }

  private leave<T>(method: Method, result: T): T {
    if (this.dropped.delete(method)) throw new OfflineError("the answer was lost");
    return result;
  }
}

function kindOf(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  return lower.endsWith(".md") ? "note" : "image";
}
