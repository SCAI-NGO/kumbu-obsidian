# Kumbu² Sync

An Obsidian plugin that keeps an Obsidian vault in sync with one [Kumbu²](https://github.com/SCAI-NGO/kumbukumbu) vault within seconds. Notes written by agents through MCP and notes written by hand in Obsidian then live in one place. The first sync merges a vault that already has notes, and no edit is ever lost: when both sides changed the same note at the same time, the other version is kept as a conflict copy next to it.

The design is in the server repository: [`docs/superpowers/specs/2026-10-26-obsidian-sync-design.md`](https://github.com/SCAI-NGO/kumbukumbu/blob/master/docs/superpowers/specs/2026-10-26-obsidian-sync-design.md).

## Prerequisites

- Obsidian 1.11.4 or newer, on desktop or mobile
- A Kumbu² server and an account on it
- A vault there that you can write to. The plugin never creates a vault: it syncs exactly the one you connect it to

## Network use

The plugin talks only to the Kumbu² server you enter. It uses HTTPS (plain HTTP only for `localhost` and `127.0.0.1`), for REST calls and for one WebSocket that tells it when the vault changed. It sends the paths and text of every `.md` note outside dot folders, and the device name when pairing (it becomes the key's name in Kumbu², and conflict copies carry it). Nothing else: no attachments, no settings, no telemetry.

## Installation

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugins.
2. In BRAT, "Add beta plugin" with `SCAI-NGO/kumbu-obsidian`, and enable **Kumbu² Sync**.
3. In the Kumbu² web app, open the vault's menu and choose **Connect Obsidian**. It shows a pairing code.
4. In Obsidian, open the settings of Kumbu² Sync, enter the server address and the code, and connect.

If the vault already has notes, the first sync merges both sides. Notes that exist on one side only are copied over, and notes that are the same are left alone. If some paths have different text on each side, the plugin asks once what to do with all of them. **Keep both** (the default) keeps Kumbu²'s version and puts your local text in a conflict copy next to it. **Keep local** replaces the Kumbu² version, which stays in Kumbu²'s history. **Keep Kumbu²** replaces your text, which goes to Obsidian's trash first.

If you already have an API key with write access to the vault, "I have an API key already" in the settings takes it instead of a pairing code.

## Usage

**What syncs:** every `.md` note outside dot folders (`.obsidian/`, `.trash/` and any folder whose name starts with `.`), up to 1 MiB each. Edits are uploaded 2 s after you stop typing, and changes in Kumbu² arrive within seconds while Obsidian is open. On a phone they arrive when you open the app. Renames and deletions sync too. A note deleted in Kumbu² goes to the trash you chose in Obsidian's settings.

**What doesn't sync:** attachments (images, PDFs and other files; Kumbu² keeps text only), anything in dot folders, notes larger than 1 MiB, and a note whose path differs only in case from another note, on systems where that would be the same file. The settings list each note that isn't synced, with the reason.

**Conflict copies:** if a note changed in Kumbu² while you were editing it, the note gets the Kumbu² text and your text goes to `<name> (conflict <device> YYYY-MM-DD HH-mm).md` next to it. The copy starts (after any frontmatter) with a callout naming both changes and linking to the original. Merge what you need into the original, then delete the copy. The settings list the open conflict copies.

**The status bar** shows `Kumbu² ● live` while the WebSocket is connected, `● polling` while it isn't (the plugin then checks every 2 minutes) and `○ offline` while the server can't be reached. It adds `· 3 not synced` when notes are left out. A click opens the settings. The command **Sync now** checks at once.

**Disconnecting** (in the settings) stops syncing and forgets the key it stored when pairing. A key you picked yourself under "I have an API key already" stays in Obsidian's secret storage. Your files stay as they are. The device's key stays on the server until you revoke it in the web app's API keys page.

## Where the key is kept

The API key is kept in Obsidian's own local secret storage (`SecretStorage`, Obsidian 1.11.4 and newer), not in the plugin's `data.json`. `data.json` holds only the secret's name. How Obsidian protects that storage on each platform has not been checked for this release.

## Development

```sh
pnpm install
pnpm dev      # rebuilds main.js on every change
pnpm test     # Vitest
pnpm lint     # ESLint with eslint-plugin-obsidianmd
pnpm build    # type check and production bundle
pnpm e2e      # the end-to-end race run against a real server, see e2e/README.md
```

To try it in Obsidian, link the repository into a test vault: `ln -s "$PWD" <vault>/.obsidian/plugins/kumbu-sync`. Run `pnpm dev` and reload the plugin after a change.

The sync engine (`src/engine/`), the API client (`src/api/`) and the live hints (`src/live/`) are plain TypeScript without Obsidian. Lint enforces that, and the tests and `pnpm e2e` run them in Node. Only `src/obsidian/` and `src/main.ts` use Obsidian's API.

**Releasing:** bump the version in `manifest.json`, `package.json` and `versions.json` (the new version → its `minAppVersion`), commit, and push a tag `x.y.z` without a `v`. The release workflow checks that the tag matches `manifest.json`, runs lint, the tests and the build, and creates the GitHub release with `main.js`, `manifest.json` and `styles.css`. BRAT installs from that release.

## Licence

[AGPL-3.0-or-later](LICENSE), the same as the Kumbu² server.
