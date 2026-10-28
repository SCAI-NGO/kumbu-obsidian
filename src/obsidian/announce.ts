// SPDX-License-Identifier: AGPL-3.0-or-later
// The notice for a file too large to sync, once per file (spec: "an Obsidian notice once per file").
import { limitOf } from "../engine/engine";
import type { NotSynced } from "../engine/ports";
import { reasonText } from "./texts";

/**
 * Which too-large files to announce now, and the announced list to keep in data.json. A file stays announced while
 * it is listed or still over its limit on disk (the list is empty after a restart until a check has run); it is
 * forgotten once it shrinks below the limit or is gone, so growing too large again is announced again.
 * `sizeOf`: the file's size on disk by its synced path, null if there is none. Several new ones at once (a first sync)
 * share one notice that points to the settings' list, rather than one notice each.
 */
export function announce(
  announced: readonly string[], notSynced: NotSynced[], sizeOf: (path: string) => number | null,
): { announced: string[]; notices: string[]; changed: boolean } {
  const listed = new Set(notSynced.filter((n) => n.reason === "too-large").map((n) => n.path));
  const kept = announced.filter((path) => {
    if (listed.has(path)) return true;
    const size = sizeOf(path);
    return size !== null && size > limitOf(path);
  });
  const known = new Set(kept);
  const fresh = notSynced.filter((n) => n.reason === "too-large" && !known.has(n.path));
  return {
    announced: [...kept, ...fresh.map((n) => n.path)],
    notices: fresh.length === 0 ? [] : fresh.length === 1
      ? [`Kumbu² Sync: ${fresh[0]!.path} isn't synced. ${reasonText(fresh[0]!)}`]
      : [`Kumbu² Sync: ${fresh.length} files are too large to sync. The settings list them under “Not synced”, with what to do.`],
    changed: fresh.length > 0 || kept.length !== announced.length,
  };
}
