// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory RemoteApi that behaves like the server's endpoints, with scripted holds and failures.
import {
  OfflineError,
  type DeleteResult, type MoveResult, type PutResult, type RemoteApi, type RemoteEntry, type RemoteNote,
  type Version, type VersionsAnswer,
} from "../../src/engine/ports";
import { normaliseText, versionOf } from "../../src/engine/version";

type Method = keyof RemoteApi;
interface StoredNote { content: string; lastWriter: string; at: string; version: Version; }

const OVERLAP_MS = 5 * 60_000;

export class FakeServer implements RemoteApi {
  readonly notes = new Map<string, StoredNote>();
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
    if (Number.isNaN(sinceAt)) {
      const entries: RemoteEntry[] = [...this.notes].map(([path, n]) => ({ path, version: n.version }));
      return { full: true, entries, cursor, state: "s" + String(cursorAt), damaged: this.damaged, unchanged: false };
    }
    const touched = new Set(this.touches.filter((t) => t.at > sinceAt - OVERLAP_MS).map((t) => t.path));
    const entries: RemoteEntry[] = [...touched]
      .filter((path) => this.notes.has(path) || !this.damagedPaths.has(path))
      .map((path) => ({ path, version: this.notes.get(path)?.version ?? null }));
    return { full: false, entries, cursor, state: null, damaged: this.damaged, unchanged: false };
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
    const existing = this.notes.get(from);
    if (!existing || this.notes.has(to)) return { ok: false };
    this.notes.delete(from);
    this.notes.set(to, { ...existing, lastWriter: this.deviceWriter + " (mv)" });
    this.touch(from);
    this.touch(to);
    return { ok: true, version: existing.version };
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
