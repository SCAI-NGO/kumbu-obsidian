// SPDX-License-Identifier: AGPL-3.0-or-later
// The Kumbu² REST API over an injected HTTP function: requestUrl in Obsidian, fetch in Node.
import {
  AuthError, OfflineError, RejectedError,
  type DeleteResult, type MoveResult, type PutResult, type RemoteApi, type RemoteEntry, type RemoteNote,
  type Version, type VersionsAnswer,
} from "../engine/ports";
import { fromApiPath, toApiPath, urlFor } from "../engine/paths";
import { normaliseText } from "../engine/version";
import type {
  ConflictView, ErrorView, MovedView, MoveRequest, NoteView, PutNoteRequest, RedeemRequest, RedeemView,
  VaultView, VersionsView, WsTicketView,
} from "./types";

export interface HttpRequest { method: string; url: string; headers: Record<string, string>; body?: string; }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string; }
/** Throws only on network failure; every status comes back as a response. */
export type HttpFn = (r: HttpRequest) => Promise<HttpResponse>;

const WRONG_CODE = "This code is not valid (any more).";

export class KumbuApi implements RemoteApi {
  private readonly server: string;

  constructor(private readonly http: HttpFn, server: string, private readonly vault: string, private readonly key: string) {
    this.server = trimServer(server);
  }

  async versions(since: string | null, state: string | null): Promise<VersionsAnswer> {
    const query = since === null ? "" : `?since=${encodeURIComponent(since)}`;
    const headers: Record<string, string> = {};
    // The server answers 304 only to a full list, so the tag goes only with one.
    if (since === null && state !== null) headers["If-None-Match"] = `"${state}"`;
    const r = await this.send("GET", `/api/vaults/${encodeURIComponent(this.vault)}/versions${query}`, undefined, headers);
    if (r.status === 304) return { full: true, entries: [], cursor: "", state, damaged: 0, unchanged: true };
    if (r.status === 404) throw new AuthError(errorOf(r) ?? `This key can't open the vault ${this.vault} any more.`);
    expectOk(r);
    const view = parse<VersionsView>(r);
    const entries: RemoteEntry[] = view.notes.map((n) => ({ path: fromApiPath(this.vault, n.path), version: n.version }));
    if (!view.full) for (const p of view.deleted ?? []) entries.push({ path: fromApiPath(this.vault, p), version: null });
    return { full: view.full, entries, cursor: view.cursor, state: view.state, damaged: view.damaged, unchanged: false };
  }

  async read(path: string): Promise<RemoteNote | null> {
    const r = await this.send("GET", urlFor(this.vault, path));
    if (r.status === 404) return null;
    expectOk(r);
    const n = parse<NoteView>(r);
    return { path: fromApiPath(this.vault, n.path), content: n.content, version: n.version, lastWriter: n.lastWriter, lastWriteAt: n.lastWriteAt };
  }

  async put(path: string, content: string, base: Version | null): Promise<PutResult> {
    const body: PutNoteRequest = base === null ? { content: normaliseText(content) } : { content: normaliseText(content), version: base };
    const r = await this.send("PUT", urlFor(this.vault, path), body);
    if (r.status === 409) {
      const conflict = await this.conflictOf(r, path);
      if (conflict) return { ok: false, conflict };
      // The note is gone meanwhile: the local text wins and becomes a new note, as for "local changed, remote gone".
      if (base !== null) return this.put(path, content, null);
      throw new OfflineError(errorOf(r) ?? "The server refused the write and the note isn't there; trying again later.");
    }
    if (r.status === 404) {
      // With a base, 404 is the note gone (the server's answer to a version it can't find): create it anew.
      if (base !== null) return this.put(path, content, null);
      throw new AuthError(errorOf(r) ?? `This key can't open the vault ${this.vault} any more.`);
    }
    expectOk(r);
    return { ok: true, version: parse<NoteView>(r).version };
  }

  async remove(path: string, base: Version): Promise<DeleteResult> {
    const r = await this.send("DELETE", `${urlFor(this.vault, path)}?version=${encodeURIComponent(base)}`);
    if (r.status === 404) return { ok: false, conflict: null };
    if (r.status === 409) return { ok: false, conflict: await this.conflictOf(r, path) };
    expectOk(r);
    return { ok: true };
  }

  async move(from: string, to: string): Promise<MoveResult> {
    const body: MoveRequest = { from: toApiPath(this.vault, from), to: toApiPath(this.vault, to), keepLinks: true };
    const r = await this.send("POST", "/api/move", body);
    if (r.status === 409 || r.status === 404) return { ok: false };
    expectOk(r);
    const view = parse<MovedView>(r);
    return view.version ? { ok: true, version: view.version } : { ok: false };
  }

  async wsTicket(): Promise<string> {
    const r = await this.send("POST", "/api/ws-ticket");
    expectOk(r);
    return parse<WsTicketView>(r).ticket;
  }

  async vaults(): Promise<{ name: string; canWrite: boolean }[]> {
    const r = await this.send("GET", "/api/vaults");
    expectOk(r);
    return parse<VaultView[]>(r).map((v) => ({ name: v.name, canWrite: v.canWrite === true }));
  }

  /** The current note of a 409: from its body, or read when the body has none. */
  private async conflictOf(r: HttpResponse, path: string): Promise<{ content: string; version: Version } | null> {
    const view = tryParse<ConflictView>(r);
    if (view?.current) return { content: view.current.content, version: view.current.version };
    const now = await this.read(path);
    return now ? { content: now.content, version: now.version } : null;
  }

  private send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, ...extra };
    return call(this.http, { method, url: this.server + path, headers }, body);
  }
}

export async function redeemPairing(http: HttpFn, server: string, code: string, device: string): Promise<RedeemView> {
  const body: RedeemRequest = { code: normalisePairingCode(code), device: device.trim() };
  const r = await call(http, { method: "POST", url: `${trimServer(server)}/api/pairing/redeem`, headers: {} }, body);
  if (r.status === 404 || r.status === 400 || r.status === 429) throw new RejectedError(errorOf(r) ?? WRONG_CODE);
  expectOk(r);
  return parse<RedeemView>(r);
}

/** Uppercase, without spaces and dashes; I and L read as 1, O as 0 (Crockford Base32). */
export function normalisePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

export function trimServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

async function call(http: HttpFn, request: HttpRequest, body?: unknown): Promise<HttpResponse> {
  if (body !== undefined) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }
  try {
    return await http(request);
  } catch (e) {
    throw new OfflineError(e instanceof Error ? e.message : String(e));
  }
}

function expectOk(r: HttpResponse): void {
  if (r.status >= 200 && r.status < 300) return;
  const sentence = errorOf(r);
  if (r.status === 401 || r.status === 403) throw new AuthError(sentence ?? "This key expired or was revoked.");
  if (r.status === 503 || r.status === 429 || r.status >= 500 || r.status === 408) {
    throw new OfflineError(sentence ?? `The server answered ${r.status}.`, retryAfterMs(r));
  }
  throw new RejectedError(sentence ?? `The server refused this (${r.status}).`);
}

function header(r: HttpResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(r.headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function retryAfterMs(r: HttpResponse): number | null {
  const value = header(r, "Retry-After");
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function parse<T>(r: HttpResponse): T {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new OfflineError(`The server sent an answer that isn't JSON (${r.status}).`);
  }
}

function tryParse<T>(r: HttpResponse): T | null {
  try {
    return JSON.parse(r.text) as T;
  } catch {
    return null;
  }
}

function errorOf(r: HttpResponse): string | null {
  const view = tryParse<Partial<ErrorView>>(r);
  return typeof view?.error === "string" && view.error ? view.error : null;
}
