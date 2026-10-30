# Empty folders in the Obsidian plugin (0.1.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Folder markers (`<folder>/.vaultkeep`, zero bytes) sync both ways between Obsidian and Kumbu², a kept folder survives the "left empty" cleanup, and an empty folder made in Obsidian gets a marker of its own, so it reaches Kumbu² and its agents.

**Architecture:** A marker is a third kind of synced path beside notes and attachments, but it travels through the attachment ports (`readFile`/`putFile`/`removeFile`, `readBinary`/`writeBinaryIf`/`trashBinaryIf`) with one twist: its content is never looked at, so its local version is always the empty token and it is always uploaded empty. Obsidian's index has no dotfiles, so `VaultFiles` serves marker paths through `vault.adapter`, lists them by asking the disk once per folder on full scans, and the plugin forwards folder events (create, rename, delete) to three new engine methods. A refusal by a pre-marker server switches markers off for the rest of the engine's run.

**Tech Stack:** TypeScript 5, Vitest (fake timers), the `obsidian` API package (`Vault.getAllFolders`, `DataAdapter.exists/stat/readBinary/writeBinary/remove/list`), pnpm.

**Spec:** `kumbukumbu-specs/docs/superpowers/specs/2026-10-30-empty-folders-design.md`, section "Obsidian plugin (0.1.2)" (binding; read the whole spec). The server surface is fixed in `kumbukumbu-specs/docs/superpowers/plans/2026-10-30-empty-folders.md`, sections "Marker storage" and "Interface for the plugin". Plan written against `origin/master` at `52e8a38` (contains "Sync PDFs and images"); branch from there.

## Global Constraints

- British English in code, comments, docs, commit messages; UI strings in sentence case (`obsidianmd/ui/sentence-case`). `// SPDX-License-Identifier: AGPL-3.0-or-later` atop every new source file. No organisation names; examples use `Work`, `Drafts`.
- Commit messages imperative and free-form, no prefixes. pnpm only. One branch (`empty-folders`), one pull request.
- `src/engine/`, `src/api/`, `src/live/` stay free of Obsidian imports (lint enforces it).
- **Marker name:** `.vaultkeep`, matched exactly (case-sensitive) as the **last** segment, with at least one folder above it and **no dot segment** in those folders. `.vaultkeep` at the vault's root, `.VaultKeep`, and `a/.hidden/.vaultkeep` are ignored like every other dot path.
- **Marker version:** `e3b0c44298fc` (`VersionToken.Of([])`, the token of zero bytes). Marker uploads send an empty body; `kind` in `versions?attachments=1` is `"folder"`.
- Markers sync only with a server whose versions answer says `attachments: true`; on an older one they are `"ignored"` (never listed as not synced).
- **Folder settle delay: 5 s** (`FOLDER_SETTLE_MS = 5000`) between a folder's `create` event and the check "still empty, not made by the plugin"; a rename within the delay restarts it for the new name.
- A marker is never shown to the user: not in the settings' not-synced list, not in a notice.
- An older server's `400` (any `RejectedError`) on a marker is final for the engine's run: one `console.warn`, no further marker requests until the next `start()`; never a retry loop, never a listed path.
- Version 0.1.2 in `manifest.json`, `package.json`, `versions.json` (`"0.1.2": "1.11.4"`); no tag, no release.
- Checks: `pnpm test`, `pnpm lint`, `pnpm build` (CI runs all three).

## Review Focus

1. **Obsidian's "New folder" makes `Untitled` and the user names it after more than 5 s:** the marker lands in `Untitled` first; after the rename Kumbu² must hold one folder at the final name and no `Untitled`. Test in Task 4 (`an Untitled folder named after its marker leaves one folder`).
2. **A marker with content** (another tool wrote into it, or a sync tool merged two copies): it is uploaded empty, never a conflict copy, never a `400`. Test in Task 2 (`a marker with content here is sent empty and makes no conflict copy`).
3. **A folder name in NFD** (`Bespréchung` on macOS) whose marker the server lists in NFC: one marker, no upload, no second folder. Test in Task 2 (`an nfd folder's marker is the server's nfc one`).
4. **Obsidian reports a folder rename once for the folder and again for each subfolder** (it may or may not): each marker moves exactly once. Test in Task 4 (`a rename reported for the folder and its subfolder moves each marker once`).
5. **A kept folder renamed into a dot folder** (`Drafts` → `.archive/Drafts`): the marker is removed in Kumbu², nothing is uploaded. Test in Task 4 (`a kept folder moved into a dot folder loses its marker in Kumbu²`).

---

### Task 1: The marker path rule

**Files:**
- Modify: `src/engine/paths.ts` (`eligibility`, new `MARKER`, `isMarker`), `src/engine/version.ts` (new `MARKER_VERSION`)
- Test: `test/paths.test.ts`, `test/version.test.ts`

**Interfaces:**
- Produces: `export const MARKER = ".vaultkeep"`; `export function isMarker(path: string): boolean` (last segment exactly `MARKER`, at least one folder above it; says nothing about dot folders); `eligibility(path, attachments)` returns `"sync"` for a marker outside dot folders when `attachments`, `"ignored"` for it otherwise; `export const MARKER_VERSION: Version = "e3b0c44298fc"` in `version.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a folder marker syncs only on a server with attachments, and only outside dot folders", () => {
  expect(eligibility("Drafts/.vaultkeep", true)).toBe("sync");
  expect(eligibility("Work/Drafts/2026/.vaultkeep", true)).toBe("sync");
  expect(eligibility("Drafts/.vaultkeep", false)).toBe("ignored");
  for (const p of [".vaultkeep", "a/.hidden/.vaultkeep", ".obsidian/.vaultkeep", "Drafts/.VaultKeep", "Drafts/.vaultkeep.md", "Drafts/.DS_Store"]) {
    expect(eligibility(p, true)).toBe("ignored");
  }
  expect(isMarker("Drafts/.vaultkeep")).toBe(true);
  expect(isMarker(".vaultkeep")).toBe(false);
  expect(isMarker("Drafts/x.vaultkeep")).toBe(false);
});
```

In `test/version.test.ts`: `expect(await versionOfBytes(new Uint8Array(0))).toBe(MARKER_VERSION)` and `expect(MARKER_VERSION).toBe("e3b0c44298fc")`.

- [ ] **Step 2: Run** `pnpm test -- paths version` — expect FAIL (`isMarker` not exported; `Drafts/.vaultkeep` is `"ignored"`).
- [ ] **Step 3: Implement** in `paths.ts`/`version.ts`. In `eligibility`, test the marker before the dot-segment rule, on `segments.slice(0, -1)`.
- [ ] **Step 4: Run** `pnpm test` — expect PASS (the existing `"eligibility"` tests unchanged).
- [ ] **Step 5: Commit** `git commit -m "Recognise .vaultkeep folder markers in the path rules"`

### Task 2: Markers sync both ways, and kept folders survive the cleanup

**Files:**
- Modify: `src/engine/ports.ts` (`FileKind`, `LocalFiles`), `src/api/types.ts:21` (`VersionEntry.kind` adds `"folder"`), `src/engine/engine.ts` (`isFile`, `resolve`'s `kinds`, `scanLocal`, `readLocal`, `tooLargeToRead`, `status`)
- Modify: `test/fakes/fakeFiles.ts`, `test/fakes/fakeServer.ts`, `e2e/nodeFiles.ts` (the new port methods, so `tsc` passes)
- Test: `test/engine.folders.test.ts` (new), `test/client.test.ts` (one case)

**Interfaces:**
- Consumes: Task 1's `MARKER`, `isMarker`, `MARKER_VERSION`.
- Produces:
  - `FileKind = "note" | "image" | "pdf" | "folder"`.
  - `LocalFiles.listMarkers(): Promise<string[]>` — vault-relative paths of every `<folder>/.vaultkeep` on disk outside dot folders (Obsidian's `list()` has no dotfiles; `list()` keeps its contract and never returns them).
  - `LocalFiles.isEmptyFolder(path: string): Promise<boolean>` — the folder exists and holds nothing at all, dotfiles included (used by Task 4).
  - `LocalFiles.madeFolder(path: string): boolean` — true once for a folder this `LocalFiles` created itself (its `ensureFolder` for a download); asking forgets it (used by Task 4).
  - Doc comments on `stat`, `size`, `readBinary`, `writeBinaryIf`, `trashBinaryIf`: for a marker path the content is never compared; it exists or it doesn't (`writeBinaryIf(marker, null, …)` creates it if absent; with a non-null `expected` it only reports whether it exists; `trashBinaryIf(marker, …)` removes it if present).
  - Engine: a marker is decided like an attachment (`isFile` true); `readLocal` of a marker is `{ content: new ArrayBuffer(0), version: MARKER_VERSION }` when `stat` finds it, else nulls, and touches neither `hashed` nor `tooLarge`; `scanLocal(full)` adds `listMarkers()` to `list()` only when `full`; `resolve` accepts `kind: "folder"` when `answer.attachments`; `status().notSynced` never holds a marker path.
- Fakes: `FakeFiles.list()` leaves out paths with a dot segment (as Obsidian's index); `listMarkers()` returns its stored paths that `isMarker`; `isEmptyFolder` as `removeFolderIfEmpty`'s emptiness test, without deleting; `readonly madeHere = new Set<string>()` that `writeIf`/`writeBinaryIf` fill with each parent folder of a newly created path that held nothing before, and `madeFolder` consumes. `FakeServer`: `kindOf` gives `"folder"` for a marker; new `markersSupported = true` (false: `putFile`/`readFile` of a marker throw `new RejectedError("…neither a note nor a file Kumbu² keeps…")`, as the older server's 400); `putFile` of a marker with bytes throws `RejectedError("A .vaultkeep keeps its folder and holds nothing; send it empty.")`; new `agentRemoveFile(path)` (deletes and touches, as `agentWrite(path, null)` for notes). `NodeFiles`: `listMarkers` filters its walk, `isEmptyFolder` by `readdirSync`, `madeFolder` returns false.

- [ ] **Step 1: Write the failing tests** in `test/engine.folders.test.ts` (`describe("markers sync both ways")`, helpers as in `engine.attachments.test.ts`; `const EMPTY = new Uint8Array(0)`):
  - `a marker in Kumbu² makes its folder here` — `remoteFiles: { "Drafts/.vaultkeep": EMPTY }`, start: `files.binaries.get("Drafts/.vaultkeep")` equals `EMPTY`, `state.bases["Drafts/.vaultkeep"]` is `MARKER_VERSION`, `status().notSynced` is `[]`.
  - `a marker here is uploaded empty by the full check` — `files.binaries.set("Drafts/.vaultkeep", EMPTY)` before start: one `putFile` with path `"Drafts/.vaultkeep"`, base `null`, 0 bytes; base recorded.
  - `a marker with content here is sent empty and makes no conflict copy` (Review Focus 2) — local bytes `[1, 2]`, server already has the marker: no `putFile`, `conflicts` `[]`, base `MARKER_VERSION`; without the server's marker: `putFile` with 0 bytes.
  - `an nfd folder's marker is the server's nfc one` (Review Focus 3) — local `"Bespréchung/.vaultkeep"` (NFD), remote `"Bespréchung/.vaultkeep"` (NFC): no `putFile`, no write (`files.writes` 0), one base under the NFC key.
  - `other dot files stay ignored beside a marker` — local `".obsidian/app.json"`, `"Drafts/.DS_Store"`, `"Drafts/.vaultkeep"`: the only `putFile` is the marker; `notSynced` `[]`.
  - `a folder holding a marker survives the left-empty sweep` — synced `Drafts/a.md` and synced marker; `server.agentWrite("Drafts/a.md", null)`; `check(false)`: `files.removedFolders` lacks `"Drafts"`, marker still on disk.
  - `a marker removed in Kumbu² takes its empty folder with it` — synced marker only; `server.agentRemoveFile("Drafts/.vaultkeep")`; `check(false)`: marker gone, `removedFolders` contains `"Drafts"`.
  - `a marker removed in Kumbu² leaves a folder that still holds notes` — synced marker and `Drafts/a.md`: `removedFolders` lacks `"Drafts"`.
  - `a folder moved in Kumbu² moves its marker here` — synced `Old/.vaultkeep`; `server.move("Old/.vaultkeep", "New/.vaultkeep")` (as an agent; clear `calls` after): `New/.vaultkeep` on disk, `Old/.vaultkeep` gone, `removedFolders` contains `"Old"`.
  - `markers are ignored on a server without attachments` — `oldServer: true`, local marker: calls are only `versions`; `notSynced` `[]`.
  - In `test/client.test.ts`: a versions answer with `{ path: "/Work/Drafts/.vaultkeep", version: "e3b0c44298fc", kind: "folder" }` gives the entry `{ path: "Drafts/.vaultkeep", version: "e3b0c44298fc", kind: "folder" }`.
- [ ] **Step 2: Run** `pnpm test -- engine.folders client` — expect FAIL (markers ignored; fakes lack the methods).
- [ ] **Step 3: Implement** the ports, fakes and engine changes listed under Interfaces. `isFile` becomes `attachmentKind(path) !== null || isMarker(path)`; `upload` of a marker sends `readLocal`'s empty buffer.
- [ ] **Step 4: Run** `pnpm test` and `pnpm build` — expect PASS (all earlier suites too; `tsc` sees `NodeFiles` complete).
- [ ] **Step 5: Commit** `git commit -m "Sync .vaultkeep folder markers both ways"`

### Task 3: An older server's refusal is final

**Files:**
- Modify: `src/engine/engine.ts` (`syncPath`, `start`)
- Test: `test/engine.folders.test.ts` (`describe("a server without folder markers")`)

**Interfaces:**
- Consumes: Task 2's engine and `FakeServer.markersSupported`.
- Produces: private `markersRefused = false`, reset in `start()`. In `syncPath`: a marker key while `markersRefused` drops out of `dirty` and returns before any request; a `RejectedError` on a marker sets `markersRefused`, writes `console.warn("Kumbu² Sync: this server keeps no empty folders (<the error's message>); they stay in Obsidian only until the server is updated.")` the first time only, drops the key from `dirty`, and adds nothing to `rejected` (so nothing is listed and the cursor moves on).

- [ ] **Step 1: Write the failing tests**
  - `a server that refuses markers is asked once per start and lists nothing` — `server.markersSupported = false`, local `A/.vaultkeep`, `B/.vaultkeep` and `a.md`, `vi.spyOn(console, "warn")`: after start, `server.count("putFile")` 1, `a.md` on the server, `notSynced` `[]`, `state.cursor` not null, `warn` called once; `check(true)` → still 1 `putFile`, `warn` still once; `stop()` + `start()` → 2.
  - `a refused marker is never retried by the debounce` — after the refusal, `engine.localChanged("A/.vaultkeep")`, `settle(h, 2000)`: no further `putFile`.
- [ ] **Step 2: Run** `pnpm test -- engine.folders` — expect FAIL (two `putFile`s; the markers listed as rejected).
- [ ] **Step 3: Implement** as under Interfaces.
- [ ] **Step 4: Run** `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Ask a server that keeps no folder markers once per start"`

### Task 4: Folders made, renamed and deleted in Obsidian

**Files:**
- Modify: `src/engine/engine.ts` (three public methods, a timer map, `stop`)
- Test: `test/engine.folders.test.ts` (`describe("folders made in Obsidian")`, `describe("kept folders renamed and deleted here")`)

**Interfaces:**
- Consumes: Task 2's `isEmptyFolder`, `madeFolder`, `writeBinaryIf` on markers; Task 3's `markersRefused`.
- Produces:
  - `export const FOLDER_SETTLE_MS = 5000`.
  - `localFolderCreated(path: string): void` — ignored while stopped; otherwise (re)starts a `FOLDER_SETTLE_MS` timer for `keyOf(path)`. When it fires, a job on the queue writes `<path>/.vaultkeep` (empty, `writeBinaryIf(marker, null, new ArrayBuffer(0))`) and then calls `localChanged(marker)` only if all hold: not stopped, not offline, no first sync running, `supportsAttachments`, not `markersRefused`, `eligibility(marker, true) === "sync"`, `!local.madeFolder(path)`, `await local.isEmptyFolder(path)`. The job returns `false` (it says nothing about the server).
  - `localFolderRenamed(from: string, to: string): void` — a pending timer for `from` is cancelled and started afresh for `to`; then for every key in `state.bases` that `isMarker` and starts with `keyOf(from) + "/"`, `localRenamed(key, to + key.slice(keyOf(from).length))`.
  - `localFolderDeleted(path: string): void` — cancels a pending timer for it and below; for every marker key in `state.bases` under `keyOf(path) + "/"`, `localDeleted(key)`.
  - `stop()` clears the folder timers.
  - Markers created while stopped, offline or before the plugin ran are never written; the full check never looks for empty folders (spec: it can't tell them from folders that existed before the plugin).

- [ ] **Step 1: Write the failing tests** (`files.folders.add(...)` makes the empty folder on the fake disk, as the user would):
  - `an empty folder made here gets a marker after 5 s` — `localFolderCreated("Drafts")`; `settle(h, 4999)`: no `Drafts/.vaultkeep` on disk; `settle(h, 1 + 2000)`: on disk (0 bytes) and on the server.
  - `a folder that holds something by then gets none` — a note `Drafts/a.md` appears within the 5 s: no marker on disk or server.
  - `a folder the plugin made itself gets none` — `files.madeHere.add("Drafts")`: no marker; `files.madeHere` no longer has it.
  - `no marker while offline, on a server without attachments, in a dot folder, or during the first sync` — four cases: `server.failNext("versions", new OfflineError("down"))` + `check(false)` before the timer fires; `oldServer: true`; `localFolderCreated("a/.hidden")`; `harness({ start: false })` with `server.hold("versions")`, `firstSync(async () => "both")`, `localFolderCreated("Drafts")`, `settle(h, 5000)`, then release. Each: `files.writes` 0, no `putFile`.
  - `a folder renamed within the wait moves the wait to its new name` — `Untitled` created, `settle(h, 3000)`, renamed to `Drafts` (fake: folder set updated), `settle(h, 3000)`: no marker anywhere; `settle(h, 2000 + 2000)`: only `Drafts/.vaultkeep`, on disk and server.
  - `an Untitled folder named after its marker leaves one folder` (Review Focus 1) — `Untitled` gets its marker (`settle(h, 5000 + 2000)`), then the user renames the folder (fake: `userRename` of the marker) and `localFolderRenamed("Untitled", "Drafts")`: one `move` call; the server's files are exactly `["Drafts/.vaultkeep"]`.
  - `a folder deleted within the wait gets no marker` — created, `localFolderDeleted("Drafts")`: none after 7 s.
  - `stop cancels a folder's wait` — created, `stop()`, `settle(h, 7000)`: `files.writes` 0.
  - `renaming a kept folder moves its markers in Kumbu²` — synced `Old/.vaultkeep` and `Old/Sub/.vaultkeep`; fake renames both; `localFolderRenamed("Old", "New")`: `move` calls `[Old/.vaultkeep → New/.vaultkeep, Old/Sub/.vaultkeep → New/Sub/.vaultkeep]`, no `putFile`, bases under the new keys.
  - `a rename reported for the folder and its subfolder moves each marker once` (Review Focus 4) — as above, plus `localFolderRenamed("Old/Sub", "New/Sub")` right after: `server.count("move")` 2, no `removeFile`, no `putFile`.
  - `a kept folder moved into a dot folder loses its marker in Kumbu²` (Review Focus 5) — synced `Drafts/.vaultkeep`, renamed to `.archive/Drafts`: one `removeFile("Drafts/.vaultkeep", MARKER_VERSION)`, no `putFile`, no `move`.
  - `deleting a kept folder removes its marker in Kumbu²` — synced marker, `userDelete` of it, `localFolderDeleted("Drafts")`: `removeFile` with `MARKER_VERSION`; base gone.
- [ ] **Step 2: Run** `pnpm test -- engine.folders` — expect FAIL (`localFolderCreated` is not a function).
- [ ] **Step 3: Implement** as under Interfaces.
- [ ] **Step 4: Run** `pnpm test` — expect PASS; also `pnpm test -- races` stays green.
- [ ] **Step 5: Commit** `git commit -m "Keep an empty folder made in Obsidian, and carry markers through folder renames and deletes"`

### Task 5: Markers on disk through Obsidian's adapter

**Files:**
- Modify: `src/obsidian/vaultFiles.ts` (marker branches in `stat`, `size`, `readBinary`, `writeBinaryIf`, `trashBinaryIf`; new `listMarkers`, `isEmptyFolder`, `madeFolder`; `ensureFolder` records the folders it creates)
- Test: `test/vaultFiles.test.ts` (`describe("folder markers")`), `test/fakes/obsidian.ts` (a `children` field on `TFolder` if needed)

**Interfaces:**
- Consumes: Task 2's port contract; `isMarker`, `eligibility` from `paths.ts`.
- Produces: `VaultFiles` implementing it. A marker path never goes through `getFileByPath` (it is always null for a dotfile): `adapter.exists`, `adapter.stat` (`{ size, mtime }` of a `type: "file"` stat, else null), `adapter.readBinary`, `adapter.writeBinary` after `ensureFolder`, `adapter.remove` (a marker holds nothing, so it is removed rather than trashed). `listMarkers` walks `vault.getAllFolders(false)`, skips any with a dot segment, and asks `adapter.exists(`${folder.path}/${MARKER}`)` per folder. `isEmptyFolder` = folder in the index with no children and `adapter.list` empty (the test `removeFolderIfEmpty` already uses). `ensureFolder` adds each folder it creates to a private `Set` before `createFolder`; `madeFolder` deletes and returns membership.

- [ ] **Step 1: Write the failing tests** (an `adapter` over a `Map<string, Uint8Array>` of dotfiles; `getAllFolders` over a list of folder paths):
  - `listMarkers asks the disk once per folder outside dot folders` — folders `a`, `a/b`, `c`, and markers `a/.vaultkeep`, `a/b/.vaultkeep`: result `["a/.vaultkeep", "a/b/.vaultkeep"]`; `adapter.exists` called 3 times.
  - `a marker is written, read, stat'ed and removed through the adapter` — `writeBinaryIf("a/.vaultkeep", null, new ArrayBuffer(0))` true and in the map; again false; `stat` gives `size` 0; `readBinary` 0 bytes; `trashBinaryIf("a/.vaultkeep", MARKER_VERSION)` true, gone, `fileManager.trashFile` not called; again false.
  - `writing a marker makes its folders and remembers them as its own` — `writeBinaryIf("a/b/.vaultkeep", null, …)` with no folders: `createFolder` for `a` and `a/b`; `madeFolder("a/b")` true, then false; `madeFolder("x")` false.
  - `isEmptyFolder sees dot files` — folder with adapter files `["a/.DS_Store"]` false; with none true; missing folder false.
- [ ] **Step 2: Run** `pnpm test -- vaultFiles` — expect FAIL.
- [ ] **Step 3: Implement** as under Interfaces.
- [ ] **Step 4: Run** `pnpm test`, `pnpm lint` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Read and write folder markers through Obsidian's adapter"`

### Task 6: Folder events, README, and a run in Obsidian

**Files:**
- Modify: `src/main.ts:231-234` (folder events), `README.md` (Network use, What syncs, What doesn't sync)

**Interfaces:**
- Consumes: Task 4's `localFolderCreated`, `localFolderRenamed`, `localFolderDeleted`.
- Produces: in `onload`, a `TFolder` on `create` → `engine?.localFolderCreated(f.path)`, on `rename` → `engine?.localFolderRenamed(old, f.path)`, on `delete` → `engine?.localFolderDeleted(f.path)`; files keep `ifFile`. Events before `onLayoutReady` reach no engine, as today.
- README copy (adjust wording to the surrounding text, keep the facts): **What syncs** gains "Empty folders too: a folder you make in Obsidian that is still empty 5 s later reaches Kumbu², and one made in Kumbu² arrives here. Both keep a hidden, empty `.vaultkeep` file in the folder, which Obsidian doesn't show; it stays when notes arrive, so the folder stays when they go." **What doesn't sync** gains "Empty folders made while the plugin isn't running or the server can't be reached stay in Obsidian only until something is put into them; so do folders that existed before the first sync. A Kumbu² server older than 0.2.5 keeps no empty folders: the plugin asks it once per start and keeps them local." **Network use** names "the paths of the folders kept empty" among what is sent.

- [ ] **Step 1: Wire the events** in `main.ts`.
- [ ] **Step 2: Run** `pnpm lint && pnpm test && pnpm build` — expect all green.
- [ ] **Step 3: Check by hand in Obsidian** (test vault linked as in README "Development", against a server built from the server's `empty-folders` branch), and note each result in the PR description:
  1. "New folder", named within 5 s, left empty → in the web app's tree within ~10 s.
  2. "New folder", left as `Untitled` 10 s, then renamed → the web app shows only the final name.
  3. A note created in a new folder at once → no `.vaultkeep` on disk (`ls -a`).
  4. "New folder" in the web app → folder appears in Obsidian; delete its last note there → folder stays.
  5. Rename a kept folder with a kept subfolder in Obsidian → the web app shows both under the new name; record whether Obsidian sent a `rename` event per subfolder.
  6. Delete a kept folder in Obsidian with each trash setting (system trash, `.trash`, permanently) → it goes, and goes in Kumbu².
  7. Against a server without the change (0.2.x with attachments): make a folder → one warning in the developer console, no not-synced entry, no further requests on "Sync now".
- [ ] **Step 4: Commit** `git commit -m "Forward folder events to the sync engine and describe empty folders in the README"`

### Task 7: Version 0.1.2

**Files:**
- Modify: `manifest.json` (`"version": "0.1.2"`), `package.json` (`"version": "0.1.2"`), `versions.json` (add `"0.1.2": "1.11.4"`)

- [ ] **Step 1: Bump** the three files.
- [ ] **Step 2: Run** `pnpm lint && pnpm test && pnpm build` — expect green; `node -e "const m=require('./manifest.json'),p=require('./package.json'),v=require('./versions.json');if(m.version!=='0.1.2'||p.version!=='0.1.2'||v['0.1.2']!=='1.11.4')process.exit(1)"` exits 0.
- [ ] **Step 3: Commit** `git commit -m "Set the version to 0.1.2"`. No tag: the release (README "Releasing") waits for the maintainer.
