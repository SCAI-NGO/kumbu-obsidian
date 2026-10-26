// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";
import { KumbuApi, normalisePairingCode, redeemPairing, type HttpFn, type HttpRequest, type HttpResponse } from "../src/api/client";
import { AuthError, OfflineError, RejectedError } from "../src/engine/ports";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeHttp(...replies: (Reply | Error)[]): HttpFn & { last: HttpRequest | undefined; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const fn = (async (r: HttpRequest): Promise<HttpResponse> => {
    calls.push(r);
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    return { status: reply.status, headers: reply.headers ?? {}, text: reply.body === undefined ? "" : JSON.stringify(reply.body) };
  }) as HttpFn & { last: HttpRequest | undefined; calls: HttpRequest[] };
  Object.defineProperty(fn, "last", { get: () => calls[calls.length - 1] });
  fn.calls = calls;
  return fn;
}
const api = (http: HttpFn) => new KumbuApi(http, "https://k.example/", "Work", "kumbu_x");
const note = { path: "/Work/a b.md", content: "text", version: "cccccccccccc", lastWriter: "liz", lastWriteAt: "2026-10-27T10:00:00Z", current: true, lastWriterKind: null };

describe("put", () => {
  test("put sends the base version and maps 409 to a conflict", async () => {
    const http = fakeHttp({ status: 409, body: { error: "changed", current: { content: "x", version: "aaaaaaaaaaaa" } } });
    expect(await api(http).put("a b.md", "text", "bbbbbbbbbbbb")).toEqual({ ok: false, conflict: { content: "x", version: "aaaaaaaaaaaa" } });
    expect(http.last).toMatchObject({ method: "PUT", url: "https://k.example/api/notes/Work/a%20b.md",
      headers: { Authorization: "Bearer kumbu_x", "Content-Type": "application/json" },
      body: JSON.stringify({ content: "text", version: "bbbbbbbbbbbb" }) });
  });
  test("a create sends no version and returns the new version", async () => {
    const http = fakeHttp({ status: 201, body: note });
    expect(await api(http).put("a b.md", "text", null)).toEqual({ ok: true, version: "cccccccccccc" });
    expect(JSON.parse(http.last!.body!)).toEqual({ content: "text" });
  });
  test("a 409 whose note is gone meanwhile becomes a create", async () => {
    const http = fakeHttp({ status: 409, body: { error: "changed" } }, { status: 404, body: { error: "gone" } }, { status: 201, body: note });
    expect(await api(http).put("a.md", "text", "bbbbbbbbbbbb")).toEqual({ ok: true, version: "cccccccccccc" });
    expect(JSON.parse(http.last!.body!)).toEqual({ content: "text" });
  });
  test("a 404 on a put with a base means the note is gone: it becomes a create", async () => {
    const http = fakeHttp({ status: 404, body: { error: "No note /Work/a.md." } }, { status: 201, body: note });
    expect(await api(http).put("a.md", "text", "bbbbbbbbbbbb")).toEqual({ ok: true, version: "cccccccccccc" });
    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(http.last!.body!)).toEqual({ content: "text" });
  });
  test("a 404 on a create means the key lost the vault", async () => {
    await expect(api(fakeHttp({ status: 404, body: { error: "No vault Work." } })).put("a.md", "text", null)).rejects.toBeInstanceOf(AuthError);
  });
  test("uploads send the LF text", async () => {
    const http = fakeHttp({ status: 200, body: note });
    await api(http).put("a.md", "a\r\nb", "bbbbbbbbbbbb");
    expect((JSON.parse(http.last!.body!) as { content: string }).content).toBe("a\nb");
  });
});

describe("versions", () => {
  test("versions maps paths and deleted entries", async () => {
    const http = fakeHttp({ status: 200, headers: { etag: '"s1"' }, body: {
      full: false, cursor: "c2", state: "s1", damaged: 0,
      notes: [{ path: "/Work/x/b.md", version: "bbbbbbbbbbbb" }], deleted: ["/Work/a.md"] } });
    expect(await api(http).versions("c1", null)).toEqual({
      full: false, cursor: "c2", state: "s1", damaged: 0, unchanged: false,
      entries: [{ path: "x/b.md", version: "bbbbbbbbbbbb" }, { path: "a.md", version: null }] });
    expect(http.last!.url).toBe("https://k.example/api/vaults/Work/versions?since=c1");
    expect(http.last!.headers["If-None-Match"]).toBeUndefined();
  });
  test("a full answer without deleted has entries for its notes only", async () => {
    const http = fakeHttp({ status: 200, body: { full: true, cursor: "c", state: "s", damaged: 2, notes: [{ path: "/Work/a.md", version: "aaaaaaaaaaaa" }] } });
    expect(await api(http).versions(null, null)).toMatchObject({ full: true, damaged: 2, entries: [{ path: "a.md", version: "aaaaaaaaaaaa" }] });
    expect(http.last!.url).toBe("https://k.example/api/vaults/Work/versions");
  });
  test("versions sends If-None-Match and reads 304 as unchanged", async () => {
    const http = fakeHttp({ status: 304 });
    const answer = await api(http).versions(null, "s1");
    expect(http.last!.headers["If-None-Match"]).toBe('"s1"');
    expect(answer).toMatchObject({ unchanged: true, full: true, state: "s1", entries: [] });
  });
  test("If-None-Match is never sent with since", async () => {
    const http = fakeHttp({ status: 200, body: { full: false, cursor: "c", state: "s", damaged: 0, notes: [], deleted: [] } });
    await api(http).versions("c0", "s1");
    expect(http.last!.headers["If-None-Match"]).toBeUndefined();
  });
  test("a vault encoded in the url", async () => {
    const http = fakeHttp({ status: 200, body: { full: true, cursor: "c", state: "s", damaged: 0, notes: [] } });
    await new KumbuApi(http, "https://k.example", "My Work", "k").versions(null, null);
    expect(http.last!.url).toBe("https://k.example/api/vaults/My%20Work/versions");
  });
  test("404 on versions means the key lost the vault", async () => {
    await expect(api(fakeHttp({ status: 404, body: { error: "No vault Work." } })).versions(null, null)).rejects.toBeInstanceOf(AuthError);
  });
});

describe("read", () => {
  test("read maps the note and 404 to null", async () => {
    expect(await api(fakeHttp({ status: 200, body: note })).read("a b.md")).toEqual({
      path: "a b.md", content: "text", version: "cccccccccccc", lastWriter: "liz", lastWriteAt: "2026-10-27T10:00:00Z" });
    expect(await api(fakeHttp({ status: 404, body: { error: "gone" } })).read("a.md")).toBeNull();
  });
});

describe("remove", () => {
  test("delete sends ?version= and maps 204 to ok", async () => {
    const http = fakeHttp({ status: 204 });
    expect(await api(http).remove("a b.md", "aaaaaaaaaaaa")).toEqual({ ok: true });
    expect(http.last).toMatchObject({ method: "DELETE", url: "https://k.example/api/notes/Work/a%20b.md?version=aaaaaaaaaaaa" });
  });
  test("delete maps 404 to already gone", async () => {
    expect(await api(fakeHttp({ status: 404, body: { error: "gone" } })).remove("a.md", "aaaaaaaaaaaa")).toEqual({ ok: false, conflict: null });
  });
  test("delete maps 409 to the conflict it carries", async () => {
    const http = fakeHttp({ status: 409, body: { error: "changed", current: { content: "y", version: "dddddddddddd" } } });
    expect(await api(http).remove("a.md", "aaaaaaaaaaaa")).toEqual({ ok: false, conflict: { content: "y", version: "dddddddddddd" } });
  });
  test("a 409 without the current note reads it", async () => {
    const http = fakeHttp({ status: 409, body: { error: "changed" } }, { status: 200, body: { ...note, content: "z", version: "eeeeeeeeeeee" } });
    expect(await api(http).remove("a.md", "aaaaaaaaaaaa")).toEqual({ ok: false, conflict: { content: "z", version: "eeeeeeeeeeee" } });
    expect(http.last).toMatchObject({ method: "GET", url: "https://k.example/api/notes/Work/a.md" });
  });
});

describe("move", () => {
  test("move always sends keepLinks true with API paths", async () => {
    const http = fakeHttp({ status: 200, body: { message: "moved", path: "/Work/b.md", version: "bbbbbbbbbbbb" } });
    expect(await api(http).move("a.md", "b.md")).toEqual({ ok: true, version: "bbbbbbbbbbbb" });
    expect(http.last).toMatchObject({ method: "POST", url: "https://k.example/api/move" });
    expect(JSON.parse(http.last!.body!)).toEqual({ from: "/Work/a.md", to: "/Work/b.md", keepLinks: true });
  });
  test("move maps 409 and 404 to not moved", async () => {
    expect(await api(fakeHttp({ status: 409, body: { error: "exists" } })).move("a.md", "b.md")).toEqual({ ok: false });
    expect(await api(fakeHttp({ status: 404, body: { error: "gone" } })).move("a.md", "b.md")).toEqual({ ok: false });
  });
});

describe("errors", () => {
  test("401 throws AuthError", async () => {
    await expect(api(fakeHttp({ status: 401, body: { error: "revoked" } })).read("a.md")).rejects.toBeInstanceOf(AuthError);
  });
  test("413 throws RejectedError with the server sentence", async () => {
    const p = api(fakeHttp({ status: 413, body: { error: "Notes are at most 1 MiB." } })).put("a.md", "x", null);
    await expect(p).rejects.toBeInstanceOf(RejectedError);
    await expect(p).rejects.toThrow("Notes are at most 1 MiB.");
  });
  test("503 and 429 carry Retry-After", async () => {
    const p = api(fakeHttp({ status: 503, headers: { "retry-after": "5" }, body: { error: "busy" } })).read("a.md");
    await expect(p).rejects.toBeInstanceOf(OfflineError);
    await expect(p).rejects.toMatchObject({ retryAfterMs: 5000 });
    await expect(api(fakeHttp({ status: 429, headers: { "Retry-After": "60" } })).read("a.md")).rejects.toMatchObject({ retryAfterMs: 60000 });
  });
  test("5xx and network errors throw OfflineError", async () => {
    await expect(api(fakeHttp({ status: 500 })).read("a.md")).rejects.toBeInstanceOf(OfflineError);
    await expect(api(fakeHttp(new TypeError("fetch failed"))).read("a.md")).rejects.toBeInstanceOf(OfflineError);
  });
});

describe("tickets and vaults", () => {
  test("wsTicket posts with the key", async () => {
    const http = fakeHttp({ status: 200, body: { ticket: "kumbu_wst_x", expiresAt: "2026-10-27T10:00:30Z" } });
    expect(await api(http).wsTicket()).toBe("kumbu_wst_x");
    expect(http.last).toMatchObject({ method: "POST", url: "https://k.example/api/ws-ticket", headers: { Authorization: "Bearer kumbu_x" } });
  });
  test("vaults lists names and write rights", async () => {
    const http = fakeHttp({ status: 200, body: [
      { name: "Work", notes: 1, embeddings: "internal", pending: false, canWrite: true },
      { name: "Read", notes: 1, embeddings: "internal", pending: false, canWrite: false }] });
    expect(await api(http).vaults()).toEqual([{ name: "Work", canWrite: true }, { name: "Read", canWrite: false }]);
  });
});

describe("pairing", () => {
  test("pairing code normalisation", () => {
    expect(normalisePairingCode(" k7qm-4xda ")).toBe("K7QM4XDA");
    expect(normalisePairingCode("IOLo-0000")).toBe("1010" + "0000");
  });
  test("redeem posts code and device without Authorization", async () => {
    const http = fakeHttp({ status: 201, body: { key: "kumbu_k", vault: "Work", keyName: "Work – Obsidian Laptop" } });
    expect(await redeemPairing(http, "https://k.example/", "k7qm-4xda", "Laptop")).toEqual({ key: "kumbu_k", vault: "Work", keyName: "Work – Obsidian Laptop" });
    expect(http.last).toMatchObject({ method: "POST", url: "https://k.example/api/pairing/redeem" });
    expect(http.last!.headers.Authorization).toBeUndefined();
    expect(JSON.parse(http.last!.body!)).toEqual({ code: "K7QM4XDA", device: "Laptop" });
  });
  test("a wrong code says the server's sentence", async () => {
    const p = redeemPairing(fakeHttp({ status: 404, body: { error: "This pairing code is not valid (any more)." } }), "https://k.example", "x", "L");
    await expect(p).rejects.toBeInstanceOf(RejectedError);
    await expect(p).rejects.toThrow("This pairing code is not valid (any more).");
  });
  test("a wrong code without a sentence has a default", async () => {
    await expect(redeemPairing(fakeHttp({ status: 404 }), "https://k.example", "x", "L")).rejects.toThrow("This code is not valid (any more).");
  });
  test("too many attempts is rejected with the server's sentence", async () => {
    await expect(redeemPairing(fakeHttp({ status: 429, body: { error: "Too many attempts." } }), "https://k.example", "x", "L")).rejects.toThrow("Too many attempts.");
  });
});
