// SPDX-License-Identifier: AGPL-3.0-or-later
// What the end-to-end run asserts beyond convergence: no edit is lost, and every conflict copy has a reason.

export interface Op { t: number; side: "user" | "agent"; kind: string; paths: string[]; /** False: the server refused it. */ ok: boolean; }
export interface Landed { t: number; path: string; }
export interface Copy { t: number; original: string; copy: string; }

/**
 * The originals of copies no agent write explains. A copy of `p` made at `c.t` is explained by the last user
 * operation on `p` before it and an agent write on `p` that landed from `beforeMs` before that user operation until
 * whichever came first: the device's next write of `p` reaching the server, or the copy itself.
 */
export function unexplainedCopies(copies: Copy[], ops: Op[], deviceWrites: Landed[], beforeMs: number): string[] {
  const out: string[] = [];
  for (const c of copies) {
    const u = ops.filter((o) => o.side === "user" && o.paths.includes(c.original) && o.t <= c.t).at(-1);
    let explained = false;
    if (u !== undefined) {
      const landed = deviceWrites.find((w) => w.path === c.original && w.t >= u.t)?.t ?? Infinity;
      const end = Math.min(landed, c.t);
      explained = ops.some((a) => a.side === "agent" && a.ok && a.paths.includes(c.original) && a.t >= u.t - beforeMs && a.t <= end);
    }
    if (!explained) out.push(c.original);
  }
  return out;
}

export function markersIn(text: string): Set<string> {
  return new Set(text.replace(/\r\n/g, "\n").split("\n").filter((l) => l !== ""));
}

/**
 * Markers (each edit appends one unique line) found in no surviving text (notes, conflict copies, `.trash`) and in
 * no text a delete removed on purpose.
 */
export function lostMarkers(written: string[], removed: string[], surviving: string[]): string[] {
  const seen = new Set<string>();
  for (const text of [...removed, ...surviving]) for (const line of markersIn(text)) seen.add(line);
  return written.filter((m) => !seen.has(m));
}
