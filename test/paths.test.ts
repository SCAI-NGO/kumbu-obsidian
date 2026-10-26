// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import {
  conflictCopyPath, defaultDeviceName, eligibility, fromApiPath, isAllowedServerUrl, isValidDeviceName,
  secretId, serverProblem, slug, toApiPath, urlFor,
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
  expect(secretId("Work Notes", "Android-7Q", "My vault")).toMatch(/^kumbu-work-notes-[0-9a-f]{6}-android-7q$/);
  expect(secretId("Büro", "Laptop", "v")).toMatch(/^kumbu-buro-[0-9a-f]{6}-laptop$/);
  expect(secretId("日本", "Laptop", "v")).toMatch(/^kumbu-[0-9a-f]{6}-laptop$/);
});
test("secret ids differ for names a slug would fold together", () => {
  expect(secretId("Büro", "Laptop", "v")).not.toBe(secretId("Buro", "Laptop", "v"));
  expect(secretId("Work", "Laptop", "v")).not.toBe(secretId("work", "Laptop", "v"));
  expect(secretId("日本", "Laptop", "v")).not.toBe(secretId("中国", "Laptop", "v"));
  // Two Obsidian vaults on one device paired with the same Kumbu² vault.
  expect(secretId("Work", "Laptop", "Notes")).not.toBe(secretId("Work", "Laptop", "Other notes"));
  expect(secretId("Work", "Laptop", "Notes")).toBe(secretId("Work", "Laptop", "Notes"));
});
test("a server url from data.json is checked before the key is sent", () => {
  expect(serverProblem("https://kumbu.example.org")).toBeNull();
  expect(serverProblem("http://localhost:8080")).toBeNull();
  expect(serverProblem("http://kumbu.example.org")).toBe("The server URL must start with https:// (http:// only for localhost).");
  expect(serverProblem("")).not.toBeNull();
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
