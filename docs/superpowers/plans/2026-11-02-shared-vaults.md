# Plugin 0.2.0: shared vaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plugin can sync a vault that is shared: it sends its version when pairing, tells a refusal from a revoked key on every write path, and keeps a person's device name out of conflict copies in a shared vault.

**Architecture:** `expectOk` in `src/api/client.ts` turns a 403 with a `code` into `RejectedError`, so the engine's existing `rejected` map lists the file. The engine asks `GET /api/vaults` whether its vault is shared and starts from "shared", so that not knowing fails closed; `conflictCopyPath` and `conflictCopyText` take `device: string | null`, null meaning "leave it out".

**Tech Stack:** TypeScript 5, Vitest 5 (fake timers), esbuild, ESLint, pnpm 10.28.0, Node 22. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-02-shared-vaults-design.md`. Its status line says "draft"; the maintainer has reviewed and approved it.

**Written without running anything:** the machine this plan was written on has neither node nor pnpm, so no dry run was possible and none of the tests below has been run. The baseline numbers come from CI. Where a test below doesn't behave as predicted, trust the code you see, fix the test or the step, and say so in the report.

**Line anchors** are from `5481746` and were checked there. Earlier tasks shift them, so each anchor also quotes the code.

## Global Constraints

- British English in code, comments, docs, commit messages and test names (colour, behaviour, initialise, licence as the noun).
- Commit messages imperative and free-form, no Conventional Commits prefix, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nothing committed names an organisation, customer or employer. Test data uses `Work`, `Beet`, `Alice`, `Bob`, `Laptop`, `Phone`.
- Match the surrounding code: its naming, its idiom, its sparse comments (only where the reasoning isn't obvious). New source files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- `src/engine/`, `src/api/`, `src/live/` stay free of Obsidian imports (lint enforces it). UI strings in sentence case.
- Clients branch on `code` and `type`, never on the sentence. The sentence is shown as it came.
- **Fails closed, final decision of the maintainer:** if it can't be known whether a vault is shared, the device name is left out.
- No version change. `manifest.json`, `package.json` and `versions.json` say 0.2.0 already, deliberately. No tag, no release.
- Commands as in `.github/workflows/ci.yml`: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`. `pnpm build` is `tsc --noEmit && node esbuild.config.mjs production`: it is the type check, also of `test/` and `e2e/`. Vitest doesn't type-check, so a test run alone doesn't give it.
- One file's tests: `pnpm exec vitest run test/<file>.test.ts`. One test: add `-t "<part of its name>"`.
- `pnpm lint` also covers `test/`. The test code below hasn't been linted: if a rule rejects something in it (an unused `_` in `test.each`, say), reshape the test without changing what it asserts.
- Mutations: after a task's commit, one at a time, make the change, run the named tests, watch them fail, then `git checkout -- <file>`. Report each one.

## The server's contract (copied from the Kumbu² repository, which you can't see)

Verified against `src/Kumbu.Server/Api/` and `src/Kumbu.Core/Notes/` of the server. All JSON is camelCase; a null `type` or `code` is left out of the body.

**`POST /api/pairing/redeem`** (anonymous) takes `{ "code": string, "device": string, "plugin": string }`. `plugin` is optional for the server; a shared vault needs it at `0.2.0` or later (a pre-release of 0.2.0 counts as older). Success is 201 `{ "key": string, "vault": string, "keyName": string }`. Too old, checked before the code is used up, so the code still works:

```json
HTTP 409
{ "error": "Update the Kumbu² plugin to 0.2.0 or newer to sync a shared vault.", "type": "plugin-too-old" }
```

Any other 409 on this route has no `type`: the key name is taken, and the code is used up.

**A refusal** is a 403 with a `code`, one of `read-only`, `structural`, `closing`, `owner-inactive`. The sentence starts with the command's first word, as every command error does: `write` for a note's PUT, `rm` for either DELETE, `mv` for the move, `upload` for a file's PUT. The refusal is asked before the version is looked at, so a read-only device never gets a 409 for a change.

```json
HTTP 403, a key set to read
{ "error": "write: this key can only read vault Beet", "code": "read-only" }

HTTP 403, a member's device whose role is read (Bob in the spec's example)
{ "error": "write: your role in vault Beet is read, and a key never acts above your role; only the owner can change it", "code": "read-only" }

HTTP 403, a device at write changing the board's file
{ "error": "write: Only those who may maintain *Beet* can change its board's file, Board/Board.md. This key is set to write; it takes a key with maintain.", "code": "structural" }

HTTP 403, the owner's account deactivated
{ "error": "write: vault Beet is read-only while its owner's account is deactivated", "code": "owner-inactive" }

HTTP 403, the owner deleted her account
{ "error": "write: vault Beet is read-only: its owner deleted their account, and it is closing", "code": "closing" }

HTTP 403 without a refusal (no code): keep treating it as a lost key
{ "error": "<a sentence>" }
```

`closing` and `owner-inactive` can also come from deeper in the store, with the same `code` and without the `write: ` prefix.

**`GET /api/vaults`** is open to a device key (it isn't session-only) and lists the vaults that key opens, under the caller's name for them (the name redeeming gave). `shared` is always there on a server with sharing: true for a vault shared with the caller, and for the caller's own once a membership exists that isn't revoked or left (a pending invitation counts). A server from before sharing has no such field.

```json
HTTP 200
[ { "name": "Beet", "notes": 3, "embeddings": "internal", "pending": false, "canWrite": false, "level": "read", "owner": "Alice", "shared": true,
    "members": null, "membership": "abc", "providerChanged": false, "ownerInactive": false, "closingAt": null, "ownerUsername": "alice" } ]
```

**`lastWriter`** on a note is rendered for the caller. A member sees another member as `another user` and the owner as `Alice in Obsidian` or `Alice's agent`. But a person's **own** writers are shown by their names, the device's included: the owner's other device reads `Work – Obsidian Phone`, a member's reads by the name of her key. `lastWriterKind` is null for keys, so the plugin can't tell them apart. Task 8 depends on this.

## Where this plan goes beyond the spec, and why

The spec is approved and stays as it is. These came up while checking it against the code and the server. If you find the plan wrong on one, build the safer reading and report it.

1. **§4 step 2's sentence isn't what the server sends:** see the shapes above. Nothing depends on the text; the tests use the real shapes.
2. **§2 cites `engine.ts:652` for "the server's version comes back".** That line only clears the list. What really happens: the edit and the remote change meet as `decide`'s `conflict`; `conflict()` (`engine.ts:762`) makes the copy first, overwrites the local file only through `writeIf` with the version it read, and `forgetProblems` (`:786`) clears the list. The spec's claim on local text holds, and no engine change is needed for it; Task 5 pins it. In a read-only vault the copy itself is refused, so it stays on this device, listed. If the remote side deleted the note instead, the guard at `:625` keeps the local text and sends nothing.
3. **A refused marker** would switch markers off for the whole run (`engine.ts:638`), with a warning that the server is too old. Task 4.
4. **A refused change taken back** (reverted, or a refused new note deleted) would stay listed until the next start, because `:652` only clears on outgoing actions. A read-only member will do exactly that. Task 5.
5. **`COPY_NAME` (`engine.ts:47`) doesn't match the new name**, so copies without a device would drop out of "open conflict copies" after every scan. Task 6.
6. **The per-check read leaves a window.** A local edit's 409 makes a copy in a job with no check before it (`enqueuePath`), so a vault shared since the last check would still get the device name. That gap is up to 2 minutes when polling, and up to an hour on a live socket while no change comes. Task 7 reads at the start of each check and first sync, as the spec says, and again right before a copy is named.
7. **`remoteWriter` can be a device name.** The spec keeps it because "it is someone else's name only as this member may see it". That fails when the other writer is the person's own other device (see `lastWriter` above): Laptop's copy would carry "The change from **Work – Obsidian Phone**" to every member, against §3's "must not be in either". Task 8 leaves the writer out in a shared vault. It is a task of its own so that the maintainer can drop it.
8. **The first sync's dialog** (`src/obsidian/modals.ts:31`) shows an example name with the device. Task 7 makes it show what will really happen.
9. **`README.md:15`** promises what the plugin sends and "Nothing else"; the plugin's version joins that list, so that sentence changes too (Task 9), beside the one line the spec's "Out of scope" allows.

**Not built, for the maintainer to decide (say so in the report):** "Keep local" refused in a first sync: the next check turns the file into Kumbu²'s text and moves the chosen text to a copy, so nothing is lost. Also: a refused change is not sent again until the file changes or the plugin restarts (`engine.ts:625`, the `rejected` map isn't saved). So after Alice raises Bob to write, an edit refused earlier stays listed, with the old sentence, until Bob edits it again or restarts Obsidian. Nothing is lost. The same goes for `owner-inactive` after reactivation. Copies made before a vault was shared keep their old names and text.

## Review Focus

1. **A file changed here and refused, then changed in Kumbu².** Local text survives in a copy, the file gets the server's version, the original leaves the list. Test in Task 5 (`a refused edit meets a remote change: the text survives in a copy`).
2. **A folder made in a read-only vault.** Its marker is refused; markers stay on, nothing is listed, the key stays. Test in Task 4 (`a refused marker doesn't switch markers off`).
3. **A vault shared between two checks, and a conflict from a local edit.** No device name. Test in Task 7 (`a vault shared since the last check is seen when the copy is made`).
4. **A refused change taken back.** The entry leaves the list. Test in Task 5 (`a refused edit taken back leaves the list`).
5. **A change from the person's own other device in a shared vault.** Neither device is named in the copy. Test in Task 8 (`a change from my other device names neither device in a shared vault`).

---

### Task 0: Baseline

**Files:** none changed.

- [ ] **Step 1: Set up** (budget: 15 minutes in all, likely far less)

Node 22 or newer and pnpm 10.28.0 are needed; install them if missing (`npm install -g pnpm@10.28.0`).

Run: `git status -sb && pnpm install --frozen-lockfile`
Expected: on `feature/plugin-0.2.0`; install exits 0. Note the time it took.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: exit 0.

- [ ] **Step 3: Tests**

Run: `pnpm test`
Expected, from CI run 41452071699 on `34e4ab0` (the branch adds only documents to it):

```
Test Files  18 passed (18)
     Tests  317 passed (317)
```

Per file: vaultFiles 31, engine 41, engine.attachments 42, engine.folders 29, client 37, firstSync 17, api 17, paths 14, hints 13, http 10, statusText 6, e2eRules 7, races 14, queue 5, decide 16, conflict 8, texts 4, version 6. Known failures: none. To confirm a difference on the default branch: `git worktree add ../baseline origin/master && cd ../baseline && pnpm install --frozen-lockfile && pnpm test`, and `gh run view 41452071699 --repo SCAI-NGO/kumbu-obsidian --log`.

- [ ] **Step 4: Type check and build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 5: Write down** planned against measured for the report (15 minutes, 18 files, 317 tests). No commit.

---

### Task 1: Send the version when pairing

Spec §1.

**Files:**
- Modify: `src/api/types.ts:6` (`export interface ErrorView { error: string; }`), `src/api/types.ts:67` (`export interface RedeemRequest { code: string; device: string; }`)
- Modify: `src/api/client.ts:207-223` (`redeemPairing`), `src/api/client.ts:291-294` (next to `errorOf`)
- Modify: `src/main.ts:133` (`paired = await redeemPairing(obsidianHttp, s.server, code, s.device);`)
- Test: `test/client.test.ts:204-247` (`describe("pairing")`)

**Interfaces:**
- Produces: `redeemPairing(http: HttpFn, server: string, code: string, device: string, plugin: string): Promise<RedeemView>`. `RedeemRequest` is `{ code: string; device: string; plugin: string }`. `ErrorView` is `{ error: string; code?: string; type?: string }`. In `client.ts`, `function errorField(r: HttpResponse, field: "code" | "type"): string | null`: the field if it is a non-empty string, else null.

- [ ] **Step 1: Write the failing tests** in `test/client.test.ts`. Every existing `redeemPairing(...)` call in the file (lines 211, 217, 222, 225, 230, 234, 238, 242) gains a last argument `"0.2.0"`. The body assertion at line 214 becomes `expect(jsonOf(http.last)).toEqual({ code: "K7QM4XDA", device: "Laptop", plugin: "0.2.0" });`, which is the red test for the version. Add inside `describe("pairing")`:

```ts
const TOO_OLD = "Update the Kumbu² plugin to 0.2.0 or newer to sync a shared vault.";

test("a plugin too old for a shared vault shows the server's sentence alone", async () => {
  const http = fakeHttp({ status: 409, body: { error: TOO_OLD, type: "plugin-too-old" } });
  const e = await redeemPairing(http, "https://k.example", "x", "L", "0.1.2").catch((x: unknown) => x) as RejectedError;
  expect(e).toBeInstanceOf(RejectedError);
  expect(e.message).toBe(TOO_OLD);
  expect(e.status).toBe(409);
});
test("a 409 of another type still says to change the device name", async () => {
  const p = redeemPairing(fakeHttp({ status: 409, body: { error: "Taken.", type: "other" } }), "https://k.example", "x", "L", "0.2.0");
  await expect(p).rejects.toThrow("Taken. Change the device name and make a new code in the web app.");
});
test("a plugin too old, without a sentence, still doesn't blame the device name", async () => {
  const p = redeemPairing(fakeHttp({ status: 409, body: { type: "plugin-too-old" } }), "https://k.example", "x", "L", "0.1.2");
  await expect(p).rejects.not.toThrow("device name");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/client.test.ts -t "pairing"`
Expected: FAIL: `redeem posts code and device without Authorization` (no `plugin` in the body), `a plugin too old for a shared vault shows the server's sentence alone` and `a plugin too old, without a sentence…` (both have the device-name tail). The others in the block pass.

- [ ] **Step 3: Implement.** The types and signature as under Interfaces. The body is `{ code: normalisePairingCode(code), device: device.trim(), plugin }`. In the `r.status === 409` branch, first: if `errorField(r, "type") === "plugin-too-old"`, throw `new RejectedError(errorOf(r) ?? "Update the Kumbu² plugin to sync this shared vault.", 409)`, with a one-line comment that the code still works and the device name has nothing to do with it. The existing comment and throw stay for the other 409. `src/main.ts:133` passes `this.manifest.version` as the last argument.

- [ ] **Step 4: Run to see them pass, with the type check**

Run: `pnpm exec vitest run test/client.test.ts && pnpm build`
Expected: all of `test/client.test.ts` passes (40 tests); build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/types.ts src/api/client.ts src/main.ts test/client.test.ts
git commit -m "Send the plugin's version when pairing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `client.ts`: drop `plugin` from the body. `redeem posts code and device…` fails.
  2. `client.ts`: remove the `plugin-too-old` branch. `a plugin too old for a shared vault…` fails.
  3. `client.ts`: make the branch match any `type`. `a 409 of another type…` fails.
  4. `main.ts`: drop the last argument. `pnpm build` fails with a type error (the plugin class has no unit test; the required parameter is what holds it).

---

### Task 2: A 403 with a code is a refusal, on every write path

Spec §2, the client's half.

**Files:**
- Modify: `src/api/client.ts:250-258` (`expectOk`; line 253 is `if (r.status === 401 || r.status === 403) throw new AuthError(sentence ?? "This key expired or was revoked.");`)
- Modify: `src/engine/ports.ts:23-28` (the doc comments on `AuthError` and `RejectedError`)
- Test: `test/client.test.ts` (new `describe("refusals")`, added before `describe("tickets and vaults")` at line 180)

**Interfaces:**
- Consumes: `errorField(r: HttpResponse, field: "code" | "type"): string | null` in `client.ts`, which returns the field if it is a non-empty string (added in Task 1; if it isn't there, add it next to `errorOf`).
- Produces: a 403 whose body has a non-empty string `code` throws `new RejectedError(sentence, 403)`. `RejectedError.status === 403` is how the engine tells a refusal from any other rejection. Every other 401 and 403 still throws `AuthError`.

`put`, `remove`, `move`, `putFile` and `removeFile` all reach `expectOk` for a 403 (lines 84, 97, 105, 138, 151), so one change covers them; the tests prove it per path. `revokeSelf` (`client.ts:167`, `if (r.status === 401 || r.status === 403) return;`) returns before `expectOk` and stays exactly as it is. `read`, `versions` and `wsTicket` share `expectOk`, and the server sends no refusal to them; nothing special is needed.

- [ ] **Step 1: Write the failing tests**

```ts
describe("refusals", () => {
  const writes: [string, (c: KumbuApi) => Promise<unknown>][] = [
    ["put, creating", (c) => c.put("a.md", "x", null)],
    ["put, over a version", (c) => c.put("a.md", "x", "bbbbbbbbbbbb")],
    ["remove", (c) => c.remove("a.md", "bbbbbbbbbbbb")],
    ["move", (c) => c.move("a.md", "b.md")],
    ["putFile, creating", (c) => c.putFile("a.png", new ArrayBuffer(1), null)],
    ["putFile, over a version", (c) => c.putFile("a.png", new ArrayBuffer(1), "bbbbbbbbbbbb")],
    ["removeFile", (c) => c.removeFile("a.png", "bbbbbbbbbbbb")],
  ];
  const SENTENCE = "write: this key can only read vault Work";

  test.each(writes)("%s: a 403 with a code is rejected with the server's sentence", async (_, write) => {
    const e = await write(api(fakeHttp({ status: 403, body: { error: SENTENCE, code: "read-only" } }))).catch((x: unknown) => x) as RejectedError;
    expect(e).toBeInstanceOf(RejectedError);
    expect(e.message).toBe(SENTENCE);
    expect(e.status).toBe(403);
  });
  test.each(writes)("%s: a 403 without a code means the key is lost", async (_, write) => {
    await expect(write(api(fakeHttp({ status: 403, body: { error: "No." } })))).rejects.toBeInstanceOf(AuthError);
  });
  test.each(["read-only", "structural", "closing", "owner-inactive", "a-code-from-a-newer-server"])("the code %s is a refusal", async (code) => {
    await expect(api(fakeHttp({ status: 403, body: { error: SENTENCE, code } })).put("a.md", "x", null)).rejects.toBeInstanceOf(RejectedError);
  });
  test.each([[""], [7], [null]])("a code that is no code (%j) isn't a refusal", async (code) => {
    await expect(api(fakeHttp({ status: 403, body: { error: SENTENCE, code } })).put("a.md", "x", null)).rejects.toBeInstanceOf(AuthError);
  });
  test("a 403 with a code and no sentence still has one", async () => {
    const e = await api(fakeHttp({ status: 403, body: { code: "read-only" } })).put("a.md", "x", null).catch((x: unknown) => x) as RejectedError;
    expect(e).toBeInstanceOf(RejectedError);
    expect(e.message).not.toBe("");
  });
  test("a 401 with a code stays a lost key", async () => {
    await expect(api(fakeHttp({ status: 401, body: { error: "No.", code: "read-only" } })).put("a.md", "x", null)).rejects.toBeInstanceOf(AuthError);
  });
  test("revoking this key takes any 403 as revoked, with a code or without", async () => {
    await api(fakeHttp({ status: 403, body: { error: "No." } })).revokeSelf();
    await api(fakeHttp({ status: 403, body: { error: SENTENCE, code: "read-only" } })).revokeSelf();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/client.test.ts -t "refusals"`
Expected: FAIL for `a 403 with a code is rejected…` (7 paths), `the code … is a refusal` (5) and `a 403 with a code and no sentence…`, each with an `AuthError` where `RejectedError` was expected. The rest pass already and are there to pin behaviour.

- [ ] **Step 3: Implement** in `expectOk`, before the existing 401/403 line: if `r.status === 403 && errorField(r, "code") !== null`, throw `new RejectedError(sentence ?? "The server refused this change.", 403)`. Add one comment line: a refusal in a shared vault is no revoked key, and an unknown code counts too, so that a newer server doesn't stop an older plugin's sync. In `ports.ts`: `AuthError`'s comment becomes `401, or a 403 without a refusal's code: the key expired or was revoked.`; `RejectedError`'s gains `status 403: a refusal, a 403 with a code (read-only, structural, closing, owner-inactive, or one newer than this plugin).`

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run test/client.test.ts test/api.test.ts && pnpm build`
Expected: both files pass; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts src/engine/ports.ts test/client.test.ts
git commit -m "Tell a refusal from a revoked key by its code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `expectOk`: accept only the four known codes. `the code a-code-from-a-newer-server is a refusal` fails.
  2. `expectOk`: drop `r.status === 403 &&`. `a 401 with a code stays a lost key` fails.
  3. `expectOk`: pass no status to `RejectedError`. `… a 403 with a code is rejected…` fails on `status`.
  4. `errorField`: accept any truthy value, not only strings. `a code that is no code (7)` fails.
  5. `revokeSelf`: drop `|| r.status === 403`. `revoking this key takes any 403 as revoked…` fails.

---

### Task 3: A refusal through the engine, on every write path

Spec §2, the engine's half. The engine already handles `RejectedError`, so most of this task pins behaviour: its first red comes from the fake not refusing yet, and its mutations are the real proof.

**Files:**
- Modify: `test/fakes/fakeServer.ts:228-234` (`enter`, add the refusal)
- Create: `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `new RejectedError(sentence, 403)` from `KumbuApi` for a 403 with a code, `new AuthError(...)` for one without.
- Produces: `FakeServer.refuse: ((path: string) => string | null) | null = null`. When set, `put`, `remove`, `move`, `putFile` and `removeFile` throw `new RejectedError(sentence, 403)` if it returns a sentence for their first argument, after the call is recorded in `calls`. `agentWrite`, `seed` and `seedFile` are not refused.

- [ ] **Step 1: Write the failing tests.** Create `test/engine.shared.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared vaults through the engine: what a refusal does, and conflict copies that name no device.
import { afterEach, describe, expect, test, vi } from "vitest";
import { KumbuApi, type HttpFn } from "../src/api/client";
import { SyncEngine } from "../src/engine/engine";
import { FakeFiles } from "./fakes/fakeFiles";
import { fakeClock, harness, MemoryState, settle } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const READ_ONLY = "write: this key can only read vault Work";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...rest: number[]) => new Uint8Array([...PNG, ...rest]);

describe("a refused change", () => {
  test("a refused edit is listed, and the sync goes on", async () => {
    const h = await harness({ synced: { "plan.md": "one", "b.md": "b" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().mode).not.toBe("offline");
    expect(h.engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: READ_ONLY }]);
    expect(h.files.files.get("plan.md")).toBe("mine");
    expect(h.server.notes.get("plan.md")!.content).toBe("one");
    await h.server.agentWrite("b.md", "b2");
    await h.engine.check(false);
    expect(h.files.files.get("b.md")).toBe("b2");
  });

  test("a refused edit is not sent again until the file changes", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    await h.engine.check(true);
    expect(h.server.count("put")).toBe(1);
    h.files.userEdit("plan.md", "mine again");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.server.count("put")).toBe(2);
  });

  test("a refused new note is listed", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.files.set("new.md", "mine");
    h.engine.localChanged("new.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([{ path: "new.md", reason: "rejected", detail: READ_ONLY }]);
    expect(h.authLost).toBe(0);
  });

  test("a refused trash is listed and the note stays in Kumbu²", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => "rm: this key can only read vault Work";
    h.files.userDelete("plan.md");
    h.engine.localDeleted("plan.md");
    await settle(h);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: "rm: this key can only read vault Work" }]);
    expect(h.server.notes.has("plan.md")).toBe(true);
    await h.engine.check(true);
    expect(h.server.count("remove")).toBe(1);
  });

  test("a refused move lists both names and keeps the file", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userRename("a.md", "b.md");
    h.engine.localRenamed("a.md", "b.md");
    await settle(h);
    expect(h.server.count("move")).toBe(1);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().mode).not.toBe("offline");
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["a.md", "b.md"]);
    expect(h.files.files.get("b.md")).toBe("one");
    expect(h.server.notes.get("a.md")!.content).toBe("one");
    expect(h.server.notes.has("b.md")).toBe(false);
  });

  test("a refused attachment upload is listed", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.refuse = () => "upload: this key can only read vault Work";
    h.files.binaries.set("x.png", png(2));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced).toEqual([{ path: "x.png", reason: "rejected", detail: "upload: this key can only read vault Work" }]);
    expect(h.files.binaries.get("x.png")).toEqual(png(2));
    expect(h.server.files.get("x.png")?.bytes).toEqual(png(1));
  });

  test("a refused attachment trash is listed and the file stays in Kumbu²", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.refuse = () => "rm: this key can only read vault Work";
    h.files.userDelete("x.png");
    h.engine.localDeleted("x.png");
    await settle(h);
    expect(h.authLost).toBe(0);
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["x.png"]);
    expect(h.server.files.has("x.png")).toBe(true);
  });

  test("a device at write can't change the board's file, and the rest still syncs", async () => {
    const h = await harness({ synced: { "Board/Board.md": "board", "plan.md": "one" } });
    const sentence = "write: Only those who may maintain *Work* can change its board's file, Board/Board.md. This key is set to write; it takes a key with maintain.";
    h.server.refuse = (path) => (path === "Board/Board.md" ? sentence : null);
    h.files.userEdit("Board/Board.md", "mine");
    h.engine.localChanged("Board/Board.md");
    h.files.userEdit("plan.md", "two");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([{ path: "Board/Board.md", reason: "rejected", detail: sentence }]);
    expect(h.server.notes.get("plan.md")!.content).toBe("two");
    expect(h.authLost).toBe(0);
  });

  test("keep local refused in a first sync keeps the text and finishes", async () => {
    const h = await harness({ start: false, localOnly: { "d.md": "mine" }, remoteOnly: { "d.md": "kumbu" } });
    h.server.refuse = () => READ_ONLY;
    const summary = await h.engine.firstSync(() => Promise.resolve("local"));
    expect(summary!.notSynced).toContainEqual({ path: "d.md", reason: "rejected", detail: READ_ONLY });
    expect(h.files.files.get("d.md")).toBe("mine");
    expect(h.authLost).toBe(0);
    // The next check finds no base and decides a conflict: the file becomes Kumbu²'s text, and the chosen text moves
    // to a copy. Nothing is lost, though it isn't quite what "keep local" chose; see "Not built".
    await h.engine.check(true);
    expect([...h.files.files.values()].some((text) => text.includes("mine"))).toBe(true);
    expect(h.authLost).toBe(0);
  });
});

describe("over the real client", () => {
  const sync = async (reply: { status: number; body: unknown }) => {
    const http: HttpFn = (r) => {
      if (r.method === "PUT") return Promise.resolve({ status: reply.status, headers: {}, text: JSON.stringify(reply.body) });
      const body = r.url.endsWith("/api/vaults") ? [] : { full: true, cursor: "c", state: "s", damaged: 0, attachments: true, notes: [] };
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify(body) });
    };
    const files = new FakeFiles();
    files.files.set("plan.md", "mine");
    let authLost = 0;
    const engine = new SyncEngine({
      vault: "Work", device: "Laptop", local: files, remote: new KumbuApi(http, "https://k.example", "Work", "kumbu_x"), state: new MemoryState(), clock: fakeClock,
      onStatus: () => undefined, onConflict: () => undefined, onAuthLost: () => { authLost++; },
    });
    await engine.start();
    return { engine, authLost: () => authLost };
  };

  test("a 403 with a code lists the file and keeps the key", async () => {
    const { engine, authLost } = await sync({ status: 403, body: { error: READ_ONLY, code: "read-only" } });
    expect(authLost()).toBe(0);
    expect(engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: READ_ONLY }]);
    await engine.stop();
  });

  test("a 403 without a code stops the sync as a lost key", async () => {
    const { authLost } = await sync({ status: 403, body: { error: "No." } });
    expect(authLost()).toBe(1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/engine.shared.test.ts`
Expected: FAIL in `a refused change` (the fake doesn't refuse yet, so the writes succeed and nothing is listed), except `a refused edit is not sent again until the file changes`, whose counts hold either way until the fake refuses. `over the real client` passes, as Task 2 is in: it is the end-to-end pin of the client and the engine together.

- [ ] **Step 3: Implement the fake.** In `FakeServer`, add the field under Interfaces, a module-level `const WRITES = new Set<Method>(["put", "remove", "move", "putFile", "removeFile"]);`, and in `enter`, after the failures are checked: `const sentence = WRITES.has(method) ? this.refuse?.(args[0] as string) ?? null : null; if (sentence !== null) throw new RejectedError(sentence, 403);`. The doc comment on the field says what the 403 stands for.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm exec vitest run test/engine.shared.test.ts && pnpm test && pnpm build`
Expected: all pass, one more test file than before; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add test/fakes/fakeServer.ts test/engine.shared.test.ts
git commit -m "Pin what a refusal does on every write path of the engine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `engine.ts` `syncPath`, `if (!(e instanceof RejectedError)) throw e;` (line 637): make it always throw. The `a refused…` tests fail (`offline`).
  2. `engine.ts:625`, the guard `if (outgoing && this.rejected.get(key)?.version === (local ?? "")) return;`: remove it. `a refused edit is not sent again…` and `a refused trash…` fail on the call count.
  3. `engine.ts` `localRenamed`, `if (!(e instanceof RejectedError)) throw e;` (line 236): make it always throw. `a refused move…` fails.
  4. `engine.ts` `keepLocal`, line 546: make it always throw. `keep local refused…` fails.
  5. `client.ts` `expectOk`: remove the refusal line. `a 403 with a code lists the file and keeps the key` fails with `authLost` 1.

---

### Task 4: A refused marker doesn't switch markers off

Beyond the spec's text; §2's "must hold on every write path" requires it.

**Files:**
- Modify: `src/engine/engine.ts:638` (`if (isMarker(key)) {`, in `syncPath`'s catch)
- Test: `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `RejectedError.status === 403` for a refusal; `FakeServer.refuse: ((path: string) => string | null) | null`, which throws such an error from the write methods.
- Produces: `syncPath`'s marker branch applies only when `e.status !== 403`. A refused marker goes on to the general `rejected.set` below it, which stops it being re-sent; `status()` already filters markers from `notSynced` (`engine.ts:169`), so it is never shown. A server without markers answers 400 and keeps today's behaviour.

- [ ] **Step 1: Write the failing test** in `test/engine.shared.test.ts`, which already has `READ_ONLY`, `harness` and `settle` at its top (if it doesn't exist yet, do Task 3 first). Add `import { FOLDER_SETTLE_MS } from "../src/engine/engine";` beside the other engine import:

```ts
describe("a refused folder marker", () => {
  const EMPTY = new Uint8Array(0);

  test("a refused marker doesn't switch markers off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ start: false });
    h.files.binaries.set("A/.vaultkeep", EMPTY);
    h.files.binaries.set("B/.vaultkeep", EMPTY);
    h.server.refuse = () => READ_ONLY;
    await h.engine.start();
    expect(h.server.count("putFile")).toBe(2);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(h.authLost).toBe(0);
    await h.server.seedFile("C/.vaultkeep", EMPTY);
    await h.engine.check(false);
    expect(h.files.binaries.has("C/.vaultkeep")).toBe(true);
    await h.engine.check(true);
    expect(h.server.count("putFile")).toBe(2);
    warn.mockRestore();
  });

  test("a folder made in a read-only vault stays here, unlisted", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.folders.add("Drafts");
    h.engine.localFolderCreated("Drafts");
    await settle(h, FOLDER_SETTLE_MS + 2000);
    expect(h.files.binaries.has("Drafts/.vaultkeep")).toBe(true);
    expect(h.server.files.has("Drafts/.vaultkeep")).toBe(false);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(h.authLost).toBe(0);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run test/engine.shared.test.ts -t "a refused marker"`
Expected: FAIL: `putFile` count 1 where 2 was expected, and `console.warn` called.

- [ ] **Step 3: Implement** as under Interfaces. The comment above the branch gains a clause: a refusal says nothing about what the server keeps.

- [ ] **Step 4: Run to see it pass, with the old server's tests**

Run: `pnpm exec vitest run test/engine.shared.test.ts test/engine.folders.test.ts && pnpm build`
Expected: both files pass, `a server that refuses markers is asked once per start and lists nothing` included; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/engine.shared.test.ts
git commit -m "Keep folder markers on when one is refused" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. Restore `if (isMarker(key)) {`. `a refused marker doesn't switch markers off` fails.
  2. Remove the marker branch altogether. `a server that refuses markers is asked once per start and lists nothing` in `test/engine.folders.test.ts` fails.
  3. In `status()` (`engine.ts:169`), drop the `.filter((n) => !isMarker(n.path))`. `a folder made in a read-only vault…` fails on `notSynced`.

---

### Task 5: `rejected` meets a remote change

Spec §2: "A test covers `rejected` meeting a remote change". Local text is never lost. The spec's anchor `engine.ts:652` isn't what brings the server's version back: `decide` gives `conflict`, `conflict()` (`engine.ts:762`) writes the copy first and overwrites the file through `writeIf` with the version it read, and `forgetProblems` (`:786`) clears the entry. So most of this task pins existing behaviour. Its one fix is at `:652`: a refused change taken back must leave the list.

**Files:**
- Modify: `src/engine/engine.ts:652` (`if (outgoing || this.rejected.get(key)?.version === UNEXPECTED) this.rejected.delete(key);`)
- Test: `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `FakeServer.refuse`; `FakeServer.agentWrite(path, content | null)`, `seedFile`; the test file's `READ_ONLY`, `png`, `harness`, `settle` (from Task 3).
- Produces: `syncPath` clears the entry also when `action.kind === "nothing"`: then there is nothing left of the change that was refused.

Copy names here are found by `(conflict `, not spelt out: until Task 7 they still hold the device.

- [ ] **Step 1: Write the tests** in `test/engine.shared.test.ts`:

```ts
describe("rejected meets a remote change", () => {
  const copiesOf = (paths: Iterable<string>) => [...paths].filter((p) => p.includes("(conflict "));

  /** plan.md changed here and refused, as a read-only member's edit is. */
  const refused = async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["plan.md"]);
    return h;
  };

  test("a refused edit meets a remote change: the text survives in a copy", async () => {
    const h = await refused();
    await h.server.agentWrite("plan.md", "theirs");
    await h.engine.check(false);
    const [copy, ...more] = copiesOf(h.files.files.keys());
    expect(more).toEqual([]);
    expect(h.files.files.get("plan.md")).toBe("theirs");
    expect(h.files.files.get(copy!)).toContain("mine");
    expect(h.conflicts).toEqual([["plan.md", copy]]);
    expect(h.engine.status().conflicts).toEqual([copy]);
    // The original is settled; the copy is refused in its turn, so it stays here, listed, and reaches nobody.
    expect(h.engine.status().notSynced).toEqual([{ path: copy, reason: "rejected", detail: READ_ONLY }]);
    expect(h.server.notes.has(copy!)).toBe(false);
    expect(h.authLost).toBe(0);
  });

  test("no second copy and no resend after that", async () => {
    const h = await refused();
    await h.server.agentWrite("plan.md", "theirs");
    await h.engine.check(false);
    const puts = h.server.count("put");
    await h.engine.check(true);
    await h.engine.check(false);
    expect(copiesOf(h.files.files.keys())).toHaveLength(1);
    expect(h.server.count("put")).toBe(puts);
    expect(h.files.files.get("plan.md")).toBe("theirs");
  });

  test("an edit typed after the refusal is what the copy keeps", async () => {
    const h = await refused();
    h.files.userEdit("plan.md", "mine, later");
    h.engine.localChanged("plan.md");
    await h.server.agentWrite("plan.md", "theirs");
    await h.engine.check(false);
    await settle(h, 2000);
    const [copy, ...more] = copiesOf(h.files.files.keys());
    expect(more).toEqual([]);
    expect(h.files.files.get(copy!)).toContain("mine, later");
    expect(h.files.files.get("plan.md")).toBe("theirs");
  });

  test("the same text arriving from Kumbu² settles it without a copy", async () => {
    const h = await refused();
    await h.server.agentWrite("plan.md", "mine");
    await h.engine.check(false);
    expect(copiesOf(h.files.files.keys())).toEqual([]);
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("the note deleted in Kumbu² keeps the refused text here", async () => {
    const h = await refused();
    await h.server.agentWrite("plan.md", null);
    await h.engine.check(false);
    expect(h.files.files.get("plan.md")).toBe("mine");
    expect(h.files.trash).toEqual([]);
    expect(h.server.count("put")).toBe(1);
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual(["plan.md"]);
  });

  test("a refused new note meets a note of that name in Kumbu²: the text survives in a copy", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.files.set("new.md", "mine");
    h.engine.localChanged("new.md");
    await settle(h, 2000);
    await h.server.agentWrite("new.md", "theirs");
    await h.engine.check(false);
    const [copy] = copiesOf(h.files.files.keys());
    expect(h.files.files.get("new.md")).toBe("theirs");
    expect(h.files.files.get(copy!)).toContain("mine");
  });

  test("a refused trash meets a remote change: the server's version comes back", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userDelete("plan.md");
    h.engine.localDeleted("plan.md");
    await settle(h);
    await h.server.agentWrite("plan.md", "theirs");
    await h.engine.check(false);
    expect(h.files.files.get("plan.md")).toBe("theirs");
    expect(h.engine.status().notSynced).toEqual([]);
    expect(copiesOf(h.files.files.keys())).toEqual([]);
  });

  test("a refused attachment meets a remote change: its bytes survive in a copy", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.refuse = () => READ_ONLY;
    h.files.binaries.set("x.png", png(2));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    await h.server.seedFile("x.png", png(3));
    await h.engine.check(false);
    const [copy, ...more] = copiesOf(h.files.binaries.keys());
    expect(more).toEqual([]);
    expect(h.files.binaries.get("x.png")).toEqual(png(3));
    expect(h.files.binaries.get(copy!)).toEqual(png(2));
    expect(h.server.files.has(copy!)).toBe(false);
    expect(h.engine.status().notSynced.map((n) => n.path)).toEqual([copy]);
  });

  test("a refused edit taken back leaves the list", async () => {
    const h = await refused();
    h.files.userEdit("plan.md", "one");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([]);
    expect(h.server.count("put")).toBe(1);
  });

  test("a refused new note deleted leaves the list", async () => {
    const h = await harness();
    h.server.refuse = () => READ_ONLY;
    h.files.files.set("new.md", "mine");
    h.engine.localChanged("new.md");
    await settle(h, 2000);
    h.files.userDelete("new.md");
    h.engine.localDeleted("new.md");
    await settle(h);
    expect(h.engine.status().notSynced).toEqual([]);
  });

  test("a refused trash taken back leaves the list", async () => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.refuse = () => READ_ONLY;
    h.files.userDelete("plan.md");
    h.engine.localDeleted("plan.md");
    await settle(h);
    h.files.files.set("plan.md", "one");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    expect(h.engine.status().notSynced).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see the three that must fail**

Run: `pnpm exec vitest run test/engine.shared.test.ts -t "rejected meets a remote change"`
Expected: FAIL for `a refused edit taken back leaves the list`, `a refused new note deleted leaves the list` and `a refused trash taken back leaves the list` (each still listed). The other eight pass: they pin what the engine does today. If one of those fails, local text may be at risk: stop, work out why before changing anything, and report it.

- [ ] **Step 3: Implement.** Line 652 becomes `if (outgoing || action.kind === "nothing" || this.rejected.get(key)?.version === UNEXPECTED) this.rejected.delete(key);`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test && pnpm build`
Expected: all pass, `a 400 is shown with the server's sentence…` in `test/engine.test.ts` included; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts test/engine.shared.test.ts
git commit -m "Pin a refused change meeting a remote one, and clear one taken back" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `engine.ts:652`: restore the old line. The three `… leaves the list` tests fail.
  2. `decide.ts:41`: return `{ kind: "download" }` where it returns `{ kind: "conflict" }`. `a refused edit meets a remote change…` fails: with this mutation the local text would be lost, which is what the test guards.
  3. `engine.ts` `conflict()`, the line `this.forgetProblems(key);` (786): remove it. `a refused edit meets a remote change…` fails on `notSynced`.
  4. `engine.ts` `conflictFile()`, the line `this.forgetProblems(key);` (817): remove it. `a refused attachment meets a remote change…` fails.
  5. `engine.ts:625` guard removed: `the note deleted in Kumbu² keeps the refused text here` fails on the `put` count.

---

### Task 6: A copy's name and text without a device

Spec §3, the pure functions, and the name `COPY_NAME` must still recognise.

**Files:**
- Modify: `src/engine/paths.ts:70-80` (`conflictCopyPath`, line 74: `export function conflictCopyPath(path: string, device: string, at: Date): string {`)
- Modify: `src/engine/conflict.ts:14-23` (`conflictCopyText`, line 22: `` `> Change from **${o.device}** at ${day(o.localAt)} ${time(o.localAt)}.`, ``)
- Modify: `src/engine/engine.ts:47` (`const COPY_NAME = /\(conflict .+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)( \d+)?\.[^./]+$/;`)
- Test: `test/paths.test.ts`, `test/conflict.test.ts`, `test/engine.shared.test.ts`

**Interfaces:**
- Produces: `conflictCopyPath(path: string, device: string | null, at: Date): string`. `conflictCopyText(local: string, o: { device: string | null; localAt: Date; remoteWriter: string; remoteAt: Date; originalPath: string }): string`. Null means a shared vault, or not knowing: leave the device out. The engine keeps passing `this.o.device` for now; Task 7 changes that.

- [ ] **Step 1: Write the failing tests.** In `test/paths.test.ts`:

```ts
test("a conflict copy in a shared vault names no device", () => {
  expect(conflictCopyPath("projects/Plan.md", null, new Date(2026, 9, 27, 10, 15))).toBe("projects/Plan (conflict 2026-10-27 10-15).md");
  expect(conflictCopyPath("shot.png", null, new Date(2026, 9, 27, 22, 15))).toBe("shot (conflict 2026-10-27 22-15).png");
  expect(conflictCopyPath("scans/a.b/Scan.PDF", null, new Date(2026, 9, 27, 22, 15))).toBe("scans/a.b/Scan (conflict 2026-10-27 22-15).PDF");
});
```

In `test/conflict.test.ts`:

```ts
test("in a shared vault the callout says this device", () => {
  const text = conflictCopyText("# Plan\n", { ...o, device: null });
  expect(text).toContain("> Change from **this device** at 2026-10-27 10:15.");
  expect(text).not.toContain("Laptop");
  expect(text.endsWith("# Plan\n")).toBe(true);
});
```

In `test/engine.shared.test.ts`, which already has `harness` and `png` at its top (Task 3):

```ts
describe("open conflict copies", () => {
  test("copies with and without a device are recognised after a restart", async () => {
    const h = await harness({ start: false, synced: {
      "Plan (conflict 2026-10-27 10-15).md": "a",
      "Plan (conflict 2026-10-27 10-15) 2.md": "b",
      "Old (conflict Laptop 2026-10-27 10-15).md": "c",
      "Not a copy (conflict) 2026-10-27 10-15.md": "d",
    } });
    h.files.binaries.set("shot (conflict 2026-10-27 10-15).png", png(1));
    await h.engine.start();
    expect(h.engine.status().conflicts).toEqual([
      "Old (conflict Laptop 2026-10-27 10-15).md",
      "Plan (conflict 2026-10-27 10-15) 2.md",
      "Plan (conflict 2026-10-27 10-15).md",
      "shot (conflict 2026-10-27 10-15).png",
    ]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/paths.test.ts test/conflict.test.ts test/engine.shared.test.ts -t "no device|this device|recognised"`
Expected: FAIL: `(conflict null 2026-…`, `**null**`, and `conflicts` holding only the `Old …` copy.

- [ ] **Step 3: Implement.** In `conflictCopyPath`, the name is `` `${stem} (conflict ${device === null ? "" : `${device} `}${stamp})` `` plus the extension as today; the doc comment gains the shared example. In `conflictCopyText`, the line uses `` `**${o.device ?? "this device"}**` ``. `COPY_NAME` becomes `/\(conflict (?:.+ )?\d{4}-\d{2}-\d{2} \d{2}-\d{2}\)( \d+)?\.[^./]+$/`.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test && pnpm build`
Expected: all pass; the existing `conflict copy sits next to the original` and `the callout comes first in plain text` are unchanged; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/engine/paths.ts src/engine/conflict.ts src/engine/engine.ts test/paths.test.ts test/conflict.test.ts test/engine.shared.test.ts
git commit -m "Let a conflict copy's name and text leave the device out" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `COPY_NAME`: restore the old pattern. `copies with and without a device…` fails.
  2. `conflictCopyPath`: `device ?? ""` without the conditional space. `a conflict copy in a shared vault…` fails on the double space.
  3. `conflictCopyText`: use `` `**${o.device ?? "Laptop"}**` ``. `in a shared vault the callout says this device` fails.

---

### Task 7: The engine knows whether its vault is shared

Spec §3, with the read before a copy from "Where this plan goes beyond the spec" (item 6) and the dialog (item 8).

**Files:**
- Modify: `src/api/types.ts:64` (`export interface VaultView { name: string; notes: number; embeddings: string; pending: boolean; canWrite?: boolean; }`)
- Modify: `src/engine/ports.ts:34-44` (`RemoteApi`)
- Modify: `src/api/client.ts:171-175` (`async vaults()`)
- Modify: `src/engine/engine.ts`: fields near line 95, `get attachmentsSupported` at line 139, `runCheck` line 340 (`const answer = await this.o.remote.versions(full ? null : this.state.cursor, null);`), `runFirstSync` line 474 (`const answer = await this.o.remote.versions(null, null);`), `conflict` lines 766-771, `conflictFile` line 803
- Modify: `src/obsidian/modals.ts:13` (constructor's `private readonly device: string`), `src/main.ts:185` (`new ConflictChoiceModal(this.app, plan, s.vault, s.device).choose()`)
- Modify: `e2e/run.ts:119-131` (`recording`), `test/fakes/fakeServer.ts`
- Test: `test/client.test.ts:196-201`, `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `conflictCopyPath(path, device: string | null, at)`, `conflictCopyText(local, { device: string | null, … })`, both from `src/engine/`; null leaves the device out.
- Produces:
  - `VaultView.shared?: boolean`.
  - In `ports.ts`: `export interface ListedVault { name: string; canWrite: boolean; shared?: boolean; }`, `RemoteApi.vaults(): Promise<ListedVault[]>`.
  - `KumbuApi.vaults()` maps `{ name: v.name, canWrite: v.canWrite === true, shared: v.shared }`: no judgement in the client, absent stays absent.
  - In `SyncEngine`: `private shared = true;`, public `get copyDevice(): string | null` (null while shared), `private async readShared(): Promise<void>`.
  - `FakeServer.listing: boolean | "unlisted" | "absent" | Error = false`: what `vaults()` says of `Work`; and `FakeServer.vaultsAsked = 0`. `vaults()` does **not** go through `enter`, so it isn't in `calls`: existing tests assert exact call lists (`test/engine.test.ts:75`, `test/engine.attachments.test.ts:345`, `test/engine.folders.test.ts:149`).

The default `listing = false` keeps every existing test's `(conflict Laptop …)` as it is.

- [ ] **Step 1: Write the failing tests.** In `test/client.test.ts`, after `vaults lists names and write rights`:

```ts
test("vaults hands on shared as the server says it, and absent as absent", async () => {
  const http = fakeHttp({ status: 200, body: [
    { name: "Beet", notes: 1, embeddings: "internal", pending: false, canWrite: false, level: "read", owner: "Alice", shared: true },
    { name: "Mine", notes: 1, embeddings: "internal", pending: false, canWrite: true, level: "owner", owner: null, shared: false },
    { name: "Old", notes: 1, embeddings: "internal", pending: false, canWrite: true }] });
  const [beet, mine, old] = await api(http).vaults();
  expect(beet!.shared).toBe(true);
  expect(mine!.shared).toBe(false);
  expect(old!.shared).toBeUndefined();
});
```

In `test/engine.shared.test.ts`, which already has `harness`, `settle`, `png` and `READ_ONLY` at its top (Task 3), add `import { OfflineError, AuthError } from "../src/engine/ports";`:

```ts
describe("conflict copies in a shared vault", () => {
  const COPY = "projects/Plan (conflict 2026-10-27 10-15).md";

  /** projects/Plan.md changed on both sides; the local edit's upload finds out. */
  const bothChanged = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.server.agentWrite("projects/Plan.md", "agent");
    h.files.userEdit("projects/Plan.md", "mine");
    h.engine.localChanged("projects/Plan.md");
    await settle(h, 2000);
  };

  test("in a shared vault the copy names no device, in its name or its text", async () => {
    const h = await harness({ synced: { "projects/Plan.md": "one" } });
    h.server.listing = true;
    await bothChanged(h);
    expect(h.files.files.get(COPY)).toContain("> Change from **this device** at");
    expect(h.files.files.get(COPY)).toContain("mine");
    expect(h.files.files.get(COPY)).not.toContain("Laptop");
    expect(h.server.notes.get(COPY)!.content).toBe(h.files.files.get(COPY));
    expect([...h.files.files.keys(), ...h.server.notes.keys()].join()).not.toContain("Laptop");
    expect(h.conflicts).toEqual([["projects/Plan.md", COPY]]);
    expect(h.engine.status().conflicts).toEqual([COPY]);
  });

  test("an attachment's copy in a shared vault names no device", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    h.server.listing = true;
    await h.server.seedFile("x.png", png(2));
    h.files.binaries.set("x.png", png(3));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    expect(h.files.binaries.get("x (conflict 2026-10-27 10-15).png")).toEqual(png(3));
  });

  test("the device's own vault that isn't shared: nothing changes", async () => {
    const h = await harness({ synced: { "projects/Plan.md": "one" } });
    await bothChanged(h);
    const copy = "projects/Plan (conflict Laptop 2026-10-27 10-15).md";
    expect(h.files.files.get(copy)).toContain("> Change from **Laptop** at");
  });

  test.each<[string, boolean | "unlisted" | "absent" | Error]>([
    ["the list fails offline", new OfflineError("down")],
    ["the list says the key is lost", new AuthError("revoked")],
    ["the list answers something odd", new TypeError("v.map is not a function")],
    ["the vault isn't listed", "unlisted"],
    ["the server says nothing of sharing", "absent"],
  ])("%s: it fails closed", async (_, listing) => {
    const h = await harness({ synced: { "projects/Plan.md": "one" } });
    expect(h.engine.copyDevice).toBe("Laptop");
    h.server.listing = listing;
    await bothChanged(h);
    expect(h.files.files.has(COPY)).toBe(true);
    expect(h.engine.copyDevice).toBeNull();
    expect(h.authLost).toBe(0);
    expect(h.engine.status().mode).not.toBe("offline");
  });

  test("before the server has said anything, the vault counts as shared", async () => {
    const h = await harness({ start: false });
    expect(h.engine.copyDevice).toBeNull();
  });

  test("a check asks, whether or not it finds a conflict", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    h.server.vaultsAsked = 0;
    await h.engine.check(false);
    expect(h.server.vaultsAsked).toBe(1);
    await h.engine.check(true);
    expect(h.server.vaultsAsked).toBe(2);
  });

  test("a vault shared later, or no longer shared, is seen by the next check", async () => {
    const h = await harness({ synced: { "a.md": "one" } });
    h.server.listing = true;
    await h.engine.check(false);
    expect(h.engine.copyDevice).toBeNull();
    h.server.listing = false;
    await h.engine.check(false);
    expect(h.engine.copyDevice).toBe("Laptop");
  });

  test("a vault shared since the last check is seen when the copy is made", async () => {
    const h = await harness({ synced: { "projects/Plan.md": "one" } });
    expect(h.engine.copyDevice).toBe("Laptop");
    h.server.listing = true;
    await bothChanged(h);
    expect(h.files.files.has(COPY)).toBe(true);
  });

  test("an attachment in a vault shared since the last check", async () => {
    const h = await harness({ remoteFiles: { "x.png": png(1) } });
    expect(h.engine.copyDevice).toBe("Laptop");
    h.server.listing = true;
    await h.server.seedFile("x.png", png(2));
    h.files.binaries.set("x.png", png(3));
    h.engine.localChanged("x.png");
    await settle(h, 2000);
    expect(h.files.binaries.has("x (conflict 2026-10-27 10-15).png")).toBe(true);
  });

  test("a first sync asks first, so its question and its copies name no device", async () => {
    const h = await harness({ start: false, localOnly: { "d.md": "mine" }, remoteOnly: { "d.md": "kumbu" } });
    h.server.listing = true;
    const asked: (string | null)[] = [];
    await h.engine.firstSync(() => { asked.push(h.engine.copyDevice); return Promise.resolve("both"); });
    expect(asked).toEqual([null]);
    expect(h.files.files.get("d (conflict 2026-10-27 10-15).md")).toContain("mine");
  });

  test("a first sync in an own vault still names the device", async () => {
    const h = await harness({ start: false, localOnly: { "d.md": "mine" }, remoteOnly: { "d.md": "kumbu" } });
    const asked: (string | null)[] = [];
    await h.engine.firstSync(() => { asked.push(h.engine.copyDevice); return Promise.resolve("both"); });
    expect(asked).toEqual(["Laptop"]);
    expect(h.files.files.has("d (conflict Laptop 2026-10-27 10-15).md")).toBe(true);
  });

  test("two copies in one minute both name no device and both count", async () => {
    const h = await harness({ synced: { "projects/Plan.md": "one" } });
    h.server.listing = true;
    await bothChanged(h);
    await h.server.agentWrite("projects/Plan.md", "agent again");
    h.files.userEdit("projects/Plan.md", "mine again");
    h.engine.localChanged("projects/Plan.md");
    await settle(h, 2000);
    expect(h.engine.status().conflicts).toEqual(["projects/Plan (conflict 2026-10-27 10-15) 2.md", COPY]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/client.test.ts test/engine.shared.test.ts -t "vaults hands|conflict copies in a shared vault"`
Expected: `vaults hands on shared…` fails (`shared` undefined). In `conflict copies in a shared vault`, only `the device's own vault that isn't shared: nothing changes` passes; the others fail on `(conflict Laptop …)` names, an undefined `copyDevice` or `vaultsAsked`.

- [ ] **Step 3: Implement the types, the client, the fake and e2e.** As under Interfaces. In `FakeServer`:

```ts
/** What GET /api/vaults says of Work: `shared`, "unlisted", "absent" (a server from before sharing), or it fails. */
listing: boolean | "unlisted" | "absent" | Error = false;
vaultsAsked = 0;

/** Not through enter: exact lists of calls in the tests stay about the sync's own requests. */
vaults(): Promise<ListedVault[]> {
  this.vaultsAsked++;
  if (this.listing instanceof Error) return Promise.reject(this.listing);
  if (this.listing === "unlisted") return Promise.resolve([{ name: "Other", canWrite: true, shared: false }]);
  if (this.listing === "absent") return Promise.resolve([{ name: "Work", canWrite: true }]);
  return Promise.resolve([{ name: "Work", canWrite: true, shared: this.listing }]);
}
```

In `e2e/run.ts` `recording`, add `vaults: () => api.vaults(),`.

- [ ] **Step 4: Implement the engine.** This is the security boundary, so its body is given:

```ts
/** Others reach this vault: a conflict copy syncs to them, so it names no device. So until the server says otherwise. */
private shared = true;

/** What a conflict copy may name now: null to leave the device out. */
get copyDevice(): string | null {
  return this.shared ? null : this.o.device;
}

/** Anything but a plain "not shared" counts as shared: the list failed, the vault isn't in it, the field is absent. */
private async readShared(): Promise<void> {
  try {
    const listed = (await this.o.remote.vaults()).find((v) => v.name === this.o.vault);
    this.shared = listed?.shared !== false;
  } catch {
    this.shared = true;
  }
}
```

Call `await this.readShared();`:
- in `runCheck`, right after `const answer = await this.o.remote.versions(...)`: after it, so that being offline doesn't wait for two timeouts;
- in `runFirstSync`, right after its `versions`, so the dialog's example and the copies agree;
- in `conflict()`, right after `if (note.version !== remote) return { remote: note.version };`, and in `conflictFile()`, right after `if (theirs.version !== remote) return { remote: theirs.version };`, with one comment line: a copy from a local edit's 409 comes with no check before it.

In `conflict()`, `textOf` and `conflictCopyPath` use `const device = this.copyDevice;` read once after that call, so that a copy's name and text agree, in the retry loop too. In `conflictFile()`, `conflictCopyPath(path, this.copyDevice, new Date(this.o.clock.now()))`.

`modals.ts:13`: `private readonly device: string | null`. `main.ts:185`: `new ConflictChoiceModal(this.app, plan, s.vault, engine.copyDevice).choose()`. `listVaults` in `main.ts:149` needs no change.

- [ ] **Step 5: Run to see them pass**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all pass, `test/races.test.ts` included; lint and build exit 0. `pnpm build` is what proves `e2e/run.ts` and `modals.ts` are complete.

- [ ] **Step 6: Commit**

```bash
git add src/api/types.ts src/api/client.ts src/engine/ports.ts src/engine/engine.ts src/obsidian/modals.ts src/main.ts e2e/run.ts test/fakes/fakeServer.ts test/client.test.ts test/engine.shared.test.ts
git commit -m "Leave the device out of conflict copies in a shared vault" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Mutations**, each alone
  1. `private shared = false;`: `before the server has said anything…` fails.
  2. `readShared`'s catch: `this.shared = false;`: `the list fails offline…` and its two neighbours fail.
  3. `listed?.shared !== false` → `listed?.shared === true`: `the vault isn't listed…` and `the server says nothing of sharing…` fail.
  4. `readShared`'s catch removed (rethrow): `the list says the key is lost…` fails on `authLost`.
  5. Remove the call in `runCheck`: `a check asks…` and `a vault shared later…` fail.
  6. Remove the call in `runFirstSync`: only `a first sync in an own vault` fails; `a first sync asks first…` still passes, since `shared` defaults to true and `conflict()` reads it again.
  7. Remove the call in `conflict()`: `a vault shared since the last check is seen when the copy is made` fails.
  8. Remove the call in `conflictFile()`: `an attachment in a vault shared since the last check` fails.
  9. `conflict()`: pass `this.o.device` to `conflictCopyPath`: `in a shared vault the copy names no device…` fails.
  10. `conflict()`: pass `this.o.device` to `conflictCopyText`: the same test fails on the text.
  11. `conflictFile()`: pass `this.o.device`: `an attachment's copy in a shared vault…` fails.
  12. `main.ts:185` back to `s.device`: nothing fails (the plugin class has no unit test, and the type allows both). Report this as not caught, and check the line by reading it.

---

### Task 8: No writer's name in a shared vault's copy

Beyond the spec, which says `remoteWriter` stays. Its reason doesn't hold for a person's own other device: the server renders it by its name, `lastWriterKind` is null for keys, so the plugin can't tell, and the copy reaches every member. §3's "must not be in either" decides. **Flagged to the maintainer, and a task of its own so that it can be left out.**

**Files:**
- Modify: `src/engine/conflict.ts:14-23` (`conflictCopyText`; the line `` `> The change from **${writerIdentity(o.remoteWriter)}** at ${time(o.remoteAt)} is in [[${target}|${title}]].`, ``)
- Test: `test/conflict.test.ts`, `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `conflictCopyText(local, { device: string | null, localAt, remoteWriter, remoteAt, originalPath })`, where null means a shared vault or not knowing (the engine's `copyDevice`). `FakeServer.seed(path, content, writer)` sets the writer; `FakeServer.listing = true` makes the vault shared.
- Produces: with `device === null`, the second line of the callout is `> The other change, at 10:14, is in [[projects/Plan|Plan]].`. With a device, it stays as it is. The parameter stays required: one caller, and the text depends on the case.

- [ ] **Step 1: Write the failing tests.** In `test/conflict.test.ts`, where `o` is the module's options object with `device: "Laptop"`, `remoteWriter: "Work – Obsidian Android-7Q"`:

```ts
test("in a shared vault the callout names no writer either", () => {
  expect(conflictCopyText("# Plan\n", { ...o, device: null })).toBe([
    "> [!warning] Kumbu² conflict",
    "> Change from **this device** at 2026-10-27 10:15.",
    "> The other change, at 10:14, is in [[projects/Plan|Plan]].",
    "> Merge what you need, then delete this copy.",
    "",
    "",
  ].join("\n") + "# Plan\n");
});
```

In `test/engine.shared.test.ts`, which already has `harness` and `settle` at its top (Task 3):

```ts
describe("a change from my other device", () => {
  const conflictWithPhone = async (listing: boolean) => {
    const h = await harness({ synced: { "plan.md": "one" } });
    h.server.listing = listing;
    await h.server.seed("plan.md", "from the phone", "Work – Obsidian Phone");
    h.files.userEdit("plan.md", "mine");
    h.engine.localChanged("plan.md");
    await settle(h, 2000);
    return h;
  };

  test("a change from my other device names neither device in a shared vault", async () => {
    const h = await conflictWithPhone(true);
    const text = h.files.files.get("plan (conflict 2026-10-27 10-15).md")!;
    expect(text).toContain("mine");
    expect(text).not.toContain("Phone");
    expect(text).not.toContain("Laptop");
    expect(text).toContain("> The other change, at 10:15, is in [[plan|plan]].");
  });

  test("in an own vault that isn't shared it names them as ever", async () => {
    const h = await conflictWithPhone(false);
    expect(h.files.files.get("plan (conflict Laptop 2026-10-27 10-15).md")).toContain("> The change from **Work – Obsidian Phone** at 10:15");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm exec vitest run test/conflict.test.ts test/engine.shared.test.ts -t "names no writer|other device"`
Expected: FAIL for `in a shared vault the callout names no writer either` and `a change from my other device names neither…` (the text has `**Work – Obsidian …**`). `in an own vault…` passes.

- [ ] **Step 3: Implement.** The line depends on `o.device === null`, with one comment line: the server shows a person's own other device by its name, and this copy reaches every member.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test && pnpm build`
Expected: all pass; build exits 0. In Task 7's tests `> Change from **this device**` still holds.

- [ ] **Step 5: Commit**

```bash
git add src/engine/conflict.ts test/conflict.test.ts test/engine.shared.test.ts
git commit -m "Name no writer in a shared vault's conflict copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `conflictCopyText`: always use the old line. Both failing tests fail again.
  2. `conflictCopyText`: always use the new line. `in an own vault…` and `the callout comes first in plain text` fail.

---

### Task 9: The worked example, and the README

Spec §4 as one test, and the README's line.

**Files:**
- Modify: `README.md:15`, `README.md:42` (the paragraph `**Conflict copies:** …`; the new line goes right after it)
- Test: `test/engine.shared.test.ts`

**Interfaces:**
- Consumes: `FakeServer.refuse` and `FakeServer.listing` in `test/fakes/fakeServer.ts`; `h.engine.status()`; the file's `harness` and `settle` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the test.** It is a regression test across the earlier tasks and passes at once if they are in. The vault is `Work` because the harness's is; the sentence is the server's real one for a member at `read`:

```ts
test("the spec's worked example", async () => {
  const sentence = "write: your role in vault Work is read, and a key never acts above your role; only the owner can change it";
  const h = await harness({ synced: { "plan.md": "one", "other.md": "x" } });
  h.server.listing = true;

  // Bob reads only: his edit is refused, listed, and everything else goes on.
  h.server.refuse = () => sentence;
  h.files.userEdit("plan.md", "bob");
  h.engine.localChanged("plan.md");
  await settle(h, 2000);
  expect(h.engine.status().notSynced).toEqual([{ path: "plan.md", reason: "rejected", detail: sentence }]);
  expect(h.authLost).toBe(0);
  await h.server.agentWrite("other.md", "y");
  await h.engine.check(false);
  expect(h.files.files.get("other.md")).toBe("y");

  // Alice raises him to write, and they edit plan.md at once.
  h.server.refuse = null;
  await h.server.agentWrite("plan.md", "alice");
  h.files.userEdit("plan.md", "bob again");
  h.engine.localChanged("plan.md");
  await settle(h, 2000);
  const copy = "plan (conflict 2026-10-27 10-15).md";
  expect(h.files.files.get("plan.md")).toBe("alice");
  expect(h.files.files.get(copy)).toContain("Change from **this device**");
  expect(h.files.files.get(copy)).toContain("bob again");
  expect(h.files.files.get(copy)).not.toContain("Laptop");
  expect(h.server.notes.get(copy)!.content).toBe(h.files.files.get(copy));
  expect(h.engine.status().notSynced).toEqual([]);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run test/engine.shared.test.ts -t "worked example"`
Expected: PASS. If it fails, an earlier task isn't right: go back rather than change this test.

- [ ] **Step 3: Update the README.** At line 15 the sentence on what is sent gets: `… and the device name and the plugin's version when pairing (the device name becomes the key's name in Kumbu², and conflict copies outside shared vaults carry it). Nothing else: …`. After the paragraph at line 42 add this one line (if Task 8 was left out, drop `, or the other writer`):

```markdown
**Shared vaults** need this plugin at 0.2.0 or newer, and a Kumbu² server at 0.3.0 or newer. A change the server refuses, in a vault you may only read for example, is listed as not synced with the server's sentence, and everything else keeps syncing; if the note then changes in Kumbu², your text goes to a conflict copy. A conflict copy reaches every member, so there it doesn't name your device, or the other writer: `<name> (conflict YYYY-MM-DD HH-mm).md`. When the plugin can't tell whether a vault is shared, it treats it as shared.
```

No other documentation changes.

- [ ] **Step 4: Run the checks**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all pass; lint and build exit 0.

- [ ] **Step 5: Commit**

```bash
git add README.md test/engine.shared.test.ts
git commit -m "Pin the worked example and describe shared vaults in the README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Mutations**, each alone
  1. `engine.ts` `get copyDevice`: `return this.o.device;`. `the spec's worked example` fails on `Laptop`.
  2. `engine.ts` `syncPath`: make `if (!(e instanceof RejectedError)) throw e;` always throw. It fails at the first `notSynced`.

---

### Task 10: Finish: full verification, report, draft pull request

**Files:**
- Create: `docs/superpowers/overnighter/2026-11-02-shared-vaults-report.md`

There is no `open-items.md` and no `STATUS` file in this repository: the pull request is the signal.

**Do not merge.** No tag, no release, no version change: the maintainer tags.

- [ ] **Step 1: The full verification, from a clean install**

Run: `rm -rf node_modules && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build`
Expected: install, lint and build exit 0. Tests: 19 test files passed, none failed, none skipped, and more than 317 tests. Write the exact counts in the report.

- [ ] **Step 2: Confirm nothing that must stay has moved**

Run: `git diff origin/master --stat -- manifest.json package.json versions.json pnpm-lock.yaml src/obsidian/secret.ts src/obsidian/http.ts`
Expected: empty.

Run: `rg -n 'r\.status === 401 \|\| r\.status === 403\) return' src/api/client.ts`
Expected: one hit, in `revokeSelf`.

Run: `rg -n 'this\.o\.device' src/engine/engine.ts`
Expected: only `copyDevice`.

- [ ] **Step 3: Write the report**, `docs/superpowers/overnighter/2026-11-02-shared-vaults-report.md`, with:
  - the environment (node, pnpm versions, what you installed);
  - Task 0 planned against measured (15 minutes, 18 files, 317 tests);
  - per task, the commit and the real test output;
  - every mutation individually, with the failing test's name or "not caught";
  - deviations and the calls you made, every place the plan's prediction was wrong;
  - surprises;
  - open points for Chris, first **what a person must check by hand**, as nothing here has run in Obsidian or against a real server: pairing a read-only member's device; an edit refused and listed in Settings, "Not synced"; the raised member's edit going through; the conflict copy's name and text as Alice sees them; a 0.1.2 plugin getting the sentence with its code still working; the first sync's dialog example (`src/main.ts`, not unit-tested);
  - open for the maintainer: a refused change isn't sent again after the rights change until the file changes or the plugin restarts; Task 8's departure from the spec; the extra read before a copy, which makes the per-check read redundant for naming (kept because the spec asks for it, at one request per poll or hint);
  - the PR link.

Commit it:

```bash
git add docs/superpowers/overnighter/2026-11-02-shared-vaults-report.md
git commit -m "Report on the shared vaults overnighter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feature/plugin-0.2.0
```

- [ ] **Step 4: Open a draft pull request. Do not merge it.**

Run: `gh pr create --draft --base master --head feature/plugin-0.2.0 --title "Shared vaults for plugin 0.2.0" --body-file /tmp/kumbu-plugin-pr-body.md`

The body: what changed in the spec's three parts, the departures listed in the report, what must be checked by hand, and as its very last line:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Expected: a draft PR URL. Put it into the report, commit and push. If no pull request can be opened, put `https://github.com/SCAI-NGO/kumbu-obsidian/compare/master...feature/plugin-0.2.0` in the report instead.

- [ ] **Step 5: Check CI** on the pull request: `gh pr checks --watch`. Expected: `check` passes. If it fails, fix on the branch and push; never merge. If `gh` isn't available, write "CI unchecked" in the report.
