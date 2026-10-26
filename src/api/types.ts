// SPDX-License-Identifier: AGPL-3.0-or-later
// Every request and response shape of the Kumbu² server the plugin uses, and nowhere else.
// Source: the API contract in kumbukumbu's docs/superpowers/plans/2026-10-26-obsidian-sync-server.md
// and src/Kumbu.Server/Api/NoteApi.cs. Paths are vault-tree paths ("/Work/plan.md").

export interface ErrorView { error: string; }

/** GET /api/vaults/{vault}/versions[?since=] (ETag "<state>"; 304 for If-None-Match without since). */
export interface VersionsView {
  full: boolean;
  cursor: string;
  state: string;
  damaged: number;
  notes: { path: string; version: string }[];
  /** Only when full is false: touched paths with no note now. */
  deleted?: string[];
}

/** GET/PUT /api/notes/{vault}/{path}. */
export interface NoteView {
  path: string;
  content: string;
  version: string;
  lastWriter: string;
  lastWriteAt: string;
  current: boolean;
  /** Sessions only; null for API key callers. */
  lastWriterKind?: string | null;
}

/** PUT /api/notes/{vault}/{path}; version omitted to create. */
export interface PutNoteRequest { content: string; version?: string; }

/** 409 on PUT and DELETE. */
export interface ConflictView { error: string; current?: { content: string; version: string }; }

/** POST /api/move. */
export interface MoveRequest { from: string; to: string; keepLinks: boolean; }
export interface MovedView { message: string; path: string | null; version: string | null; }

/** POST /api/ws-ticket. */
export interface WsTicketView { ticket: string; expiresAt: string; }

/** GET /api/vaults. */
export interface VaultView { name: string; notes: number; embeddings: string; pending: boolean; canWrite?: boolean; }

/** POST /api/pairing/redeem (anonymous). */
export interface RedeemRequest { code: string; device: string; }
export interface RedeemView { key: string; vault: string; keyName: string; }

/** WebSocket message, server → client. */
export interface HintMessage { type: "changed"; vault: string; }

/** WebSocket close code for a revoked or expired key. */
export const CLOSE_KEY_REVOKED = 4401;
