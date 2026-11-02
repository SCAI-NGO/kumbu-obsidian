# Overnighter report: shared vaults in the plugin

Date: 2026-11-02. Branch: `feature/plugin-0.2.0`. The same commits are also on `claude/shared-vaults-overnighter-1t3x88`, the branch this cloud session was told to push to. Pull request: see the end.

All ten tasks are done. Every task had its own red and green runs, mutations, and a review covering spec compliance and code quality. A final review of the whole branch followed. Nothing is merged, tagged or released, and the version is unchanged.

## Environment

- A Claude Code cloud container, Linux, 4 CPUs.
- node v22.23.4 and pnpm 10.28.0 were already installed. **Nothing was installed.**
- The work was subagent-driven, using the superpowers skills. Each task had a fresh implementer subagent, then a separate reviewer subagent for spec and quality. The controller pushed after every task.

## Task 0: planned against measured

| | Planned | Measured |
|---|---|---|
| Time | 15 minutes | about 30 s (install 5.9 s, then lint, test and build) |
| Test files | 18 | 18 passed |
| Tests | 317 | 317 passed |
| `pnpm lint` / `pnpm build` | exit 0 | exit 0 / exit 0 |

## Per task

Mutations were applied one at a time and restored with `git checkout -- <file>`. Every one was caught except where this table says "not caught".

| Task | Commit | Red (measured) | Green (measured) | Mutations |
|---|---|---|---|---|
| 1 Version when pairing | `d90dba0` Send the plugin's version when pairing | 3 failed, 8 passed: exactly the 3 predicted | `client.test.ts` 40 passed. Full suite: 18 files, 320 tests; lint 0; build 0 | 1. `plugin` dropped from the body: caught by `redeem posts code and device without Authorization`. 2. `plugin-too-old` branch removed: caught by `a plugin too old for a shared vault…`, and also by `…without a sentence…`. 3. Branch matches any `type`: caught by `a 409 of another type…`. 4. `main.ts` argument dropped: caught by `pnpm build` (TS2554). |
| 2 403 with a code is a refusal | `02dc798` Tell a refusal from a revoked key by its code | 13 failed, 12 passed, as predicted (7 paths, 5 codes, "no sentence") | client and api tests: 82 passed. Full suite: 345 passed; lint 0; build 0 | 1. Only the four known codes accepted: caught by `the code a-code-from-a-newer-server is a refusal`. 2. `r.status === 403 &&` dropped: caught by `a 401 with a code stays a lost key`. 3. No status on `RejectedError`: caught by all 7 `…a 403 with a code is rejected…` tests. 4. `errorField` accepts any truthy value: caught by `a code that is no code (7)…`. 5. `revokeSelf` without `\|\| 403`: caught by `revoking this key takes any 403 as revoked…`. |
| 3 Refusal through the engine | `3e61a20` Pin what a refusal does on every write path of the engine | 8 failed, 3 passed, as predicted | New file: 11 passed. Full suite: 19 files, 356 tests | 1. The `syncPath` catch always throws: 9 failed (`offline`), one more than the brief names. 2. Guard at `:625` removed: caught by `not sent again…` and `a refused trash…`. 3. `localRenamed` always throws: caught by `a refused move…`. 4. `keepLocal` always throws: caught by `keep local refused…`. 5. The refusal line in `expectOk` removed: caught by `a 403 with a code lists the file and keeps the key` (`authLost` 1). |
| 4 Refused marker | `aca0376` Keep folder markers on when one is refused | 1 failed on the `putFile` count (1 where 2 was expected). The `warn` assertion was never reached | shared and folders tests: 42 passed. Full suite: 358 passed | 1. Old `if (isMarker(key))`: caught by `a refused marker doesn't switch markers off`. 2. Marker branch removed: caught by `a server that refuses markers is asked once…` and 2 more folder tests. 3. `status()` filter dropped: caught by both new tests. |
| 5 `rejected` meets a remote change | `bf54477` Pin a refused change meeting a remote one, and clear one taken back | 3 failed, 8 passed: exactly the three `… leaves the list` tests. **The eight local-text pins passed before any change.** | Full suite: 369 passed | 1. Old line `:652`: caught by the three `… leaves the list` tests. 2. `decide` returns `download` for `conflict`: caught by `a refused edit meets a remote change…` and 3 more (the text-loss guard). 3. `forgetProblems` removed in `conflict()`: caught by `a refused edit meets…`. 4. The same in `conflictFile()`: caught by `a refused attachment meets…`. 5. Guard at `:625` removed: caught by `the note deleted in Kumbu² keeps…` and `no second copy…`. |
| 6 Name and text without a device | `1e935a9` Let a conflict copy's name and text leave the device out | 3 failed, as predicted (`(conflict null …`, `**null**`, `Old …` only) | Full suite: 372 passed; lint 0; build 0 | 1. Old `COPY_NAME`: caught by `copies with and without a device…`. 2. Space not made conditional: caught by `a conflict copy in a shared vault…` (double space). 3. `?? "Laptop"`: caught by `in a shared vault the callout says this device`. |
| 7 The engine knows shared | `3540feb` Leave the device out of conflict copies in a shared vault; fix round `90d1abe` Name a copy by its own answer on sharing | Failed as predicted: only `the device's own vault that isn't shared` passed | Full suite: 389 passed; lint 0; build 0 | 1. `shared = false`: caught by `before the server has said anything…`. 2. The catch sets false: caught by the 3 error cases in `fails closed`. 3. `=== true`: caught by `vault isn't listed` and `says nothing of sharing`. 4. Catch removed: caught by the 3 error cases, on the copy assertion (see Deviations). 5. Call in `runCheck` removed: 9 failed. 6. Call in `runFirstSync` removed: caught only by `a first sync in an own vault`, as predicted. 7. Call in `conflict()` removed: 8 failed. 8. Call in `conflictFile()` removed: 2 failed. 9–11. `this.o.device` passed: caught (9, 1 and 2 tests). **12. `main.ts:185` back to `s.device`: not caught**, as predicted; read back by hand, the committed line is `engine.copyDevice`. Fix-round mutation, `conflict()` going back to `this.copyDevice`: **not caught**. The race it guards against can't happen today (see Calls). |
| 8 No writer's name | `b30bfe6` Name no writer in a shared vault's conflict copy | 2 failed, 1 passed, as predicted | Full suite: 392 passed; lint 0; build 0 | 1. Always the old line: caught by both shared tests. 2. Always the new line: 8 failed, among them `in an own vault…` and `the callout comes first in plain text`. |
| 9 Worked example, README | `29a08d9` Pin the worked example and describe shared vaults in the README | Passed at once, as predicted | Full suite: 393 passed; lint 0; build 0 | 1. `copyDevice` returns `this.o.device`: **the worked example doesn't catch it** since the Task 7 fix round, because copies no longer read `copyDevice`. 8 other tests catch it. A substitute mutation in `conflict()` (`const device = this.o.device`) is caught by the worked example. 2. The `syncPath` catch always throws (`engine.ts:662`): caught at the first `notSynced`, 25 failed in all. |
| Final review fixes | `7a6f3d6` Tidy the shared vault tests after review | | Full suite: 393 passed; lint 0; build 0 | |

**Final verification** (Task 10, step 1), from `rm -rf node_modules`: `pnpm install --frozen-lockfile` passed, `pnpm lint` exit 0, `Test Files 19 passed (19)`, `Tests 393 passed (393)`, none failed or skipped, `pnpm build` exit 0.

**Step 2 checks:**
- `git diff origin/master --stat -- manifest.json package.json versions.json pnpm-lock.yaml src/obsidian/secret.ts src/obsidian/http.ts` is empty.
- `r.status === 401 || r.status === 403) return` appears once, in `revokeSelf` (`client.ts:167`).
- `this.o.device` in `engine.ts` appears at `copyDevice` (`:147`) and in the two lines that name a copy from their own answer (`:793`, `:832`). It is no longer *only* `copyDevice`, because of the Task 7 fix round described under Calls.

## Deviations, and where the plan's predictions were wrong

Almost all of the plan's test code ran unchanged, and no test helper needed adapting. Its red predictions held for every task. The differences:

- **Task 4 red:** the test failed on the `putFile` count before reaching the `console.warn` assertion. The plan predicted both.
- **Task 7 mutation 4:** this fails on the earlier `files.has(COPY)` assertion, not on `authLost`, because `conflict()` throws before making a copy. A temporary probe showed that `authLost` (1 for `AuthError`) and `mode` (`offline`) would fail too, and that local text was kept in all three cases.
- **Many mutations fail more tests than predicted** (Task 1.2, 3.1, 4.2, 4.3, 5.2, 5.5, 7.5, 7.7–7.11, 8.2). That makes the suite stronger, not weaker.
- **Task 9 mutation 1** no longer reaches the worked example (see the table and Calls).
- **Task 9 mutation 2:** the plan's "`syncPath`, `if (!(e instanceof RejectedError)) throw e;`" matches two lines. The one in `syncPath` is now at `:662`; the one at `:571` is in the upload helper.
- **Line anchors** drifted by about a line after Task 4. The implementers found the lines by the quoted code.

## Calls I made

- **Branch.** This cloud session was told to push to `claude/shared-vaults-overnighter-1t3x88`, while the brief says `feature/plugin-0.2.0`. Both started at `7af32c5`. Every task was pushed to both with the same commits, and the pull request is from `feature/plugin-0.2.0`, as the brief asks. If wrong, the cost is one extra branch on the remote, which can be deleted.
- **Task 7 fix round (beyond the plan):** each copy is named by its own answer on sharing.
  - The Task 7 review found that `conflict()` and `conflictFile()` read the `shared` field after their own `readShared()`. A slower, older answer could in principle overwrite a newer one in between.
  - `readShared()` now returns its own answer, and both use that. The field still feeds `copyDevice`, which the dialog uses.
  - The re-review confirmed that `SerialQueue` runs every check, path job and first sync one at a time. So the race can't happen today, and no test can catch the mutation without going around the queue.
  - I kept the change as a defensive measure on the security boundary. If wrong, the cost is one small commit.
- **Final review fixes** (`7a6f3d6`, tests and a comment only):
  - The keep-local test's comment no longer points to the plan's "Not built" section.
  - `vi.restoreAllMocks()` was added in `afterEach`, so a failing marker test can't leave `console.warn` mocked.
  - One test now asserts exactly one copy.
  - The doc comment on `shared` was reworded.
- **The races flake was left alone on this branch.** It is a test-harness problem from before tonight (see Surprises). Its fix belongs to the fakes, not to shared vaults.

## Surprises

**`test/races.test.ts > randomised: concurrent rounds of user and agent edits never lose an edit` sometimes fails, and it did so before tonight's work.** Under parallel load (8 vitest processes on 4 CPUs) it fails about 1 run in 100 to 300:

```
no-loss run failed in round 99 with RACE_SEED=20261028 after user renames d.md to a.md, agent writes d.md, user edits e.md, user edits a.md: lost «user 99.3»
```

The brief says a sign of lost local text means stop and work out why, so it got its own investigation in separate worktrees. The verdict is **a test-harness artifact, not an engine bug**:

- **Counts under the same load, both commits interleaved:**
  - HEAD `3540feb` failed 1/280 and `7af32c5` (before tonight) failed 0/280. At this rate the difference means nothing.
  - With every `crypto.subtle.digest` made 0–3 ms slower, as on a busy machine, HEAD failed 10/150 and `7af32c5` failed 6/150, by the same mechanism.
- **Cause, first gap:**
  - `FakeFiles.writeIf` checks the version with an *awaited* real digest, then writes.
  - Vitest's fake-timer ticks let the test's next step ("user edits a.md") run during that await. The rename's download of the agent's text then lands over «user 99.3» without a conflict copy.
  - The real `VaultFiles.writeIf` checks and writes in one step inside `Vault.process`. It would refuse, and the engine would make a conflict copy. So the engine is correct as long as `LocalFiles.writeIf` stays atomic, as its port contract promises.
- **Cause, second gap:** `FakeServer.put` has the same gap between its base check and its store. That one loses *agent* edits (rounds 26 and 124) and is the more frequent failure under jitter.
- **Proposed fix, test files only and not applied:**
  - Use `versionOfSync` in `FakeFiles.writeIf`.
  - Hash before the base check in `FakeServer.put`, so that check and store are one step.
  - With both fixes: 0/150 failures under jitter, 240/240 passes under load, and the full suite and eslint pass.
  - It is a separate small commit for Chris to decide on. The diff:

```diff
--- a/test/fakes/fakeFiles.ts
-import { versionOf, versionOfBytes, versionOfSync } from "../../src/engine/version";
+import { versionOfBytes, versionOfSync } from "../../src/engine/version";
   async writeIf(path: string, expected: Version | null, content: string): Promise<boolean> {
     const p = this.existing(path);
-    const now = p === undefined ? null : await versionOf(this.editors.get(p) ?? this.textOf(p));
+    // Checked and written in one synchronous step, as VaultFiles does inside Vault.process: no edit can come between.
+    const now = p === undefined ? null : versionOfSync(this.editors.get(p) ?? this.textOf(p));
     if (now !== expected) return false;
--- a/test/fakes/fakeServer.ts
   async put(path: string, content: string, base: Version | null): Promise<PutResult> {
     await this.enter("put", [path, content, base]);
+    // Hashed first, so the check and the store are one step, as in the server's transaction: no agent write between.
+    const text = normaliseText(content);
+    const version = await versionOf(text);
     const existing = this.notes.get(path);
     if (existing && existing.version !== base) return { ok: false, conflict: { content: existing.content, version: existing.version } };
-    await this.store(path, content, this.deviceWriter);
-    return this.leave("put", { ok: true, version: this.notes.get(path)!.version });
+    this.notes.set(path, { content: text, lastWriter: this.deviceWriter, at: new Date(this.now()).toISOString(), version });
+    this.touch(path);
+    return this.leave("put", { ok: true, version });
   }
```

`putFile` has the same put-shaped gap but isn't exercised by this test. CI can hit this flake now and then on any branch; a re-run passes.

**Smaller surprises:**
- A user note deliberately named like a copy without a device, such as `X (conflict 2026-10-27 10-15).md`, now counts as an open conflict copy. That is inherent to the new name, and the only effect is that it gets listed.
- A 403 with a `code` on a *read* (`versions`, `wsTicket`) would now be a `RejectedError`. The engine treats it like being offline and backs off; before, it treated it as a lost key. The contract says refusals come on writes, and this is the safer side, but a closing vault answering a read that way would show as offline.

## Open points for Chris

### What must be checked by hand first

Nothing here has run in Obsidian or against a real server.

1. **Pairing a read-only member's device.** Bob, `read` in `Beet`, pairs with a new code from plugin 0.2.0. The server must see `plugin: "0.2.0"` and pair.
2. **An edit refused and listed.** Bob edits a note. Settings, "Not synced", must show it with the server's sentence (`write: your role in vault Beet is read, …`). Other files keep syncing, and the key isn't forgotten.
3. **The raised member's edit going through.** Alice raises Bob to write. His *next* edit syncs. An edit refused earlier stays listed until it changes again or Obsidian restarts (see below).
4. **The conflict copy as Alice sees it.** Bob and Alice edit the same note at once. Bob's copy must be `plan (conflict YYYY-MM-DD HH-mm).md` and start with `Change from **this device**` and `The other change, at …`. Neither "Laptop" nor any writer's name may appear, in the name or the text, as it reaches Alice. Check the case where the other writer is Bob's own phone too.
5. **A 0.1.2 plugin pairing a shared vault.** It must get "Update the Kumbu² plugin to 0.2.0 or newer to sync a shared vault." alone, and the same code must then still work with 0.2.0.
6. **The first sync's dialog example** (`src/main.ts:185`, not unit-tested). In a shared vault the example copy name must have no device. In an own vault that isn't shared, it keeps the device.
7. **A folder made in a read-only vault** stays local, isn't listed, and markers keep working for other folders.

### For the maintainer to decide

- **Task 8 departs from spec §3.** The spec keeps `remoteWriter`. Task 8 leaves the writer out of a shared vault's copy, because the server shows a person's own other device by its name (`Work – Obsidian Phone`) and the copy reaches every member. It is its own commit, `b30bfe6`, so it can be reverted alone. If it is reverted, also drop ", or the other writer" from the README.
- **A refused change is not sent again after the rights change** until the file changes or the plugin restarts (the `rejected` map isn't saved). After Alice raises Bob, an edit refused earlier stays listed with the old sentence. The same applies to `owner-inactive` after reactivation. Nothing is lost.
- **"Keep local" refused in a first sync** isn't retried as such. The next check turns the file into Kumbu²'s text and moves the chosen text to a copy. Nothing is lost, but it isn't quite what "keep local" chose.
- **Extra requests:** one `GET /api/vaults` per check (every poll or hint) and one more right before each conflict copy. The read before a copy makes the per-check read redundant for naming. The per-check read is kept because the spec asks for it, and it keeps `copyDevice` current for the first-sync dialog.
- **A server from before sharing** (no `shared` field) now gets copies without a device. This is the maintainer's fail-closed decision, and the README says so.
- **The races test flake and its proposed test-only fix**, under Surprises.
- **A 403 with a code on a read** shows as offline rather than as a lost key, under Surprises.
- **Copies made before a vault was shared** keep their old names and text, as the brief's out-of-scope section says.

### Minor findings left as they are

Reviewers flagged these, and the final review triaged them as fine to leave:
- Two tests assert loosely as the plan wrote them: the too-old test without a sentence, and the 403 test without a sentence.
- The template literal in `conflictCopyPath` is dense, in the plan's prescribed form.
- `main.ts:185` is guarded by review only.

## Pull request

PR_LINK

CI on the pull request: CI_STATUS
