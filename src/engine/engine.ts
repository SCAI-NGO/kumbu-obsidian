// SPDX-License-Identifier: AGPL-3.0-or-later
// The sync engine (spec §6): one serial queue per vault, every decision from local, remote and base versions.
import { conflictCopyText } from "./conflict";
import { decide, type Action } from "./decide";
import { makePlan, type Choice, type FirstSyncSummary, type MergePlan } from "./firstSync";
import { conflictCopyPath, eligibility } from "./paths";
import {
  AuthError, OfflineError, RejectedError,
  type Clock, type MoveResult, type VersionsAnswer, type ConnectionMode, type LocalFiles, type NotSynced, type RemoteApi, type StateStore,
  type SyncState, type SyncStatus, type Version,
} from "./ports";
import { SerialQueue } from "./queue";
import { byteSize, MAX_BYTES, versionOf } from "./version";

export interface EngineOptions {
  vault: string; device: string; local: LocalFiles; remote: RemoteApi; state: StateStore; clock: Clock;
  onStatus(s: SyncStatus): void;
  onConflict(original: string, copy: string): void;
  onAuthLost(): void;
  /** A first sync finished, also one that finished on a retry after its first attempt failed. */
  onFirstSyncDone?(summary: FirstSyncSummary): void;
  /** The user closed the first sync's question without an answer: nothing was saved. */
  onFirstSyncCancelled?(): void;
}

const DEBOUNCE_MS = 2000;
const FULL_AFTER_MS = 25 * 24 * 3600_000;
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 5 * 60_000;
/** A path decided again more often than this in one go is left for the next trigger. */
const MAX_ROUNDS = 4;
/** Marks a path listed for an unexpected error: never equal to a version, so it is tried again every time. */
const UNEXPECTED = "!";
const COPY_NAME = /\(conflict .+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)( \d+)?\.md$/;

/** What an operation found out: decide again with this remote version. */
interface Again { remote: Version | null; }

/** Paths are compared as NFC, the form the server and other devices use. */
const keyOf = (path: string) => path.normalize("NFC");

export class SyncEngine {
  private readonly o: EngineOptions;
  private readonly queue = new SerialQueue();
  private state: SyncState = { bases: {}, cursor: null, lastFullAt: null, lastSyncAt: null };
  private stopped = true;
  private readonly debounces = new Map<string, unknown>();
  /** Paths with local work not yet done, retried by every check until it succeeds. */
  private readonly dirty = new Set<string>();
  /** Key → the path as the file system spells it (NFD on some, or another case). */
  private readonly localPathOf = new Map<string, string>();
  private readonly attachments = new Set<string>();
  private readonly tooLarge = new Set<string>();
  private readonly rejected = new Map<string, { version: Version; detail: string }>();
  private caseClashes = new Map<string, string>();
  private damaged = 0;
  private readonly conflicts = new Set<string>();
  private connection: ConnectionMode = "polling";
  private offline = false;
  private retryHandle: unknown = null;
  private retryDelay = 0;
  private copiesMade = 0;
  /** Set while a first sync hasn't finished: checks retry it, and local events wait for it. */
  private firstSyncChoose: ((plan: MergePlan) => Promise<Choice | null>) | null = null;
  private loading: Promise<void> = Promise.resolve();

  constructor(o: EngineOptions) {
    this.o = o;
  }

  /** Loads the state and runs a full check. */
  async start(): Promise<void> {
    this.state = await this.o.state.load();
    this.stopped = false;
    await this.check(true);
  }

  /** Cancels debounces and waits for the queue. Edits not yet uploaded are found by the next start's full check. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.debounces.values()) this.o.clock.clearTimeout(h);
    this.debounces.clear();
    this.cancelRetry();
    await this.queue.idle();
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  /** The hint connection's mode; the engine shows "offline" over it while the server can't be reached. */
  setConnectionMode(mode: ConnectionMode): void {
    this.connection = mode;
    this.emit();
  }

  status(): SyncStatus {
    const notSynced: NotSynced[] = [];
    for (const path of [...this.attachments].sort()) notSynced.push({ path, reason: "attachment" });
    for (const path of [...this.tooLarge].sort()) notSynced.push({ path, reason: "too-large", detail: "Larger than 1 MiB." });
    for (const [path, r] of [...this.rejected].sort()) notSynced.push({ path, reason: "rejected", detail: r.detail });
    for (const [path, winner] of [...this.caseClashes].sort()) {
      notSynced.push({ path, reason: "case-clash", detail: `Differs only in case from ${winner}.` });
    }
    if (this.damaged > 0) {
      notSynced.push({
        path: "", reason: "damaged-vault",
        detail: `${this.damaged} ${this.damaged === 1 ? "note" : "notes"} in Kumbu² can't be opened, so no local file is trashed because a note is missing.`,
      });
    }
    return {
      mode: this.offline ? "offline" : this.connection,
      notSynced,
      conflicts: [...this.conflicts].sort(),
      busy: this.queue.busy,
      lastSyncAt: this.state.lastSyncAt,
    };
  }

  localChanged(path: string): void {
    if (this.stopped) return;
    const kind = eligibility(path);
    if (kind === "ignored") return;
    if (kind === "attachment") {
      this.attachments.add(path);
      this.emit();
      return;
    }
    const key = keyOf(path);
    this.localPathOf.set(key, path);
    this.dirty.add(key);
    this.cancelDebounce(key);
    this.debounces.set(key, this.o.clock.setTimeout(() => {
      this.debounces.delete(key);
      void this.enqueuePath(key);
    }, DEBOUNCE_MS));
  }

  localDeleted(path: string): void {
    if (this.stopped) return;
    const kind = eligibility(path);
    if (kind === "attachment") {
      this.attachments.delete(path);
      this.emit();
    }
    if (kind !== "sync") return;
    const key = keyOf(path);
    this.cancelDebounce(key);
    this.dirty.add(key);
    void this.enqueuePath(key);
  }

  localRenamed(from: string, to: string): void {
    if (this.stopped) return;
    const fromSync = eligibility(from) === "sync";
    const toSync = eligibility(to) === "sync";
    if (!fromSync || !toSync) {
      // In or out of what syncs (a dot folder, an extension change): a delete and a create.
      this.localDeleted(from);
      this.localChanged(to);
      return;
    }
    const fk = keyOf(from);
    const tk = keyOf(to);
    this.cancelDebounce(fk);
    this.cancelDebounce(tk);
    this.localPathOf.set(tk, to);
    this.dirty.add(fk);
    this.dirty.add(tk);
    void this.run(async () => {
      if (this.firstSyncChoose !== null) return false;
      const base = this.state.bases[fk];
      const text = await this.o.local.read(to);
      const now = text === null ? null : await versionOf(text);
      if (base !== undefined && now === base && this.state.bases[tk] === undefined) {
        let moved: MoveResult = { ok: false };
        try {
          moved = await this.o.remote.move(fk, tk);
        } catch (e) {
          // A name the server refuses: the delete plus create below meets the same rule and lists it.
          if (!(e instanceof RejectedError)) throw e;
        }
        if (moved.ok) {
          // A move takes whatever the note is now, so an agent's edit may have come along: the base stays what
          // this device agreed on, and a different moved version is decided at once (downloaded, or a conflict).
          delete this.state.bases[fk];
          this.state.bases[tk] = base;
          this.dirty.delete(fk);
          await this.save();
          await this.syncPath(tk, moved.version, false);
          return;
        }
      }
      await this.syncPath(fk, this.state.bases[fk] ?? null, false);
      await this.syncPath(tk, this.state.bases[tk] ?? null, false);
    });
  }

  /** `full`: start, visible again, hourly; otherwise (hint, "Sync now", poll) only what changed since the cursor. */
  check(full: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.firstSyncChoose !== null) return this.firstSyncJob().then(() => undefined);
    const last = this.state.lastSyncAt === null ? NaN : Date.parse(this.state.lastSyncAt);
    const asFull = full || this.state.cursor === null || !(this.o.clock.now() - last < FULL_AFTER_MS);
    return this.run(() => this.runCheck(asFull), asFull ? "check:full" : "check");
  }

  /** Every operation goes through the queue; failures end it without losing work. */
  /** `job` returns false when it skipped its work: that says nothing about the server being reachable. */
  private run(job: () => Promise<void | false>, key?: string): Promise<void> {
    const p = this.queue.push(async () => {
      if (this.stopped) return;
      this.emit();
      try {
        if ((await job()) !== false) this.online();
      } catch (e) {
        this.failed(e);
      } finally {
        this.emit();
      }
    }, key);
    return p;
  }

  private enqueuePath(key: string): Promise<void> {
    return this.run(async () => {
      this.dirty.add(key);
      // Decided by the first sync, with its choice, once it runs again.
      if (this.firstSyncChoose !== null) return false;
      // As far as this device knows, the server is at the base; a 409 says otherwise.
      await this.syncPath(key, this.state.bases[key] ?? null, false);
    }, `path:${key}`);
  }

  private async runCheck(full: boolean): Promise<void> {
    const answer = await this.o.remote.versions(full ? null : this.state.cursor, null);
    const { remote, keys } = await this.resolve(answer);
    const damagedPossible = answer.full && answer.damaged > 0;
    let pathFailed = false;
    for (const key of keys) {
      if (this.stopped) return;
      const base = this.state.bases[key] ?? null;
      const known = answer.full ? (remote.get(key) ?? null) : remote.has(key) ? remote.get(key)! : base;
      // Still being typed in: its debounce uploads it (spec §6, rule 6), unless the server has news for it.
      if (this.debounces.has(key) && known === base) continue;
      try {
        await this.syncPath(key, known, damagedPossible);
      } catch (e) {
        if (e instanceof OfflineError || e instanceof AuthError) throw e;
        // One path's local trouble doesn't hold up the others; it is listed and tried again by every check.
        this.rejected.set(key, { version: UNEXPECTED, detail: `Couldn't sync: ${e instanceof Error ? e.message : "unknown error"}` });
        pathFailed = true;
      }
    }
    // The old cursor stays while a path failed, so the next check asks for it again.
    if (!pathFailed) await this.finishCheck(answer);
  }

  private async finishCheck(answer: VersionsAnswer): Promise<void> {
    // Every answer counts the vault's damaged notes; a damaged path is in neither list, so it is never "deleted".
    this.damaged = answer.damaged;
    if (answer.full) this.state.lastFullAt = new Date(this.o.clock.now()).toISOString();
    // Only after every path is done: a check that fails halfway asks again from the old cursor.
    this.state.cursor = answer.cursor;
    this.state.lastSyncAt = new Date(this.o.clock.now()).toISOString();
    await this.save();
  }

  /** The answer's versions by key, without case clashes, and the keys a check decides, in order. */
  private async resolve(answer: VersionsAnswer): Promise<{ remote: Map<string, Version | null>; keys: string[] }> {
    const isFull = answer.full;
    const caseInsensitive = this.o.local.caseInsensitive;
    const fold = (k: string) => (caseInsensitive ? k.toLowerCase() : k);

    const localKeys = await this.scanLocal(isFull);

    // Which spelling owns a case-folded path: synced paths first, then the answer in path order.
    if (isFull) this.caseClashes = new Map();
    const owner = new Map<string, string>();
    for (const k of Object.keys(this.state.bases)) owner.set(fold(k), k);
    const remote = new Map<string, Version | null>();
    const entries = answer.entries.map((e) => ({ key: keyOf(e.path), version: e.version })).sort((a, b) => cmp(a.key, b.key));
    for (const { key, version } of entries) {
      const winner = owner.get(fold(key));
      if (caseInsensitive && winner !== undefined && winner !== key) {
        if (version === null) this.caseClashes.delete(key);
        else this.caseClashes.set(key, winner);
        continue;
      }
      if (version !== null) owner.set(fold(key), key);
      this.caseClashes.delete(key);
      remote.set(key, version);
    }

    const keys = new Set<string>([...remote.keys(), ...this.dirty]);
    if (isFull) {
      for (const k of Object.keys(this.state.bases)) keys.add(k);
      for (const [k, path] of localKeys) {
        const winner = owner.get(fold(k)) ?? k;
        if (winner !== k) this.localPathOf.set(winner, path);
        if (!this.caseClashes.has(k)) keys.add(winner);
      }
    }
    return { remote, keys: [...keys].sort(cmp) };
  }

  /**
   * Runs the first sync: merges both sides, asks `choose` once if paths differ. Null when the choice was cancelled
   * (nothing saved). A failure stops the engine and is thrown; running it again finishes the job.
   */
  async firstSync(choose: (plan: MergePlan) => Promise<Choice | null>): Promise<FirstSyncSummary | null> {
    // Set before any await, so a check that comes in now is routed to the first sync by construction.
    this.stopped = false;
    this.firstSyncChoose = choose;
    this.loading = this.o.state.load().then((state) => { this.state = state; });
    const outcome = await this.firstSyncJob();
    if (outcome.error !== null) throw outcome.error;
    return outcome.summary;
  }

  /**
   * One attempt at the first sync. An offline failure schedules another through check(), with the same backoff as
   * every check, and the choice already made is kept in the state, so a retry never asks again.
   */
  private async firstSyncJob(): Promise<{ summary: FirstSyncSummary | null; error: Error | null }> {
    const outcome: { summary: FirstSyncSummary | null; error: Error | null } = { summary: null, error: null };
    await this.queue.push(async () => {
      const choose = this.firstSyncChoose;
      if (this.stopped || choose === null) return;
      this.emit();
      try {
        await this.loading;
        outcome.summary = await this.runFirstSync(choose);
        if (this.stopped) {
          // Not a cancelled question: the plugin keeps the connection, and the next start finishes the job.
          outcome.summary = null;
          outcome.error = new Error("The first sync was stopped.");
          return;
        }
        this.firstSyncChoose = null;
        this.online();
        if (outcome.summary === null) {
          this.stopped = true;
          // Also from a retry, whose caller isn't waiting any more: the plugin disconnects.
          this.o.onFirstSyncCancelled?.();
        } else this.o.onFirstSyncDone?.(outcome.summary);
      } catch (e) {
        outcome.error = e instanceof Error ? e : new Error("The first sync failed.");
        this.failed(e);
      } finally {
        this.emit();
      }
    }, "first-sync");
    return outcome;
  }

  private async runFirstSync(choose: (plan: MergePlan) => Promise<Choice | null>): Promise<FirstSyncSummary | null> {
    const answer = await this.o.remote.versions(null, null);
    const { remote, keys } = await this.resolve(answer);
    const sides = new Map<string, { local: Version | null; remote: Version | null }>();
    for (const key of keys) {
      if (this.state.bases[key] !== undefined) continue;
      const text = await this.o.local.read(this.localPathOf.get(key) ?? key);
      sides.set(key, { local: text === null ? null : await versionOf(text), remote: remote.get(key) ?? null });
    }
    const plan = makePlan(sides, this.status().notSynced);
    let choice: Choice = this.state.pendingChoice ?? "both";
    if (plan.differing.length > 0 && !this.state.pendingChoice) {
      const chosen = await choose(plan);
      if (chosen === null) return null;
      choice = chosen;
      this.state.pendingChoice = chosen;
      await this.save();
    }

    const counts = { uploaded: 0, downloaded: 0, unchanged: 0 };
    const copiesBefore = this.copiesMade;
    const upload = new Set(plan.toUpload);
    const download = new Set(plan.toDownload);
    const same = new Set(plan.same);
    const differing = new Set(plan.differing);
    const damagedPossible = answer.damaged > 0;
    for (const key of keys) {
      // Stopped (Disconnect, unload): no further writes on either side, and no cursor that says it finished.
      if (this.stopped) return null;
      const remoteVersion = remote.get(key) ?? null;
      if (upload.has(key)) {
        await this.syncPath(key, null, false);
        if (this.state.bases[key] !== undefined) counts.uploaded++;
      } else if (download.has(key)) {
        await this.syncPath(key, remoteVersion, false);
        if (this.state.bases[key] !== undefined) counts.downloaded++;
      } else if (same.has(key)) {
        await this.setBase(key, remoteVersion!);
        counts.unchanged++;
      } else if (differing.has(key) && choice === "local") {
        if (await this.keepLocal(key, remoteVersion!)) counts.uploaded++;
      } else if (differing.has(key) && choice === "kumbu") {
        if (await this.keepKumbu(key)) counts.downloaded++;
      } else {
        // Already synced in an earlier, interrupted run, or "Keep both": the normal decision (a conflict copy).
        await this.syncPath(key, remoteVersion, damagedPossible);
      }
    }
    if (this.stopped) return null;
    delete this.state.pendingChoice;
    await this.finishCheck(answer);
    return { ...counts, conflictCopies: this.copiesMade - copiesBefore, notSynced: this.status().notSynced };
  }

  /** The local text replaces Kumbu²'s, which stays in its history. False if it ended another way. */
  private async keepLocal(key: string, remote: Version): Promise<boolean> {
    const text = await this.o.local.read(this.localPathOf.get(key) ?? key);
    if (text === null) {
      await this.syncPath(key, remote, false);
      return false;
    }
    const local = await versionOf(text);
    let again: Again | undefined;
    try {
      again = await this.upload(key, text, remote);
    } catch (e) {
      if (!(e instanceof RejectedError)) throw e;
      this.rejected.set(key, { version: local, detail: e.message });
      return false;
    }
    // The server changed since the list: decided as usual, which keeps both texts.
    if (again !== undefined) await this.syncPath(key, again.remote, false);
    return again === undefined && this.state.bases[key] === local;
  }

  /** Kumbu²'s text replaces the local file, which goes to Obsidian's .trash first. */
  private async keepKumbu(key: string): Promise<boolean> {
    const path = this.localPathOf.get(key) ?? key;
    const note = await this.o.remote.read(key);
    if (note === null) {
      await this.syncPath(key, null, false);
      return false;
    }
    await this.o.local.trashToLocal(path);
    if (!(await this.o.local.writeIf(path, null, note.content))) {
      await this.syncPath(key, note.version, false);
      return false;
    }
    await this.setBase(key, note.version);
    return true;
  }

  /** Lists the local files: spellings, attachments and conflict copies. Returns key → path of the syncable ones. */
  private async scanLocal(full: boolean): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (full) this.attachments.clear();
    for (const path of await this.o.local.list()) {
      const kind = eligibility(path);
      if (kind === "attachment") this.attachments.add(path);
      if (kind !== "sync") continue;
      const key = keyOf(path);
      found.set(key, path);
      this.localPathOf.set(key, path);
      if (COPY_NAME.test(key)) this.conflicts.add(key);
    }
    for (const copy of [...this.conflicts]) if (!found.has(copy)) this.conflicts.delete(copy);
    return found;
  }

  private async syncPath(key: string, remote: Version | null, damagedPossible: boolean): Promise<void> {
    if (eligibility(key) !== "sync" || this.caseClashes.has(key)) {
      this.dirty.delete(key);
      return;
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (this.stopped) return;
      const path = this.localPathOf.get(key) ?? key;
      const text = await this.o.local.read(path);
      const local = text === null ? null : await versionOf(text);
      const base = this.state.bases[key] ?? null;
      const action = decide({ local, remote, base, remoteDamagedPossible: damagedPossible });
      // A change of this device's the server refused is not sent again until the file changes again.
      const outgoing = action.kind === "upload" || action.kind === "reupload" || action.kind === "deleteRemote";
      if (outgoing && this.rejected.get(key)?.version === (local ?? "")) return;
      let again: Again | undefined;
      try {
        again = await this.act(key, path, text, local, remote, action);
      } catch (e) {
        if (!(e instanceof RejectedError)) throw e;
        this.rejected.set(key, { version: local ?? "", detail: e.message });
        this.dirty.delete(key);
        return;
      }
      if (outgoing || this.rejected.get(key)?.version === UNEXPECTED) this.rejected.delete(key);
      if (again === undefined) {
        this.dirty.delete(key);
        return;
      }
      remote = again.remote;
    }
  }

  private async act(
    key: string, path: string, text: string | null, local: Version | null, remote: Version | null, action: Action,
  ): Promise<Again | undefined> {
    switch (action.kind) {
      case "nothing":
        if (local === null && remote === null && this.state.bases[key] !== undefined) {
          delete this.state.bases[key];
          await this.save();
        }
        return undefined;

      case "recordBase":
        this.forgetProblems(key);
        await this.setBase(key, action.version);
        return undefined;

      case "upload":
      case "reupload":
        return this.upload(key, text!, action.kind === "upload" ? action.base : null);

      case "download": {
        const note = await this.o.remote.read(key);
        if (note === null) return { remote: null };
        if (!(await this.o.local.writeIf(path, local, note.content))) return { remote: note.version };
        this.localPathOf.set(key, path);
        this.forgetProblems(key);
        await this.setBase(key, note.version);
        return undefined;
      }

      case "trashLocal": {
        // Asked again right before: a keystroke since the read makes it an edit, not a file to trash.
        const now = await this.o.local.read(path);
        if (now === null || (await versionOf(now)) !== local) return { remote };
        await this.o.local.trashByPreference(path);
        delete this.state.bases[key];
        await this.save();
        return undefined;
      }

      case "deleteRemote": {
        const result = await this.o.remote.remove(key, action.base);
        if (!result.ok && result.conflict !== null) return { remote: result.conflict.version };
        delete this.state.bases[key];
        this.forgetProblems(key);
        await this.save();
        return undefined;
      }

      case "conflict":
        return this.conflict(key, path, text!, local!, remote);
    }
  }

  private async upload(key: string, text: string, base: Version | null): Promise<Again | undefined> {
    if (byteSize(text) > MAX_BYTES) {
      this.tooLarge.add(key);
      return undefined;
    }
    this.tooLarge.delete(key);
    const result = await this.o.remote.put(key, text, base);
    if (!result.ok) return { remote: result.conflict.version };
    await this.setBase(key, result.version);
    return undefined;
  }

  /** Kumbu²'s version keeps the path; the local text becomes a copy next to it (spec §7). */
  private async conflict(key: string, path: string, text: string, local: Version, remote: Version | null): Promise<Again | undefined> {
    const note = await this.o.remote.read(key);
    if (note === null) return { remote: null };
    if (note.version !== remote) return { remote: note.version };
    const at = new Date(this.o.clock.now());
    const textOf = (local: string) => conflictCopyText(local, {
      device: this.o.device, localAt: at, remoteWriter: note.lastWriter, remoteAt: new Date(note.lastWriteAt), originalPath: key,
    });
    let copyText = textOf(text);
    const copy = await this.freeCopyPath(conflictCopyPath(path, this.o.device, at));
    if (!(await this.o.local.writeIf(copy, null, copyText))) return { remote };
    // The copy is safe on disk before the original is overwritten, so a failure from here on loses nothing.
    const copyKey = keyOf(copy);
    this.localPathOf.set(copyKey, copy);
    this.conflicts.add(copyKey);
    this.dirty.add(copyKey);
    this.copiesMade++;
    this.o.onConflict(key, copyKey);
    let replaced = await this.o.local.writeIf(path, local, note.content);
    // Typed on meanwhile: the newer text goes into the same copy, rather than a second copy for one conflict.
    for (let round = 0; !replaced && round < MAX_ROUNDS; round++) {
      const now = await this.o.local.read(path);
      if (now === null) break;
      const next = textOf(now);
      if (!(await this.o.local.writeIf(copy, await versionOf(copyText), next))) break;
      copyText = next;
      replaced = await this.o.local.writeIf(path, await versionOf(now), note.content);
    }
    if (replaced) await this.setBase(key, note.version);
    // Uploaded whatever happened to the original: it is a note of its own now.
    await this.syncPath(copyKey, null, false);
    // The original changed again meanwhile (typed, deleted): decided once more, against the copy's text.
    return replaced ? undefined : { remote: note.version };
  }

  private async freeCopyPath(candidate: string): Promise<string> {
    let path = candidate;
    for (let n = 2; (await this.o.local.read(path)) !== null; n++) path = candidate.replace(/\.md$/, ` ${n}.md`);
    return path;
  }

  private forgetProblems(key: string): void {
    this.rejected.delete(key);
    this.tooLarge.delete(key);
  }

  private async setBase(key: string, version: Version): Promise<void> {
    this.state.bases[key] = version;
    await this.save();
  }

  private save(): Promise<void> {
    return this.o.state.save(this.state);
  }

  private failed(e: unknown): void {
    if (e instanceof AuthError) {
      this.stopped = true;
      for (const h of this.debounces.values()) this.o.clock.clearTimeout(h);
      this.debounces.clear();
      this.cancelRetry();
      this.o.onAuthLost();
      return;
    }
    // Offline, or anything unexpected: nothing is dropped (dirty paths stay), and a check is tried again later.
    if (!(e instanceof OfflineError)) console.error("Kumbu² Sync:", e);
    this.offline = true;
    const backoff = this.retryDelay === 0 ? RETRY_FIRST_MS : Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.retryDelay = backoff;
    const delay = e instanceof OfflineError && e.retryAfterMs !== null ? e.retryAfterMs : backoff;
    this.cancelRetry();
    this.retryHandle = this.o.clock.setTimeout(() => {
      this.retryHandle = null;
      void this.check(false);
    }, delay);
  }

  private online(): void {
    if (!this.offline) return;
    this.offline = false;
    this.retryDelay = 0;
    this.cancelRetry();
  }

  private cancelRetry(): void {
    if (this.retryHandle !== null) this.o.clock.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private cancelDebounce(key: string): void {
    const h = this.debounces.get(key);
    if (h !== undefined) this.o.clock.clearTimeout(h);
    this.debounces.delete(key);
  }

  private emit(): void {
    this.o.onStatus(this.status());
  }
}

/** Ordinal order, the same on every device. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
