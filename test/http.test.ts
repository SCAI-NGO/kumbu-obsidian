// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, test, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl }));

const { obsidianHttp } = await import("../src/obsidian/http");
const { OfflineError } = await import("../src/engine/ports");
const { versionOf, versionOfSync } = await import("../src/engine/version");

beforeEach(() => { requestUrl.mockReset(); });

test("obsidianHttp passes throw: false and maps status, headers and text", async () => {
  requestUrl.mockResolvedValue({ status: 409, headers: { etag: '"s"' }, text: '{"error":"changed"}' });
  const r = await obsidianHttp({ method: "PUT", url: "https://k.example/api/notes/Work/a.md",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, body: "{}" });
  expect(r).toEqual({ status: 409, headers: { etag: '"s"' }, text: '{"error":"changed"}' });
  expect(requestUrl).toHaveBeenCalledWith({
    url: "https://k.example/api/notes/Work/a.md", method: "PUT", body: "{}", contentType: "application/json",
    headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, throw: false,
  });
});

test("an empty body (204, 304) is read as empty text", async () => {
  requestUrl.mockResolvedValue({ status: 204, headers: {}, get text(): string { throw new Error("no body"); } });
  expect(await obsidianHttp({ method: "DELETE", url: "https://k.example/x", headers: {} })).toEqual({ status: 204, headers: {}, text: "" });
});

test("obsidianHttp sends an ArrayBuffer body as it is and returns the answer's bytes", async () => {
  const sent = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0d, 0x0a]).buffer;
  const answer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
  requestUrl.mockResolvedValue({ status: 200, headers: { etag: '"aaaaaaaaaaaa"' }, arrayBuffer: answer, text: "\u0089PNG" });
  const r = await obsidianHttp({ method: "PUT", url: "https://k.example/api/files/Work/a.pdf",
    headers: { Authorization: "Bearer k", "Content-Type": "application/octet-stream" }, body: sent });
  expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({ body: sent, contentType: "application/octet-stream" }));
  expect(r.bytes).toBe(answer);
});

test("a thrown requestUrl becomes OfflineError", async () => {
  requestUrl.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
  await expect(obsidianHttp({ method: "GET", url: "https://k.example/x", headers: {} })).rejects.toBeInstanceOf(OfflineError);
});

test.each(["# Plan\n", "Besprechung März\r\n", "emoji 🎉 and 漢字", "", "x".repeat(1000)])(
  "the synchronous SHA-256 equals versionOf for %j",
  async (text) => {
    expect(versionOfSync(text)).toBe(await versionOf(text));
  },
);
