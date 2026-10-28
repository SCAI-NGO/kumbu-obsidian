# Kumbu² Sync

An Obsidian plugin that keeps an Obsidian vault in sync with one [Kumbu²](https://github.com/SCAI-NGO/kumbukumbu) vault within seconds. Notes written by agents through MCP and notes written by hand in Obsidian then live in one place. The first sync merges a vault that already has notes, and no edit is ever lost: when both sides changed the same note at the same time, the other version is kept as a conflict copy next to it.

The design is in the server repository: [`docs/superpowers/specs/2026-10-26-obsidian-sync-design.md`](https://github.com/SCAI-NGO/kumbukumbu/blob/master/docs/superpowers/specs/2026-10-26-obsidian-sync-design.md).

## Prerequisites

- Obsidian 1.11.4 or newer, on desktop or mobile
- A Kumbu² server and an account on it
- A vault there that you can write to. The plugin never creates a vault: it syncs exactly the one you connect it to

## Network use

The plugin talks only to the Kumbu² server you enter. It uses HTTPS (plain HTTP only for `localhost` and `127.0.0.1`), for REST calls and for one WebSocket that tells it when the vault changed. It sends the paths and text of every `.md` note outside dot folders, the paths and bytes of the PDFs and images it syncs (see below), and the device name when pairing (it becomes the key's name in Kumbu², and conflict copies carry it). Nothing else: no other files, no settings, no telemetry.

## Installation

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugins.
2. In BRAT, "Add beta plugin" with `SCAI-NGO/kumbu-obsidian`, and enable **Kumbu² Sync**.
3. In the Kumbu² web app, open the vault's menu and choose **Connect Obsidian**. It shows a pairing code.
4. In Obsidian, open the settings of Kumbu² Sync, enter the server address and the code, and connect.

If the vault already has notes, the first sync merges both sides. Notes that exist on one side only are copied over, and notes that are the same are left alone. If some paths have different text on each side, the plugin asks once what to do with all of them. **Keep both** (the default) keeps Kumbu²'s version and puts your local text in a conflict copy next to it. **Keep local** replaces the Kumbu² version, which stays in Kumbu²'s history. **Keep Kumbu²** replaces your text, which goes to Obsidian's trash first.

If you already have an API key with write access to the vault, "I have an API key already" in the settings takes it instead of a pairing code.

## Usage

**What syncs:** every `.md` note outside dot folders (`.obsidian/`, `.trash/` and any folder whose name starts with `.`), up to 1 MiB each, and PDFs and images (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) up to 15 MB each. Edits are uploaded 2 s after you stop typing, and changes in Kumbu² arrive within seconds while Obsidian is open. On a phone they arrive when you open the app. A changed PDF or image is sent whole. Renames and deletions sync too. A note or file deleted in Kumbu² goes to the trash you chose in Obsidian's settings.

PDFs and images need a Kumbu² server that keeps attachments. With an older server the plugin syncs notes only, as before, and lists PDFs and images as not synced; it notices a newer server by itself. Upgrading from 0.1.1 against a server that already keeps attachments: a PDF or image that differs between Obsidian and Kumbu² gets a conflict copy, as after any change on both sides. A reverse proxy in front of Kumbu² must take request bodies of at least 15 MB, or uploads are listed as "The server refused this (413)".

**What doesn't sync:** other files (Office documents, SVG, HEIC, audio and so on: Kumbu² keeps notes, PDFs and images only), anything in dot folders, notes larger than 1 MiB, PDFs and images larger than 15 MB, and a file whose path differs only in case from another, on systems where that would be the same file. Kumbu² checks that a file's content matches its extension, so a renamed file it refuses is listed with the server's reason. The settings list each file that isn't synced, with the reason.

**Files too large:** a note over 1 MiB, or a PDF or image over 15 MB, is not synced, and Obsidian shows a notice once for each such file, naming it and what to do. When several turn up in one sync (a first sync, say), one notice gives their number and points to the settings' list. An image can be uploaded in the Kumbu² web app, which can make it smaller; the plugin doesn't change your files. While a file is too large, the plugin doesn't read it and nothing from Kumbu² replaces or trashes it, the web app's smaller copy under the same name included. The notice comes again only if the file shrank below the limit (or was deleted) and later grew too large again. Other files Kumbu² doesn't keep get no notice; they are only in the settings' list.

**Conflict copies:** if a note changed in Kumbu² while you were editing it, the note gets the Kumbu² text and your text goes to `<name> (conflict <device> YYYY-MM-DD HH-mm).md` next to it. The copy starts (after any frontmatter) with a callout naming both changes and linking to the original. Merge what you need into the original, then delete the copy. A PDF or image changed on both sides works the same way: the file gets Kumbu²'s version and yours goes, unchanged, to a copy with the same extension, such as `shot (conflict Laptop 2026-10-27 22-15).png`. The settings list the open conflict copies.

**The status bar** shows `Kumbu² ● live` while the WebSocket is connected, `● polling` while it isn't (the plugin then checks every 2 minutes) and `○ offline` while the server can't be reached. It adds `· 3 not synced` when files are left out. A click opens the settings. The command **Sync now** checks at once.

**Disconnecting** (in the settings) stops syncing, revokes the device's key on the server and forgets it, so a device you give away or lose keeps no key that works; cancelling the first sync does the same. If the server can't be reached (or runs a Kumbu² older than 0.2.5), the plugin says so and the key stays valid until you revoke it in the web app's API keys page. A key you picked yourself under "I have an API key already" is yours: it is neither revoked nor removed, and stays in Obsidian's secret storage. Your files stay as they are.

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
