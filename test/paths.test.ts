// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import {
  conflictCopyPath, defaultDeviceName, eligibility, fromApiPath, isAllowedServerUrl, isValidDeviceName,
  secretId, slug, toApiPath, urlFor,
} from "../src/engine/paths";

test("api paths are NFC", () => {
  expect(toApiPath("Work", "Besprechung März.md")).toBe("/Work/Besprechung März.md");
  expect(toApiPath("Work", "Besprechung März.md")).toBe("/Work/Besprechung März.md");
  expect(fromApiPath("Work", "/Work/a/b.md")).toBe("a/b.md");
  expect(fromApiPath("Work", "/Work/März.md")).toBe("März.md");
});
test("urls encode each segment", () => {
  expect(urlFor("Work", "a b/c#d.md")).toBe("/api/notes/Work/a%20b/c%23d.md");
  expect(urlFor("My Work", "Plan März.md")).toBe("/api/notes/My%20Work/Plan%20M%C3%A4rz.md");
});
test("eligibility", () => {
  expect(eligibility("notes/a.md")).toBe("sync");
  expect(eligibility("img/x.png")).toBe("attachment");
  expect(eligibility(".obsidian/app.json")).toBe("ignored");
  expect(eligibility("a/.hidden/b.md")).toBe("ignored");
  expect(eligibility(".trash/old.md")).toBe("ignored");
});
test("conflict copy sits next to the original", () => {
  expect(conflictCopyPath("projects/Plan.md", "Laptop", new Date(2026, 9, 27, 10, 15)))
    .toBe("projects/Plan (conflict Laptop 2026-10-27 10-15).md");
  expect(conflictCopyPath("Plan.md", "Laptop", new Date(2026, 0, 2, 3, 4)))
    .toBe("Plan (conflict Laptop 2026-01-02 03-04).md");
});
test("slug", () => {
  expect(slug("  Work -- Notes! ")).toBe("work-notes");
});
test("secret ids are valid SecretStorage ids", () => {
  expect(secretId("Work Notes", "Android-7Q")).toBe("kumbu-work-notes-android-7q");
  expect(secretId("Büro", "Laptop")).toBe("kumbu-buro-laptop");
});
test("server url rule", () => {
  expect(isAllowedServerUrl("https://kumbu.tidesson.net")).toBe(true);
  expect(isAllowedServerUrl("http://localhost:8080")).toBe(true);
  expect(isAllowedServerUrl("http://127.0.0.1:8080")).toBe(true);
  expect(isAllowedServerUrl("http://kumbu.example.org")).toBe(false);
  expect(isAllowedServerUrl("http://localhost.example.org")).toBe(false);
  expect(isAllowedServerUrl("not a url")).toBe(false);
});
test("default device name", () => {
  expect(defaultDeviceName("Android", () => 0)).toMatch(/^Android-[0-9A-HJKMNP-TV-Z]{2}$/);
  expect(defaultDeviceName("Linux", () => 0.999)).toBe("Linux-ZZ");
});
test("device names", () => {
  expect(isValidDeviceName("Android-7Q")).toBe(true);
  expect(isValidDeviceName("My laptop_2")).toBe(true);
  expect(isValidDeviceName("Laptop (work)")).toBe(false);
  expect(isValidDeviceName("")).toBe(false);
  expect(isValidDeviceName("   ")).toBe(false);
  expect(isValidDeviceName("x".repeat(33))).toBe(false);
});
