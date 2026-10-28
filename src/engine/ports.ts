// SPDX-License-Identifier: AGPL-3.0-or-later
// The engine's ports and the types every part of the plugin shares.

export type Version = string; // 12 hex chars
/** What a path holds on a server with attachments; a server without them gives no kind. */
export type FileKind = "note" | "image" | "pdf";
export interface RemoteEntry { path: string; version: Version | null; kind?: FileKind; } // vault-relative path; null = deleted
export interface VersionsAnswer {
  full: boolean; entries: RemoteEntry[]; cursor: string; state: string | null; damaged: number; unchanged: boolean;
  /** The server keeps attachments: it lists them, and serves them through readFile, putFile and removeFile. */
  attachments: boolean;
}
export interface RemoteNote { path: string; content: string; version: Version; lastWriter: string; lastWriteAt: string; }
export type PutResult = { ok: true; version: Version } | { ok: false; conflict: { content: string; version: Version } };
export type DeleteResult = { ok: true } | { ok: false; conflict: { content: string; version: Version } | null }; // null: already gone
export type MoveResult = { ok: true; version: Version } | { ok: false };
/** An attachment's bytes, exactly as stored, and their version. */
export interface RemoteFile { bytes: ArrayBuffer; version: Version; }
/** An attachment's conflict carries the version only: its bytes are read when needed. */
export type FilePutResult = { ok: true; version: Version } | { ok: false; conflict: { version: Version } };
export type FileDeleteResult = { ok: true } | { ok: false; conflict: { version: Version } | null }; // null: already gone

/** 401: the key expired or was revoked. */
export class AuthError extends Error {}
/** 400/413 (and pairing's 404/409/429): the server's sentence is the message. */
export class RejectedError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); }
}
/** Network failure, 5xx, 429, timeout. `retryAfterMs` comes from a Retry-After header. */
export class OfflineError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) { super(message); }
}

export interface RemoteApi {
  versions(since: string | null, state: string | null): Promise<VersionsAnswer>;
  read(path: string): Promise<RemoteNote | null>;
  put(path: string, content: string, base: Version | null): Promise<PutResult>;
  remove(path: string, base: Version): Promise<DeleteResult>;
  move(from: string, to: string): Promise<MoveResult>; // keepLinks: true, always
  /** Attachments (PDFs, images), only on a server whose versions answer says `attachments`. */
  readFile(path: string): Promise<RemoteFile | null>;
  putFile(path: string, bytes: ArrayBuffer, base: Version | null): Promise<FilePutResult>;
  removeFile(path: string, base: Version): Promise<FileDeleteResult>;
}

export interface LocalFiles {
  /** True where "Plan.md" and "plan.md" are one file (macOS, Windows, Android, iOS). */
  readonly caseInsensitive: boolean;
  list(): Promise<string[]>; // vault-relative paths of all files, any extension
  /** The text the user sees: an open editor's unsaved text if there is one, else the file's. */
  read(path: string): Promise<string | null>;
  size(path: string): Promise<number | null>; // bytes on disk
  /**
   * Writes only if the text the user sees (as `read` gives it, so unsaved typing in an editor counts) still has
   * version `expected` (null: the file must not exist). Returns false if it changed.
   */
  writeIf(path: string, expected: Version | null, content: string): Promise<boolean>;
  /** The file's bytes as they are on disk (attachments), null if there is none. */
  readBinary(path: string): Promise<ArrayBuffer | null>;
  /** writeIf for bytes: writes only if the file's bytes still have version `expected` (null: it must not exist). */
  writeBinaryIf(path: string, expected: Version | null, bytes: ArrayBuffer): Promise<boolean>;
  trashToLocal(path: string): Promise<void>; // Obsidian's .trash, always (first-sync "Keep Kumbu²")
  /**
   * Trashes by the user's trash setting (remote deletions), only if the text the user sees (as `read` gives it)
   * still has version `expected`, checked right before trashing. Returns false, and keeps the file, if it changed.
   */
  trashIf(path: string, expected: Version): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  /** Deletes the folder if it has nothing in it at all, dot files included. True if it deleted it. */
  removeFolderIfEmpty(path: string): Promise<boolean>;
}

export interface SyncState {
  bases: Record<string, Version>; // vault-relative path → agreed version
  cursor: string | null; lastFullAt: string | null; lastSyncAt: string | null;
  /** The first sync's answer to its one question, kept until the first sync is done, so it is never asked twice. */
  pendingChoice?: "both" | "local" | "kumbu" | null;
}
export interface StateStore { load(): Promise<SyncState>; save(state: SyncState): Promise<void>; }
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; }

export type NotSyncedReason = "attachment" | "too-large" | "rejected" | "case-clash" | "damaged-vault";
export interface NotSynced { path: string; reason: NotSyncedReason; detail?: string; }
export type ConnectionMode = "live" | "polling" | "offline";
export interface SyncStatus { mode: ConnectionMode; notSynced: NotSynced[]; conflicts: string[]; busy: boolean; lastSyncAt: string | null; }
