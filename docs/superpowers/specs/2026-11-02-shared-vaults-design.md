# Plugin 0.2.0: shared vaults

Date: 2026-11-02. Status: draft for review.

The Kumbu² server lets vaults be shared since its 0.3.0. To sync one, the plugin must do three things it doesn't do yet. The server's side is built; its design is §10.2 and §3.5 of the collab design in the Kumbu² repository (`docs/superpowers/specs/2026-10-31-collab-design.md`), and everything needed from it is repeated here.

`manifest.json`, `package.json` and `versions.json` say 0.2.0 already. An earlier release with that number held no changes and was deleted. Nobody installed it.

## 1. Sending the version when pairing

`POST /api/pairing/redeem` takes `{ code, device, plugin }`. Without `plugin`, or below 0.2.0, the server refuses to pair a shared vault with 409 and the sentence "Update the Kumbu² plugin to 0.2.0 or newer to sync a shared vault.", before the code is used up.

- `RedeemRequest` (`src/api/types.ts:67`) gains `plugin: string`.
- `redeemPairing` (`src/api/client.ts:207`) takes it as a parameter, and `src/main.ts:133` passes `this.manifest.version`.
- The 409 branch (`src/api/client.ts:221`) today adds "Change the device name and make a new code in the web app." to every 409. A 409 with `type: "plugin-too-old"` shows the server's sentence alone: the code still works, and the device name has nothing to do with it.

## 2. A refusal is not a revoked key

Today every 403 becomes `AuthError` (`expectOk`, `src/api/client.ts:253`), which stops the sync as if the key were revoked (`src/engine/engine.ts:916`). In a shared vault a 403 can be an ordinary refusal: a read-only member's device changing a note, or a `write` device editing `Board/Board.md`.

The server's refusals carry a machine-readable `code` beside the sentence: `read-only`, `structural`, `closing`, `owner-inactive`. Clients branch on the code, never on the text.

- A 403 **with** a `code` becomes `RejectedError` with the server's sentence. The file is listed under "Not synced" with that sentence, which the engine's `rejected` map already does (`engine.ts:547`, `:648`).
- A 403 **without** a `code` stays `AuthError`.
- An unknown `code` counts as a refusal too: a newer server mustn't stop an older plugin's sync.
- The server's version comes back with the next remote change of that file, as for other rejections (`engine.ts:652`). A test covers `rejected` meeting a remote change, which §10.2 asks for explicitly. Local text is never overwritten by this without a conflict copy, as the engine does today.

This must hold on every write path: note write and trash, attachment upload and trash, and moves (`src/api/client.ts`). `src/api/client.ts:167`, which treats 403 as revoked when revoking the device's own key on purpose, stays as it is.

## 3. Conflict copies without the device name in a shared vault

A conflict copy syncs like any note, so in a shared vault its name and its text reach every member, and outlive the member's account. The device name must not be in either there.

- `GET /api/vaults` (`src/api/client.ts:172`) returns `shared` per vault, true also for one's own vault once it is shared. `VaultView` (`src/api/types.ts:64`) gains `shared?: boolean`. The engine reads it at the start of each sync, so a vault shared later is seen.
- If it can't be known (the list failed, the vault isn't listed), treat the vault as shared: it fails closed.
- `conflictCopyPath` (`src/engine/paths.ts:74`): in a shared vault `Plan (conflict 2026-10-27 10-15).md`; else as today, with the device.
- `conflictCopyText` (`src/engine/conflict.ts:15`): in a shared vault `Change from **this device** at …`; else as today. `remoteWriter` stays: the server has already rendered it for this caller, and it is someone else's name only as this member may see it.
- `src/engine/engine.ts:771`, `:803` pass what is needed.
- The device's own vault that is not shared: nothing changes.

## 4. Worked example

Bob has a read-only membership in `Beet`, and pairs Obsidian with a new code.

1. `redeemPairing` sends `{ code, device: "Laptop", plugin: "0.2.0" }`. The server pairs.
2. Bob edits `plan.md` in Obsidian. `PUT` answers 403 `{ error: "this key can only read vault Beet", code: "read-only" }`.
3. The sync goes on. Settings, "Not synced": `plan.md: this key can only read vault Beet`. Other files keep syncing, and the key isn't taken for revoked.
4. Alice raises Bob to write. Bob and Alice edit `plan.md` at once. Bob's Obsidian makes `plan (conflict 2026-11-02 21-15).md`, with `Change from **this device**`, with no "Laptop" in the name or the text.
5. An old plugin 0.1.2 pairing the same vault sends no `plugin`, and gets the server's sentence. The code still works for the updated plugin.

## Out of scope

- A renamed vault: the plugin asks by the old name, gets 404, and stops with its existing sentence. Pairing again is accepted.
- Publishing the release: the tag is set by the maintainer.
- The README may gain a line on shared vaults; nothing else in the docs.
