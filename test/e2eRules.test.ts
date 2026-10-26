// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { lostMarkers, markersIn, unexplainedCopies, type Op } from "../e2e/rules";

const user = (t: number, ...paths: string[]): Op => ({ t, side: "user", kind: "edit", paths, ok: true });
const agent = (t: number, ok = true, ...paths: string[]): Op => ({ t, side: "agent", kind: "edit", paths, ok });

test("a copy is explained by an agent write that met the last user operation before it", () => {
  const ops = [user(10_000, "a.md"), agent(11_000, true, "a.md")];
  expect(unexplainedCopies([{ t: 12_500, original: "a.md", copy: "a (conflict).md" }], ops, [], 1500)).toEqual([]);
});

test("an old coincidence on the same path does not explain a later copy", () => {
  // The loose rule took any user op before the copy and any agent op near it: the pair at 20 s "explained" 170 s.
  const ops = [user(20_000, "a.md"), agent(21_000, true, "a.md"), user(170_000, "a.md")];
  const writes = [{ t: 22_500, path: "a.md" }];
  expect(unexplainedCopies([{ t: 170_200, original: "a.md", copy: "a (conflict).md" }], ops, writes, 1500)).toEqual(["a.md"]);
});

test("an agent write after the device's write of that edit landed does not explain a copy", () => {
  const ops = [user(10_000, "a.md"), agent(13_000, true, "a.md")];
  const writes = [{ t: 12_100, path: "a.md" }];
  expect(unexplainedCopies([{ t: 13_400, original: "a.md", copy: "a (conflict).md" }], ops, writes, 1500)).toEqual(["a.md"]);
});

test("an agent write after the copy, or one that was refused, explains nothing", () => {
  const copy = { t: 12_000, original: "a.md", copy: "a (conflict).md" };
  expect(unexplainedCopies([copy], [user(10_000, "a.md"), agent(12_500, true, "a.md")], [], 1500)).toEqual(["a.md"]);
  expect(unexplainedCopies([copy], [user(10_000, "a.md"), agent(11_000, false, "a.md")], [], 1500)).toEqual(["a.md"]);
});

test("an agent write shortly before the user operation explains the copy, one long before does not", () => {
  const copy = { t: 12_500, original: "a.md", copy: "a (conflict).md" };
  expect(unexplainedCopies([copy], [agent(9_000, true, "a.md"), user(10_000, "a.md")], [], 1500)).toEqual([]);
  expect(unexplainedCopies([copy], [agent(5_000, true, "a.md"), user(10_000, "a.md")], [], 1500)).toEqual(["a.md"]);
});

test("markers are whole lines", () => {
  expect([...markersIn("# a\n\nuser 17\nagent 3\n")]).toEqual(["# a", "user 17", "agent 3"]);
});

test("a marker is lost unless it survives somewhere or a delete removed it", () => {
  const written = ["user 1", "user 17", "agent 2", "agent 3"];
  // "user 1" must not be found inside "user 17".
  expect(lostMarkers(written, ["# a\nagent 3\n"], ["# b\nuser 17\n", "# c\nagent 2\n"])).toEqual(["user 1"]);
  expect(lostMarkers(written, ["user 1\nagent 3"], ["user 17\nagent 2"])).toEqual([]);
});
