// SPDX-License-Identifier: AGPL-3.0-or-later
// The engine's ports and the types every part of the plugin shares.

export type Version = string; // 12 hex chars
export interface RemoteEntry { path: string; version: Version | null; } // vault-relative path; null = deleted
export interface VersionsAnswer {
  full: boolean; entries: RemoteEntry[]; cursor: string; state: string | null; damaged: number; unchanged: boolean;
}
export interface RemoteNote { path: string; content: string; version: Version; lastWriter: string; lastWriteAt: string; }
export type PutResult = { ok: true; version: Version } | { ok: false; conflict: { content: string; version: Version } };
export type DeleteResult = { ok: true } | { ok: false; conflict: { content: string; version: Version } | null }; // null: already gone
export type MoveResult = { ok: true; version: Version } | { ok: false };

/** 401: the key expired or was revoked. */
export class AuthError extends Error {}
/** 400/413: the server's sentence is the message. */
export class RejectedError extends Error {}
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
}

export interface LocalFiles {
  list(): Promise<string[]>; // vault-relative paths of all files, any extension
  read(path: string): Promise<string | null>;
  size(path: string): Promise<number | null>; // bytes on disk
  /** Writes only if the current text still has version `expected` (null: file must not exist). Returns false if it changed. */
  writeIf(path: string, expected: Version | null, content: string): Promise<boolean>;
  trashToLocal(path: string): Promise<void>; // Obsidian's .trash, always (first-sync "Keep Kumbu²")
  trashByPreference(path: string): Promise<void>; // the user's trash setting (remote deletions)
  rename(from: string, to: string): Promise<void>;
}

export interface SyncState {
  bases: Record<string, Version>; // vault-relative path → agreed version
  cursor: string | null; lastFullAt: string | null; lastSyncAt: string | null;
}
export interface StateStore { load(): Promise<SyncState>; save(state: SyncState): Promise<void>; }
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; }

export type NotSyncedReason = "attachment" | "too-large" | "rejected" | "case-clash" | "damaged-vault";
export interface NotSynced { path: string; reason: NotSyncedReason; detail?: string; }
export type ConnectionMode = "live" | "polling" | "offline";
export interface SyncStatus { mode: ConnectionMode; notSynced: NotSynced[]; conflicts: string[]; busy: boolean; lastSyncAt: string | null; }
