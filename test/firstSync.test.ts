// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test, vi } from "vitest";
import type { Choice, MergePlan } from "../src/engine/firstSync";
import { OfflineError } from "../src/engine/ports";
import { versionOf } from "../src/engine/version";
import { harness } from "./fakes/harness";

afterEach(() => { vi.useRealTimers(); });

const copies = (paths: Iterable<string>) => [...paths].filter((p) => p.includes("(conflict "));
const chooser = (choice: Choice | null) => {
  const plans: MergePlan[] = [];
  const fn = (plan: MergePlan) => { plans.push(plan); return Promise.resolve(choice); };
  return Object.assign(fn, { plans });
};
const seven = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`d${n}.md`, `local ${n}`]));
const sevenRemote = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`d${n}.md`, `kumbu ${n}`]));

test("no conflicts: choose is never called and the summary counts uploads, downloads and unchanged", async () => {
  const h = await harness({ start: false, localOnly: { "a.md": "a", "b.md": "b" }, remoteOnly: { "b.md": "b", "c.md": "c" } });
  const choose = chooser("both");
  const summary = await h.engine.firstSync(choose);
  expect(choose.plans).toHaveLength(0);
  expect(summary).toEqual({ uploaded: 1, downloaded: 1, unchanged: 1, conflictCopies: 0, notSynced: [] });
  expect(h.server.notes.get("a.md")!.content).toBe("a");
  expect(h.files.files.get("c.md")).toBe("c");
  expect(Object.keys(h.state.state.bases).sort()).toEqual(["a.md", "b.md", "c.md"]);
  expect(h.state.state.cursor).not.toBeNull();
});

test("the plan lists 7 differing notes and asks once", async () => {
  const h = await harness({ start: false, localOnly: { ...seven, "a.md": "a" }, remoteOnly: { ...sevenRemote, "b.md": "b" } });
  const choose = chooser("both");
  await h.engine.firstSync(choose);
  expect(choose.plans).toHaveLength(1);
  expect(choose.plans[0]!.differing).toHaveLength(7);
  expect(choose.plans[0]!.toUpload).toEqual(["a.md"]);
  expect(choose.plans[0]!.toDownload).toEqual(["b.md"]);
});

test("keep both: a conflict copy per differing note, the server text at the path", async () => {
  const h = await harness({ start: false, localOnly: seven, remoteOnly: sevenRemote });
  const summary = await h.engine.firstSync(chooser("both"));
  expect(summary!.conflictCopies).toBe(7);
  expect(copies(h.files.files.keys())).toHaveLength(7);
  expect(copies(h.server.notes.keys())).toHaveLength(7);
  expect(h.files.files.get("d1.md")).toBe("kumbu 1");
  const copy = copies(h.files.files.keys()).find((p) => p.startsWith("d1 "))!;
  expect(h.files.files.get(copy)).toContain("local 1");
});

test("keep local: the server gets the local text with the server version as base", async () => {
  const h = await harness({ start: false, localOnly: { "d.md": "local" }, remoteOnly: { "d.md": "kumbu" } });
  const summary = await h.engine.firstSync(chooser("local"));
  expect(h.server.calls.find((c) => c.method === "put")!.args).toEqual(["d.md", "local", await versionOf("kumbu")]);
  expect(h.server.notes.get("d.md")!.content).toBe("local");
  expect(h.state.state.bases["d.md"]).toBe(await versionOf("local"));
  expect(summary).toMatchObject({ uploaded: 1, conflictCopies: 0 });
});

test("keep Kumbu²: the local text goes to .trash first", async () => {
  const h = await harness({ start: false, localOnly: { "d.md": "local" }, remoteOnly: { "d.md": "kumbu" } });
  const summary = await h.engine.firstSync(chooser("kumbu"));
  expect(h.files.trash).toContain("d.md");
  expect(h.files.files.get("d.md")).toBe("kumbu");
  expect(h.state.state.bases["d.md"]).toBe(await versionOf("kumbu"));
  expect(summary).toMatchObject({ downloaded: 1, conflictCopies: 0 });
});

test("cancelling the choice saves nothing", async () => {
  const h = await harness({ start: false, localOnly: { "d.md": "local", "a.md": "a" }, remoteOnly: { "d.md": "kumbu" } });
  expect(await h.engine.firstSync(chooser(null))).toBeNull();
  expect(h.state.saves).toBe(0);
  expect(h.server.count("put")).toBe(0);
  expect(h.files.files.get("d.md")).toBe("local");
});

test("attachments are counted, not synced", async () => {
  const h = await harness({ start: false, localOnly: { "a.md": "a", "x.png": "png" } });
  const summary = await h.engine.firstSync(chooser("both"));
  expect(summary!.notSynced).toEqual([{ path: "x.png", reason: "attachment" }]);
  expect(h.server.notes.has("x.png")).toBe(false);
});

test("an interrupted first sync finishes on the next run without duplicates or conflict copies", async () => {
  const local = { "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" };
  const h = await harness({ start: false, localOnly: local, remoteOnly: { "r.md": "r" } });
  const realPut = h.server.put.bind(h.server);
  let puts = 0;
  h.server.put = async (...args) => {
    if (++puts === 3) throw new OfflineError("lost signal");
    return realPut(...args);
  };
  await expect(h.engine.firstSync(chooser("both"))).rejects.toBeInstanceOf(OfflineError);
  h.server.put = realPut;
  const summary = await h.engine.firstSync(chooser("both"));
  expect(summary!.conflictCopies).toBe(0);
  for (const [p, t] of Object.entries(local)) {
    expect(h.server.notes.get(p)!.content).toBe(t);
    expect(h.files.files.get(p)).toBe(t);
  }
  expect(h.files.files.get("r.md")).toBe("r");
  expect(h.server.notes.size).toBe(5);
  expect(h.files.files.size).toBe(5);
  expect(copies(h.files.files.keys())).toEqual([]);
});
