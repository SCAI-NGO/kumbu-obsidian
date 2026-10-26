# Kumbu² Sync (Obsidian plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin, `kumbu-sync`, that pairs an Obsidian vault with one Kumbu² vault and keeps both in sync within seconds, merging an existing vault on the first sync and never losing an edit.

**Architecture:** A sync engine in plain TypeScript (no Obsidian imports) owns every decision and runs one serial queue per vault; it talks to the world through three ports: `LocalFiles`, `RemoteApi` and `StateStore`. One HTTP module (`src/api/client.ts`) implements `RemoteApi` over an injected HTTP function (Obsidian's `requestUrl` in the plugin, `fetch` in Node). A thin Obsidian layer wires vault events, the WebSocket hint connection, settings, modals and the status bar to the engine.

**Tech Stack:** TypeScript 5, esbuild, pnpm, Vitest, ESLint 9 with `eslint-plugin-obsidianmd` (`configs.recommended`), the `obsidian` API package, Node ≥ 22 for the end-to-end harness (global `fetch` and `WebSocket`).

**Spec:** `docs/superpowers/specs/2026-10-26-obsidian-sync-design.md` in [SCAI-NGO/kumbukumbu](https://github.com/SCAI-NGO/kumbukumbu) (§3 flow, §4 pairing, §5 API, §6 engine, §7 conflicts, §8 secret, §9 tests, §10 release). The approved onboarding mockup is `.superpowers/brainstorm/71940-1792993721/content/onboarding.html` in the kumbukumbu checkout (not committed; the texts below are copied from it).

**Server contract:** the server side is planned in parallel in `docs/superpowers/plans/2026-10-26-obsidian-sync-server.md` (kumbukumbu). This plan defines the client against the spec's §4/§5/§5a shapes and the endpoints that exist today (`src/Kumbu.Server/Api/NoteApi.cs`, verified 2026-10-26). **Every HTTP shape lives in `src/api/client.ts` and `src/api/types.ts` and nowhere else.** When the server plan fixes a different name or field, only those two files and their tests change; before Task 3 starts, the implementer compares `types.ts` with the server plan and with `GET /api/openapi.json` of a running server and adjusts.

## Global Constraints

- Plugin id `kumbu-sync`, name `Kumbu² Sync`, `minAppVersion` `1.11.4`, `isDesktopOnly: false`; the id must not contain "obsidian".
- Licence AGPL-3.0-or-later; every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Code, comments, docs and commit messages in British English; UI strings in English, sentence case (lint rule `obsidianmd/ui/sentence-case`).
- pnpm only; commit messages imperative and free-form, no Conventional Commits prefix.
- Version token: first 12 lowercase hex characters of SHA-256 over the UTF-8 text **after CRLF → LF**; uploads send the LF text.
- Note size limit: 1,048,576 bytes of UTF-8 after CRLF → LF.
- Synced files: `.md` only, outside every dot folder (`.obsidian/`, `.trash/`, any segment starting with `.`).
- Upload debounce: 2 s after the last change per file.
- Full version list on: first sync, plugin start, app becoming visible again, once an hour, and when the cursor is older than 25 days; everything else asks with `since=<cursor>`.
- WebSocket reconnect: exponential backoff from 1 s to 5 min with jitter, a version check after every reconnect; after 3 failed connections in a row also poll every 2 min while still retrying the WebSocket.
- Server URL must be `https://`, except `http://localhost` and `http://127.0.0.1` (any port).
- The API key lives only in `app.secretStorage`; `data.json` holds the secret's id only; no plain-text key field anywhere. Secret ids must be lowercase alphanumerics and dashes (`SecretStorage.setSecret` throws otherwise): `kumbu-<slug(vault)>-<slug(device)>`.
- Device names: at most 32 characters, letters, digits, spaces, `-` and `_` only (no parentheses: the server's writer label cuts at `" ("`); default `<Platform>-<2 Crockford chars>`, e.g. `Android-7Q`, `Linux-K3`.
- Conflict copy name: `<name> (conflict <device> YYYY-MM-DD HH-mm).md` in local time, next to the original.
- No vault is ever created by the plugin; it needs write rights on exactly the vault it syncs.

## Review Focus

- **Umlauts in paths** ("Besprechung März.md"): macOS and some Android file systems hand out NFD, the server and other devices NFC. Expected: one note, never a second upload or a conflict. Pinned in Task 1 (`toApiPath` normalises to NFC) and Task 5 (an NFD local path matching an NFC remote path syncs as one note).
- **Paths differing only in case** (`Plan.md` and `plan.md` on the server, phone or Windows file system case-insensitive). Expected: the first one syncs, the second is listed as "not synced: differs only in case from another note", and nothing overwrites anything. Pinned in Task 5.
- **Server unreachable or failing mid-sync** (5xx, timeouts, phone losing signal). Expected: no work is dropped and the queue never stalls; the status bar says `offline`, and the next trigger retries. Pinned in Task 5.
- **Files changed while Obsidian was closed** (git pull, a file manager, another sync tool). Expected: the start-up full check uploads them as ordinary edits, without conflicts. Pinned in Task 5.
- **A first sync interrupted** (app closed or network lost after part of the uploads). Expected: running it again finishes the job, with no duplicates and no conflict copies for files already done, because bases are recorded per file as each operation completes. Pinned in Task 6.

---

## File Structure

```
kumbu-obsidian/
├── manifest.json            id, name, version, minAppVersion
├── versions.json            plugin version → minAppVersion
├── package.json, pnpm-lock.yaml, tsconfig.json
├── esbuild.config.mjs       bundles src/main.ts → main.js (CommonJS, obsidian external)
├── eslint.config.mjs        obsidianmd.configs.recommended
├── vitest.config.ts
├── styles.css               classes for modals, result counts, status bar
├── .github/workflows/ci.yml       lint, test, build on push and PR
├── .github/workflows/release.yml  on tag x.y.z: build, release with main.js, manifest.json, styles.css
├── src/
│   ├── main.ts              Plugin: lifecycle, wiring (Obsidian)
│   ├── engine/              pure TS, no "obsidian" import (ESLint rule enforces it)
│   │   ├── version.ts       normalise text, version token, byte size
│   │   ├── paths.ts         API ↔ vault paths, NFC, eligibility, conflict copy names, slug
│   │   ├── decide.ts        the decision table as a pure function
│   │   ├── conflict.ts      conflict copy text (callout after frontmatter)
│   │   ├── queue.ts         serial queue with keyed deduplication
│   │   ├── ports.ts         LocalFiles, RemoteApi, StateStore, Clock interfaces and shared types
│   │   ├── engine.ts        SyncEngine: triggers, checks, operations, status
│   │   └── firstSync.ts     merge plan, one-time choice, apply, summary
│   ├── api/
│   │   ├── types.ts         every request/response shape of the server (the only place)
│   │   └── client.ts        KumbuApi implements RemoteApi over HttpFn; pairing and vault list
│   ├── live/
│   │   └── hints.ts         HintConnection: ticket, WebSocket, backoff, polling fallback, hourly full check
│   └── obsidian/
│       ├── http.ts          HttpFn over requestUrl
│       ├── vaultFiles.ts    LocalFiles over Vault and FileManager
│       ├── secret.ts        SecretStorage access and the availability check
│       ├── settingsTab.ts   not connected / connected views, pairing, fallback, disconnect
│       ├── modals.ts        ConflictChoiceModal, NotesListModal, ResultModal
│       └── statusBar.ts     "Kumbu² ● live · 3 not synced"
├── test/
│   ├── fakes/fakeServer.ts  in-memory RemoteApi with scripted delays, reordering, failures
│   ├── fakes/fakeFiles.ts   in-memory LocalFiles with a modify hook
│   └── *.test.ts
└── e2e/
    ├── nodeFiles.ts         LocalFiles over node:fs in a temp folder
    └── run.ts               the end-to-end race run against a compose stack
```

### Shared types (defined in `src/engine/ports.ts`, used by every later task)

```ts
export type Version = string;                       // 12 hex chars
export interface RemoteEntry { path: string; version: Version | null; } // vault-relative path; null = deleted
export interface VersionsAnswer {
  full: boolean; entries: RemoteEntry[]; cursor: string; state: string | null; damaged: number; unchanged: boolean;
}
export interface RemoteNote { path: string; content: string; version: Version; lastWriter: string; lastWriteAt: string; }
export type PutResult = { ok: true; version: Version } | { ok: false; conflict: { content: string; version: Version } };
export type DeleteResult = { ok: true } | { ok: false; conflict: { content: string; version: Version } | null }; // null: already gone
export type MoveResult = { ok: true; version: Version } | { ok: false };

export class AuthError extends Error {}             // 401: key expired or revoked
export class RejectedError extends Error {}         // 400/413: the server's sentence is the message
export class OfflineError extends Error {}          // network failure, 5xx, timeout

export interface RemoteApi {
  versions(since: string | null, state: string | null): Promise<VersionsAnswer>;
  read(path: string): Promise<RemoteNote | null>;
  put(path: string, content: string, base: Version | null): Promise<PutResult>;
  remove(path: string, base: Version): Promise<DeleteResult>;
  move(from: string, to: string): Promise<MoveResult>;  // keepLinks: true, always
}

export interface LocalFiles {
  list(): Promise<string[]>;                         // vault-relative paths of all files, any extension
  read(path: string): Promise<string | null>;
  size(path: string): Promise<number | null>;        // bytes on disk
  /** Writes only if the current text still has version `expected` (null: file must not exist). Returns false if it changed. */
  writeIf(path: string, expected: Version | null, content: string): Promise<boolean>;
  trashToLocal(path: string): Promise<void>;         // Obsidian's .trash, always (first-sync "Keep Kumbu²")
  trashByPreference(path: string): Promise<void>;    // the user's trash setting (remote deletions)
  rename(from: string, to: string): Promise<void>;
}

export interface SyncState {
  bases: Record<string, Version>;                    // vault-relative path → agreed version
  cursor: string | null; lastFullAt: string | null; lastSyncAt: string | null;
}
export interface StateStore { load(): Promise<SyncState>; save(state: SyncState): Promise<void>; }
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; }

export type NotSyncedReason = "attachment" | "too-large" | "rejected" | "case-clash" | "damaged-vault";
export interface NotSynced { path: string; reason: NotSyncedReason; detail?: string; }
export type ConnectionMode = "live" | "polling" | "offline";
export interface SyncStatus { mode: ConnectionMode; notSynced: NotSynced[]; conflicts: string[]; busy: boolean; lastSyncAt: string | null; }
```

---

### Task 1: Repository tooling, versions and paths

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `manifest.json`, `versions.json`, `styles.css`, `.github/workflows/ci.yml`, `src/main.ts` (empty `Plugin` subclass), `src/engine/ports.ts` (the shared types above), `src/engine/version.ts`, `src/engine/paths.ts`
- Modify: `.gitignore` (already ignores `main.js`, `node_modules/`)
- Test: `test/version.test.ts`, `test/paths.test.ts`

**Interfaces:**
- Produces:
  - `normaliseText(text: string): string` (CRLF → LF only)
  - `versionOf(text: string): Promise<Version>` (normalises first; `crypto.subtle.digest("SHA-256", …)`, works in Obsidian and Node ≥ 22)
  - `byteSize(text: string): number` (UTF-8 bytes of the normalised text)
  - `MAX_BYTES = 1_048_576`
  - `toApiPath(vault: string, path: string): string` → `"/Work/projects/Plan.md"`, NFC-normalised
  - `fromApiPath(vault: string, apiPath: string): string` → `"projects/Plan.md"`, NFC
  - `urlFor(vault: string, path: string): string` → `"/api/notes/Work/projects/Plan%20M%C3%A4rz.md"`, each segment `encodeURIComponent`, like the web app's `noteUrl`
  - `eligibility(path: string): "sync" | "attachment" | "ignored"` (`ignored`: inside a dot folder)
  - `conflictCopyPath(path: string, device: string, at: Date): string`
  - `slug(text: string): string` (lowercase, `[a-z0-9-]`, runs of anything else become one `-`, trimmed; `ä` → `a` via NFD and stripping marks)
  - `secretId(vault: string, device: string): string` → `kumbu-<slug(vault)>-<slug(device)>`
  - `defaultDeviceName(platform: string, random: () => number): string`
  - `isAllowedServerUrl(url: string): boolean`

- [ ] **Step 1: Scaffold the tooling**

`manifest.json`: `{"id":"kumbu-sync","name":"Kumbu² Sync","version":"0.1.0","minAppVersion":"1.11.4","description":"Keeps this vault in sync with a Kumbu² vault.","author":"SCAI-NGO","isDesktopOnly":false}`. `versions.json`: `{"0.1.0":"1.11.4"}`. Dev dependencies: `obsidian` (latest), `typescript`, `esbuild`, `vitest`, `eslint`, `eslint-plugin-obsidianmd`, `typescript-eslint`, `@types/node`. Scripts: `build` (tsc --noEmit, then esbuild production), `dev` (esbuild watch), `lint` (`eslint .`), `test` (`vitest run`), `e2e` (`node --experimental-strip-types e2e/run.ts`). `eslint.config.mjs` uses `...obsidianmd.configs.recommended` with `parserOptions.projectService.allowDefaultProject: ["eslint.config.*"]` (README of `eslint-plugin-obsidianmd`), plus `no-restricted-imports` banning `obsidian` in `src/engine/**`, `src/api/**` and `src/live/**`. `ci.yml`: Node 22, pnpm, then `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/version.test.ts
test("version matches the server's token", async () => {
  // printf '# Plan\n' | sha256sum → c3964bb3b70a…
  expect(await versionOf("# Plan\n")).toBe("c3964bb3b70a");
  expect(await versionOf("# Plan\r\n")).toBe("c3964bb3b70a");
});
test("byte size counts UTF-8 after CRLF → LF", () => {
  expect(byteSize("ä\r\n")).toBe(3);
});

// test/paths.test.ts
test("api paths are NFC", () => {
  expect(toApiPath("Work", "Besprechung März.md")).toBe("/Work/Besprechung März.md");
  expect(fromApiPath("Work", "/Work/a/b.md")).toBe("a/b.md");
});
test("urls encode each segment", () => {
  expect(urlFor("Work", "a b/c#d.md")).toBe("/api/notes/Work/a%20b/c%23d.md");
});
test("eligibility", () => {
  expect(eligibility("notes/a.md")).toBe("sync");
  expect(eligibility("img/x.png")).toBe("attachment");
  expect(eligibility(".obsidian/app.json")).toBe("ignored");
  expect(eligibility("a/.hidden/b.md")).toBe("ignored");
  expect(eligibility(".trash/old.md")).toBe("ignored");
});
test("conflict copy sits next to the original", () => {
  expect(conflictCopyPath("projects/Plan.md", "Laptop", new Date(2026, 9, 27, 10, 15)))
    .toBe("projects/Plan (conflict Laptop 2026-10-27 10-15).md");
});
test("secret ids are valid SecretStorage ids", () => {
  expect(secretId("Work Notes", "Android-7Q")).toBe("kumbu-work-notes-android-7q");
  expect(secretId("Büro", "Laptop")).toBe("kumbu-buro-laptop");
});
test("server url rule", () => {
  expect(isAllowedServerUrl("https://kumbu.tidesson.net")).toBe(true);
  expect(isAllowedServerUrl("http://localhost:8080")).toBe(true);
  expect(isAllowedServerUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isAllowedServerUrl("http://kumbu.example.org")).toBe(false);
});
test("default device name", () => {
  expect(defaultDeviceName("Android", () => 0)).toMatch(/^Android-[0-9A-HJKMNP-TV-Z]{2}$/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL, the modules don't exist.

- [ ] **Step 4: Implement `src/engine/version.ts` and `src/engine/paths.ts`**

- [ ] **Step 5: Run lint, tests and build**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: all pass; `main.js` is produced.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Set up the plugin build and add version tokens and paths"
```

---

### Task 2: The decision table

**Files:**
- Create: `src/engine/decide.ts`
- Test: `test/decide.test.ts`

**Interfaces:**
- Consumes: `Version` from Task 1.
- Produces:

```ts
export type Action =
  | { kind: "nothing" }
  | { kind: "upload"; base: Version | null }        // base null: create
  | { kind: "download" }
  | { kind: "trashLocal" }                          // remote gone, local unchanged
  | { kind: "recordBase"; version: Version }
  | { kind: "conflict" }
  | { kind: "deleteRemote"; base: Version }
  | { kind: "reupload" };                           // remote gone, local changed: create anew
export interface Sides { local: Version | null; remote: Version | null; base: Version | null; remoteDamagedPossible: boolean; }
export function decide(s: Sides): Action;
```

`local`/`remote` null means absent. `remoteDamagedPossible` is true only for a full list with `damaged > 0`.

- [ ] **Step 1: Write the failing tests**, one per row of spec §6's table:

```ts
const v = (x: string) => x.padEnd(12, "0");
test.each([
  ["same/same",                 { local: v("a"), remote: v("a"), base: v("a") }, { kind: "nothing" }],
  ["local changed",             { local: v("b"), remote: v("a"), base: v("a") }, { kind: "upload", base: v("a") }],
  ["remote changed",            { local: v("a"), remote: v("b"), base: v("a") }, { kind: "download" }],
  ["remote gone, local same",   { local: v("a"), remote: null,   base: v("a") }, { kind: "trashLocal" }],
  ["both changed, equal",       { local: v("c"), remote: v("c"), base: v("a") }, { kind: "recordBase", version: v("c") }],
  ["both changed",              { local: v("b"), remote: v("c"), base: v("a") }, { kind: "conflict" }],
  ["deleted locally",           { local: null,   remote: v("a"), base: v("a") }, { kind: "deleteRemote", base: v("a") }],
  ["deleted locally, remote changed", { local: null, remote: v("c"), base: v("a") }, { kind: "download" }],
  ["local changed, remote gone",{ local: v("b"), remote: null,   base: v("a") }, { kind: "reupload" }],
  ["new locally",               { local: v("b"), remote: null,   base: null   }, { kind: "upload", base: null }],
  ["new remotely",              { local: null,   remote: v("b"), base: null   }, { kind: "download" }],
  ["both new, equal",           { local: v("b"), remote: v("b"), base: null   }, { kind: "recordBase", version: v("b") }],
  ["both new, different",       { local: v("b"), remote: v("c"), base: null   }, { kind: "conflict" }],
  ["both gone",                 { local: null,   remote: null,   base: v("a") }, { kind: "nothing" }],
])("%s", (_, sides, action) => expect(decide({ ...sides, remoteDamagedPossible: false })).toEqual(action));

test("absence is not a deletion while the vault has damaged notes", () => {
  expect(decide({ local: v("a"), remote: null, base: v("a"), remoteDamagedPossible: true })).toEqual({ kind: "nothing" });
});
```

"Both gone" must also drop the base: the engine does that (Task 5); `decide` only says nothing is to be done remotely or locally.

- [ ] **Step 2: Run to verify failure:** `pnpm test test/decide.test.ts` → FAIL.
- [ ] **Step 3: Implement `decide`.**
- [ ] **Step 4: Run to verify pass:** `pnpm test test/decide.test.ts` → PASS.
- [ ] **Step 5: Commit:** `git commit -am "Add the sync decision table"` (with the new files added).

---

### Task 3: The API client (the only place with HTTP shapes)

**Files:**
- Create: `src/api/types.ts`, `src/api/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `RemoteApi`, `VersionsAnswer`, `PutResult`, `DeleteResult`, `MoveResult`, `AuthError`, `RejectedError`, `OfflineError` (Task 1), `toApiPath`, `fromApiPath`, `urlFor` (Task 1).
- Produces:

```ts
export interface HttpRequest { method: string; url: string; headers: Record<string, string>; body?: string; }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string; }
export type HttpFn = (r: HttpRequest) => Promise<HttpResponse>;   // throws only on network failure

export class KumbuApi implements RemoteApi {
  constructor(http: HttpFn, server: string, vault: string, key: string);
  // RemoteApi methods, plus:
  wsTicket(): Promise<string>;
  vaults(): Promise<{ name: string; canWrite: boolean }[]>;
}
export function redeemPairing(http: HttpFn, server: string, code: string, device: string): Promise<{ key: string; vault: string; keyName: string }>;
export function normalisePairingCode(input: string): string;   // uppercase, drop spaces and dashes, I/L → 1, O → 0
```

Shapes in `types.ts` (from spec §5 and `NoteApi.cs`; adjust to the server plan before starting):
- `GET /api/vaults/{vault}/versions[?since=]` with optional `If-None-Match: "<state>"` → `200 { cursor, state?, damaged, notes: [{ path, version?, deleted? }] }` or `304`. `full` is true when `since` was not sent. Paths come as `/Work/…` and are mapped with `fromApiPath`.
- `GET /api/notes/{vault}/{path}` → `NoteView { path, content, version, lastWriter, lastWriteAt, current }`; `404` → `null`.
- `PUT /api/notes/{vault}/{path}` body `{ content, version? }` → `201`/`200 NoteView`; `409 ConflictView { error, current: { content, version } }`; `400`/`413 { error }`.
- `DELETE /api/notes/{vault}/{path}?version=` → `204`; `409` with `ConflictView` (stale) or `404` (already gone: `{ ok: false, conflict: null }`).
- `POST /api/move` body `{ from, to, keepLinks: true }` (API paths) → `200 MovedView { message, path, version }`; `409` → `{ ok: false }`.
- `POST /api/ws-ticket` → `{ ticket }`. `GET /api/vaults` → `VaultView[] { name, notes, embeddings, canWrite }`.
- `POST /api/pairing/redeem` body `{ code, device }` → `{ key, vault, keyName }`; `400`/`404` → `RejectedError("This code is not valid (any more).")` with the server's sentence when it has one; `429` → `RejectedError` with the server's sentence.
- Every authorised request sends `Authorization: Bearer <key>` and `Content-Type: application/json` where there is a body. Status mapping for all: `401` → `AuthError`; `400`/`413` → `RejectedError(error)`; `5xx` and a thrown `HttpFn` → `OfflineError`.

- [ ] **Step 1: Write the failing tests** with a recording fake `HttpFn`:

```ts
test("put sends the base version and maps 409 to a conflict", async () => {
  const http = fakeHttp({ status: 409, body: { error: "changed", current: { content: "x", version: "aaaaaaaaaaaa" } } });
  const api = new KumbuApi(http, "https://k.example", "Work", "kumbu_x");
  expect(await api.put("a b.md", "text", "bbbbbbbbbbbb")).toEqual({ ok: false, conflict: { content: "x", version: "aaaaaaaaaaaa" } });
  expect(http.last).toMatchObject({ method: "PUT", url: "https://k.example/api/notes/Work/a%20b.md",
    headers: { Authorization: "Bearer kumbu_x" }, body: JSON.stringify({ content: "text", version: "bbbbbbbbbbbb" }) });
});
test("a create sends no version", …);               // body JSON has no "version" key
test("versions maps paths and deleted entries", …);   // { path:"/Work/a.md", deleted:true } → { path:"a.md", version:null }
test("versions sends If-None-Match and reads 304 as unchanged", …);
test("delete sends ?version= and maps 404 to already gone", …);
test("move always sends keepLinks true with API paths", …); // { from:"/Work/a.md", to:"/Work/b.md", keepLinks:true }
test("401 throws AuthError, 413 RejectedError with the server sentence, 503 and network errors OfflineError", …);
test("pairing code normalisation", () => {
  expect(normalisePairingCode(" k7qm-4xda ")).toBe("K7QM4XDA");
  expect(normalisePairingCode("IOLo-0000")).toBe("1010" + "0000");
});
test("redeem posts code and device without Authorization", …);
```

- [ ] **Step 2: Run to verify failure:** `pnpm test test/client.test.ts` → FAIL.
- [ ] **Step 3: Implement `types.ts` and `client.ts`.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit:** `git add -A && git commit -m "Add the Kumbu² API client"`

---

### Task 4: Conflict copies

**Files:**
- Create: `src/engine/conflict.ts`
- Test: `test/conflict.test.ts`

**Interfaces:**
- Produces: `conflictCopyText(local: string, o: { device: string; localAt: Date; remoteWriter: string; remoteAt: Date; originalPath: string }): string`

The callout (spec §7, exact copy; times `HH:mm` local):

```
> [!warning] Kumbu² conflict
> Change from **<device>** at <YYYY-MM-DD HH:mm>.
> The change from **<writer identity>** at <HH:mm> is in [[<originalPath without .md>|<title>]].
> Merge what you need, then delete this copy.

```

`<writer identity>` is `lastWriter` cut at the first `" ("` (as the server's `Writers.Identity`). The link is path-qualified. If the text starts with YAML frontmatter (`---\n` … `\n---\n` at the very start), the callout goes right after it; otherwise first.

- [ ] **Step 1: Failing tests:** callout first for plain text; callout after frontmatter with the frontmatter byte-identical; writer `"Work – Obsidian Android-7Q (edit)"` shows as `Work – Obsidian Android-7Q`; link `[[projects/Plan|Plan]]` for `projects/Plan.md`; a text starting with `---` but without a closing `---` counts as no frontmatter.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit:** `git add -A && git commit -m "Add conflict copies with a header callout"`

---

### Task 5: The sync engine in normal use

**Files:**
- Create: `src/engine/queue.ts`, `src/engine/engine.ts`, `test/fakes/fakeServer.ts`, `test/fakes/fakeFiles.ts`
- Test: `test/queue.test.ts`, `test/engine.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
// queue.ts
export class SerialQueue {
  /** Runs jobs one at a time in order. A job with a key that is already waiting (not running) is not added again. */
  push(job: () => Promise<void>, key?: string): Promise<void>;
  idle(): Promise<void>;
}

// engine.ts
export interface EngineOptions {
  vault: string; device: string; local: LocalFiles; remote: RemoteApi; state: StateStore; clock: Clock;
  onStatus(s: SyncStatus): void;
  onConflict(original: string, copy: string): void;
  onAuthLost(): void;
}
export class SyncEngine {
  constructor(o: EngineOptions);
  start(): Promise<void>;                 // load state, full check
  stop(): Promise<void>;                  // cancel debounces, wait for the queue
  localChanged(path: string): void;       // create or modify: debounced 2 s per path
  localDeleted(path: string): void;       // queued at once
  localRenamed(from: string, to: string): void;
  check(full: boolean): Promise<void>;    // hint, "Sync now", poll (false); start, visible, hourly (true)
  status(): SyncStatus;
}
// fakes
export class FakeServer implements RemoteApi { notes: Map<string, { content: string; lastWriter: string; at: string }>;
  agentWrite(path: string, content: string | null): void;   // an agent's edit or delete, stamped with the fake clock
  hold(method: keyof RemoteApi): () => void;                // pause the next call of that method; returns release
  failNext(method: keyof RemoteApi, error: Error): void; dropResponseOfNext(method: "put"): void;
  damaged: number; }
export class FakeFiles implements LocalFiles { files: Map<string, string>; userEdit(path: string, content: string): void;
  caseInsensitive: boolean; trash: string[]; }
```

Behaviour (spec §6):
- Every operation runs inside `SerialQueue`. A check enqueues with key `"check"` (full checks with `"check:full"`), so a burst of hints is one check.
- `check(full)`: `full` also when the cursor is null or older than 25 days. A full answer decides every path in the union of local `.md` files, remote entries and bases; a `since` answer decides only the paths it names. For each path: compute `local` (via `versionOf`, null if absent), take `remote` from the answer, `base` from state, `decide`, then act:
  - `upload`: skip with `too-large` if `byteSize > MAX_BYTES`; `put(path, text, base)`; on `ok` record base = returned version; on conflict: decide again with `remote` = conflict version (local = remote → record base).
  - `download`: `read`, then `writeIf(path, local, content)`; on `false` (the user typed), decide again from the new local.
  - `trashLocal`: `trashByPreference`, drop base. `reupload`: `put(path, text, null)`. `deleteRemote`: `remove(path, base)`; `ok` or already gone → drop base; conflict → decide again.
  - `conflict`: `read` the remote, write the conflict copy text as a new local file and `put` it (create), then `writeIf(path, local, remote.content)`, record base, call `onConflict`.
  - Both absent: drop base.
- Save state after every completed operation, not only at the end of a check.
- `RejectedError` → `notSynced` with `rejected` and the server's sentence; never retried until the file changes again. `OfflineError` → mode `offline`, the check ends, nothing is dropped (the next trigger retries). `AuthError` → stop syncing and call `onAuthLost`.
- Case clash: two remote paths that differ only in case when `local` is case-insensitive (detected once at start by asking `LocalFiles`; the fake has a flag) → the second in sort order is `case-clash` and not written.
- `localRenamed(from, to)`: if `from` has a base and the file at `to` still has that version, `move(from, to)`; on `ok` move the base; otherwise treat as `localDeleted(from)` plus `localChanged(to)`.
- Status: `busy` while the queue runs; `lastSyncAt` after a successful check; `notSynced` also lists attachments (`eligibility === "attachment"`) and, when `damaged > 0`, a `damaged-vault` entry.

- [ ] **Step 1: Queue tests:** jobs run strictly one after another; a keyed job waiting is not added twice; a running keyed job does not block adding a new one with the same key.
- [ ] **Step 2: Engine tests (failing)**, each against `FakeServer` and `FakeFiles` with `vi.useFakeTimers()`:
  - `uploads a local edit 2 s after the last change` (edits at 0, 1.5 s → one `put` at 3.5 s)
  - `downloads an agent edit on check` and the local file equals the server text
  - `own upload coming back causes nothing` (a `since` answer listing the uploaded version → no further call)
  - `a 409 on upload with local = remote records the base`
  - `a lost upload response is retried without a conflict` (`dropResponseOfNext("put")`)
  - `typing during a download is never overwritten` (`hold("read")`, `userEdit`, release → conflict copy only if the server also changed, else the local edit is uploaded)
  - `a local delete trashes the note on the server with the base version`; `a 409 on delete downloads the remote edit`
  - `an agent delete moves the unchanged local file to the trash`; `an agent delete of a locally edited note re-uploads it`
  - `nothing is trashed while the vault has damaged notes`
  - `a rename uses move with the base`; `a rename of an edited file is delete plus create`
  - `real conflict: server keeps the path, local text becomes a conflict copy` (copy exists on both sides, original equals the server text, `onConflict` called once)
  - Review Focus: `an NFD local path and the NFC remote path are one note`; `paths differing only in case on a case-insensitive file system: the second is not synced and nothing is overwritten`; `server failures keep the work: 503 then success uploads once, status offline in between`; `files changed while closed are uploaded on start without conflicts`
  - `a file over 1 MiB is not synced and not retried`, `a 400 is shown with the server's sentence`, `401 calls onAuthLost and stops`
- [ ] **Step 3: Run, verify failure.**
- [ ] **Step 4: Implement `queue.ts`, the fakes and `engine.ts`.**
- [ ] **Step 5: Run `pnpm test`, verify pass.**
- [ ] **Step 6: Commit:** `git add -A && git commit -m "Add the sync engine with one queue per vault"`

---

### Task 6: The first sync

**Files:**
- Create: `src/engine/firstSync.ts`
- Modify: `src/engine/engine.ts` (a `firstSync(choose)` entry point)
- Test: `test/firstSync.test.ts`

**Interfaces:**
- Consumes: `SyncEngine`, fakes (Task 5).
- Produces:

```ts
export type Choice = "both" | "local" | "kumbu";
export interface MergePlan { toUpload: string[]; toDownload: string[]; same: string[]; differing: string[]; notSynced: NotSynced[]; }
export interface FirstSyncSummary { uploaded: number; downloaded: number; unchanged: number; conflictCopies: number; notSynced: NotSynced[]; }
// on SyncEngine:
firstSync(choose: (plan: MergePlan) => Promise<Choice | null>): Promise<FirstSyncSummary | null>; // null: cancelled
```

Behaviour (spec §6 "First sync"): a full list, no bases. One side only → copy. Both, same version → record base. `differing` non-empty → `choose(plan)` once; with no differing paths `choose` is never called. `both`: the conflict path of Task 5 for each; `local`: `put(path, text, remoteVersion)`; `kumbu`: `trashToLocal(path)` then write the remote text and record the base. Bases are recorded per file as each completes, so a rerun after an interruption sees those as done (it is a normal `check(true)` from then on for paths with a base, and a first-sync pass for the rest). Cancelling the choice leaves no state saved and the plugin not connected.

- [ ] **Step 1: Failing tests:**
  - `no conflicts: choose is never called and the summary counts uploads, downloads and unchanged` (local `a.md`, `b.md`; server `b.md` equal, `c.md` → uploaded 1, downloaded 1, unchanged 1, conflictCopies 0)
  - `the plan lists 7 differing notes and asks once` (choose called exactly once with `differing.length === 7`)
  - `keep both: a conflict copy per differing note, the server text at the path`
  - `keep local: the server gets the local text with the server version as base`
  - `keep Kumbu²: the local text goes to .trash first` (`FakeFiles.trash` contains the path, the file holds the server text)
  - `attachments are counted, not synced` (`x.png` → `notSynced` with `attachment`)
  - Review Focus: `an interrupted first sync finishes on the next run without duplicates or conflict copies` (`failNext("put", new OfflineError())` after two uploads; rerun; each note exists once on each side, `conflictCopies === 0`)
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit:** `git add -A && git commit -m "Merge both sides on the first sync"`

---

### Task 7: Race tests (the first anti-goal)

**Files:**
- Modify: `test/fakes/fakeServer.ts` (a reordering mode: answers held and released in a scripted order; duplicate and lost hints)
- Test: `test/races.test.ts`

**Interfaces:**
- Consumes: `SyncEngine`, fakes.
- Produces: nothing new; fixes in `engine.ts` if a test fails.

Each test ends with the same assertion helper: `expectConverged(server, files)`: every syncable local file equals the server note at the same path, no server note is missing locally, and the number of conflict copies equals the number of real conflicts the script caused (usually 0).

- [ ] **Step 1: Write the tests** (spec §9):
  - `an upload in flight while a hint arrives` (hold `put`, `check(false)` from a hint, release)
  - `hints arriving twice and not at all` (20 checks in a burst → at most two `versions` calls; no hint → the hourly full check converges)
  - `an agent edit and a user edit of different notes at the same time`
  - `an agent edit of the note the user is typing in` (one conflict copy expected, exactly one)
  - `a rename on one side while the other edits` (user renames `a.md` → `b.md` while the agent edits `a.md`: no edit lost; both texts present)
  - `a delete racing an edit` (user deletes, agent edits: the edit comes back)
  - `the since answer arrives before a write it overlaps` (a write stamped before the cursor, committed after: found by the next `since` because of the server's overlap; the fake applies the 5-minute overlap)
  - `randomised: 200 seeded rounds of mixed user and agent operations converge with no unexpected conflict copies` (seeded PRNG, the seed printed on failure)
- [ ] **Step 2: Run:** `pnpm test test/races.test.ts`. Expected: PASS; any failure is fixed in `engine.ts` (not by loosening the assertion) and the test stays.
- [ ] **Step 3: Commit:** `git add -A && git commit -m "Test the engine against reordered and lost events"`

---

### Task 8: Live hints, polling and the hourly check

**Files:**
- Create: `src/live/hints.ts`
- Test: `test/hints.test.ts`

**Interfaces:**
- Consumes: `KumbuApi.wsTicket()` (Task 3), `SyncEngine.check` (Task 5), `Clock`.
- Produces:

```ts
export interface SocketLike { onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null; onerror: (() => void) | null; close(): void; }
export class HintConnection {
  constructor(o: { ticket: () => Promise<string>; wsUrl: (ticket: string) => string; open: (url: string) => SocketLike;
    vault: string; clock: Clock; random: () => number; check: (full: boolean) => void; onMode: (m: ConnectionMode) => void; });
  start(): void; stop(): void;
}
```

`wsUrl`: `https://host` → `wss://host/api/ws?ticket=…` (`http` → `ws`). Messages `{"type":"changed","vault":"<vault>"}` for this vault call `check(false)`; others are ignored. After every open: `check(false)`, mode `live`. Reconnect delay: `min(5 min, 1 s × 2^(n−1))` with full jitter (`random() × delay`). Three failures in a row: mode `polling`, `check(false)` every 2 min until a connection opens again. `onMode("offline")` when a ticket request throws `OfflineError`. Every hour `check(true)`, whatever the mode. `AuthError` from the ticket stops it (the engine reports it).

- [ ] **Step 1: Failing tests:** a hint for the vault triggers one check, one for another vault none; backoff delays 1, 2, 4 s … capped at 300 s (with `random = () => 1`); polling starts after the third failure and stops after a successful open; an hourly full check; `stop()` closes the socket and clears every timer.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit:** `git add -A && git commit -m "Listen for change hints with backoff and polling"`

---

### Task 9: The Obsidian adapter and plugin lifecycle

**Files:**
- Create: `src/obsidian/http.ts`, `src/obsidian/vaultFiles.ts`, `src/obsidian/secret.ts`
- Modify: `src/main.ts`
- Test: `test/http.test.ts` (the mapping of `requestUrl` results with `throw: false`; `requestUrl` stubbed through a module mock of `obsidian`)

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `obsidianHttp: HttpFn`: `requestUrl({ url, method, headers, body, contentType, throw: false })` (`RequestUrlParam.throw` defaults to `true`, so it must be `false` to read 4xx bodies); a thrown error → `OfflineError`.
  - `class VaultFiles implements LocalFiles` over `app.vault` and `app.fileManager`: `writeIf` uses `vault.process(file, data => versionOf-check …)`. Because `process` takes a synchronous callback while `versionOf` is async, compute the expected version comparison with a synchronous SHA-256 (add a small pure-TS SHA-256 in `version.ts`, tested against `versionOf`) and return the unchanged text from the callback when it differs, reporting `false`. New files with `vault.create`, folders with `vault.createFolder` as needed. `trashToLocal` → `vault.trash(file, false)` (Chris decided on `.trash`; disable `obsidianmd/prefer-file-manager-trash-file` on that line with this reason). `trashByPreference` → `fileManager.trashFile(file)` (honours the user's trash setting). `rename` → `fileManager.renameFile` is not used for remote renames (they arrive as delete plus create).
  - `secret.ts`: `secretsAvailable(app): boolean` (`app.secretStorage` exists), `readKey(app, id): string | null` (empty string counts as none), `storeKey(app, id, key)`, `forgetKey(app, id)` (`setSecret(id, "")`: `SecretStorage` has no delete in the 1.11.4 API).
  - `main.ts` (`KumbuSyncPlugin extends Plugin`): `onload` loads settings (`loadData`); if `!secretsAvailable` → `new Notice("Kumbu² Sync needs Obsidian 1.11.4 or newer.")` and no sync. If connected: build `KumbuApi`, `VaultFiles`, `SyncEngine`, `HintConnection`; `app.workspace.onLayoutReady(() => engine.start())` (so the start-up file scan doesn't fire `create` for every file); `registerEvent(vault.on("create"|"modify"|"delete"|"rename", …))` filtered by `eligibility === "sync"`; `registerDomEvent(activeDocument, "visibilitychange", …)` → `check(true)` when visible; command `sync-now` ("Sync now") → `check(false)`. `onunload` stops hints and the engine. Settings and state persist in one `data.json` object `{ settings: { server, vault, device, secretId }, state: SyncState }`, written through `saveData`.
  - `onAuthLost` → `new Notice("Kumbu² Sync: this key expired or was revoked. Pair again in the settings.")`, sync stops, settings show the not-connected view with server and device kept.

- [ ] **Step 1: Failing tests:** `obsidianHttp` passes `throw: false` and maps status, headers and text; a thrown `requestUrl` becomes `OfflineError`; the synchronous SHA-256 equals `versionOf` for ASCII, umlauts and emoji.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm lint && pnpm test && pnpm build`, verify pass.**
- [ ] **Step 5: Manual check in a scratch vault** (symlink the repo into `<vault>/.obsidian/plugins/kumbu-sync`, compose stack running, a write key made by hand in the web app; the settings UI comes in Task 10, so store the key from the developer console: `app.secretStorage.setSecret("kumbu-test-laptop", "<key>")` and set `data.json` by hand). Edit a note → it appears over the API within ~3 s; `curl -X PUT` an edit with another key → the open note changes within seconds.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "Wire the engine into Obsidian"`

---

### Task 10: Settings, pairing, the merge dialogs and the status bar

**Files:**
- Create: `src/obsidian/settingsTab.ts`, `src/obsidian/modals.ts`, `src/obsidian/statusBar.ts`
- Modify: `src/main.ts`, `styles.css`
- Test: `test/statusText.test.ts` (the pure text functions below)

**Interfaces:**
- Consumes: `redeemPairing`, `normalisePairingCode`, `KumbuApi.vaults` (Task 3), `SyncEngine.firstSync` (Task 6), `secret.ts` (Task 9).
- Produces (pure, in `statusBar.ts` and `modals.ts`, tested): `statusText(s: SyncStatus): string` → `"Kumbu² ● live · 3 not synced"`, `"Kumbu² ● polling"`, `"Kumbu² ○ offline"`; `differTitle(n: number, vault: string): string` → `"7 notes differ between this vault and Work"` (`"1 note differs …"`); `notSyncedSummary(list: NotSynced[]): string` → `"2 images, 1 PDF"` style, grouping attachments by extension (`png`/`jpg`/`jpeg`/`gif`/`webp`/`svg` → images, `pdf` → PDF, others → files), plus `too large`, `rejected`, `case clash`.

Texts copied from the approved mockup (sentence case kept):
- **Not connected** (`PluginSettingTab`; `minAppVersion` is below 1.13, so it implements `display()`): heading via `new Setting(containerEl).setHeading()` "Kumbu² Sync", description "Keeps this vault in sync with a Kumbu² vault."; settings "Server URL" (desc "https:// (or http://localhost)", validated with `isAllowedServerUrl`), "Device name" (desc "Shown in conflict copies and the key name", validated per Global Constraints), "Pairing code" (desc "From \"Connect Obsidian\" in the web app"), button **Connect**. A collapsed section "I have an API key already" with a `SecretComponent` ("API key") and, after a key is picked, a vault dropdown filled from `vaults()` with `canWrite` only (none → "This key can't write to any vault."), and **Connect**.
- **Connect** (pairing): `redeemPairing` → `storeKey(secretId(vault, device), key)` → save settings → run `firstSync` with `ConflictChoiceModal` as `choose` → `ResultModal` → start hints. Errors: the server's sentence in a `Notice`; nothing saved.
- **ConflictChoiceModal**: title `differTitle(n, vault)`; text "Same path on both sides, different text. Everything else merges by itself (<k> notes). Choose once for all <n>:"; options **Keep both (safest)** (highlighted, default) "Kumbu² keeps its version; your local text becomes a copy next to it, e.g. <first differing path as conflict copy name>", **Keep local** "Your text replaces the Kumbu² version. The old one stays in Kumbu²'s history.", **Keep Kumbu²** "The Kumbu² text replaces yours. Your local version goes to Obsidian's trash first."; buttons **Continue**, **Show the <n> notes** (opens `NotesListModal`, read-only list). Closing without Continue cancels the first sync.
- **ResultModal**: "Connected to <vault>", then "✓ Done — no conflicts" or "✓ Done — <n> conflict copies"; four counts uploaded, downloaded, unchanged, not synced; the `notSyncedSummary` line with "(Kumbu² keeps text only)" when attachments are involved; "From now on changes sync live."
- **Connected view**: server, vault, device, last sync time, mode, not-synced list with reasons, open conflict copies (paths); buttons **Sync now** and **Disconnect** (stops sync, `forgetKey`, clears `state`, keeps files; confirmation sentence "This stops syncing. Your files stay as they are.").
- **Status bar** (`addStatusBarItem`): `statusText`, updated from `onStatus`; click opens the settings.

- [ ] **Step 1: Failing tests** for `statusText`, `differTitle` (1 and 7), `notSyncedSummary` (`["a.png","b.jpg","c.pdf"]` → `"2 images, 1 PDF"`).
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement the text functions, then the tab, modals and status bar.**
- [ ] **Step 4: Run `pnpm lint && pnpm test && pnpm build`.**
- [ ] **Step 5: Manual check against a local compose stack with the server plan's pairing in place:** pair a vault that already has notes with a Kumbu² vault with some equal, some different and some new notes; the choice dialog shows the right counts; each of the three choices once (fresh vaults); the result screen; the fallback with a hand-made key; disconnect; an expired key (revoke it in the web app) → the notice. Screenshot each screen into `obisdian/` notes for the test log.
- [ ] **Step 6: Commit:** `git add -A && git commit -m "Add pairing, the merge dialogs and the status bar"`

---

### Task 11: End-to-end run against the compose stack

**Files:**
- Create: `e2e/nodeFiles.ts`, `e2e/run.ts`, `e2e/README.md`
- Modify: `package.json` (script `e2e`)

**Interfaces:**
- Consumes: `SyncEngine`, `KumbuApi`, `HintConnection` with Node's `fetch` as `HttpFn` and global `WebSocket` as `open`.
- Produces: `pnpm e2e` exits 0 on convergence, 1 with a diff otherwise.

Environment (documented in `e2e/README.md`): `KUMBU_URL` (e.g. `http://localhost:8080`), `KUMBU_VAULT` (an empty test vault), `KUMBU_DEVICE_KEY` (a pairing key or a hand-made write key), `KUMBU_AGENT_KEY` (a second write key on the same vault, standing in for the agent). The agent writes through the REST API with its own key: the same `NoteWriter` path MCP's write tools use (Claude's call, it keeps the harness free of an MCP client).

The run: a temp folder with 30 seeded notes and the vault with 30 overlapping notes; first sync with `both`; then 3 minutes of seeded random operations, the engine side through `NodeFiles` plus the engine's event methods, the agent side through `PUT`/`DELETE`/`POST /api/move`, at 2–5 operations per second; then 15 s of quiet and a full check; assert convergence as in Task 7, and that conflict copies exist only for paths both sides edited within the same 2 s window (the script records them).

- [ ] **Step 1: Write `nodeFiles.ts` and `run.ts`.**
- [ ] **Step 2: Run against a local stack** (`docker compose up -d` in kumbukumbu, keys made in the web app): `pnpm e2e`. Expected: "converged: 0 unexpected conflict copies", exit 0.
- [ ] **Step 3: Commit:** `git add -A && git commit -m "Add an end-to-end race run against a real server"`

---

### Task 12: README, release workflow and 0.1.0

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md`, `obisdian/` (a test log note `test-0.1.0.md`)

**Interfaces:**
- Consumes: everything.
- Produces: the GitHub release `0.1.0` with `main.js`, `manifest.json`, `styles.css`.

- [ ] **Step 1: Release workflow:** on push of a tag matching `[0-9]+.[0-9]+.[0-9]+`: check that the tag equals `manifest.json`'s `version` (fail otherwise), `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`, then `gh release create "$TAG" main.js manifest.json styles.css --title "$TAG" --generate-notes` with `permissions: contents: write`. BRAT installs from the latest release's assets and reads `manifest.json` from the release.
- [ ] **Step 2: README:** description; **Prerequisites**: Obsidian 1.11.4 or newer, a Kumbu² server and account, a vault there with write access; **Network use**: the plugin talks only to the Kumbu² server you enter, over HTTPS (REST and a WebSocket), and sends the text of every `.md` note outside dot folders; **Installation** with BRAT (add `SCAI-NGO/kumbu-obsidian`), then "Connect Obsidian" in the web app and the pairing code; **Usage**: what syncs and what not (attachments, dot folders, 1 MiB), conflict copies and how to resolve them, the status bar, disconnecting; **Where the key is kept**: `SecretStorage`, with what was verified per platform (check before writing; if unverified, say only that it is Obsidian's local secret storage, not `data.json`); **Development**: `pnpm install`, `pnpm dev` with a symlink into a test vault's `.obsidian/plugins/kumbu-sync`, `pnpm test`, `pnpm lint`, `pnpm e2e` (see `e2e/README.md`), releasing (bump `manifest.json`, `versions.json`, `package.json`; tag `x.y.z` without `v`); **Licence**.
- [ ] **Step 3: Verify:** `pnpm lint && pnpm test && pnpm build`; all pass.
- [ ] **Step 4: Commit and tag** once the server plan's changes are deployed on kumbu.tidesson.net: `git commit -am "Document the plugin and release it from tags"`, `git tag 0.1.0`, `git push --follow-tags`. Expected: the release workflow passes and the release lists the three assets.
- [ ] **Step 5: Install with BRAT on the laptop and the Android phone** against kumbu.tidesson.net, pair both, and walk the demo (spec §1): edit in Obsidian → Claude reads it; Claude edits → the laptop updates within seconds, the phone on opening. Write the results into `obisdian/test-0.1.0.md`.
- [ ] **Step 6: Commit the test log:** `git add obisdian && git commit -m "Log the 0.1.0 test run" && git push`.

---

## Self-review notes

- Spec coverage: §3 flow → Task 10; §4 pairing (plugin side) → Tasks 3, 10; §5 endpoints → Task 3; `since` and full-list triggers → Tasks 5, 8, 9; §6 rules 1–6 → Task 5, races → Task 7; decision table incl. remote-deleted and damaged rows → Tasks 2, 5; first sync → Task 6; not synced → Tasks 5, 10; §7 → Task 4; §8 → Tasks 1, 9, 10; §9 races → Tasks 7, 11 (isolation is the server plan's); §10 → Tasks 1, 12.
- Calls made in this plan (not in the spec): `trashByPreference` (the user's trash setting) for remote deletions, `.trash` only for "Keep Kumbu²"; disconnect overwrites the secret with an empty string because `SecretStorage` has no delete; a synchronous SHA-256 for `vault.process`; the e2e agent writes over REST with a second key instead of MCP; device names limited to 32 safe characters.

Sources for the Obsidian facts: [obsidian.d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) (`SecretStorage` and `App.secretStorage` since 1.11.4, ids "lowercase alphanumeric ID with optional dashes", no delete method; `SecretComponent` since 1.11.1 with `setValue`/`onChange` since 1.11.4; `Vault.process(file, fn)` with a synchronous `fn`; `Vault.trash(file, system)`; `FileManager.trashFile` "according to the user's preferred 'trash' options"; `RequestUrlParam.throw` defaults to `true`), [eslint-plugin-obsidianmd README](https://github.com/obsidianmd/eslint-plugin) (`configs.recommended`, rules `prefer-file-manager-trash-file`, `ui/sentence-case`, `settings-tab/require-display` below 1.13, `no-unsupported-api`), [BRAT's version picker post](https://forum.obsidian.md/t/functional-update-to-brat-version-picker-github-pre-releases-and-frozen-version-updates/98951) (BRAT reads `manifest.json` from the latest release, no `manifest-beta.json`).
