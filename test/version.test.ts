// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { byteSize, MAX_BYTES, normaliseText, versionOf } from "../src/engine/version";

test("version matches the server's token", async () => {
  // printf '# Plan\n' | sha256sum → c3964bb3b70a…
  expect(await versionOf("# Plan\n")).toBe("c3964bb3b70a");
  expect(await versionOf("# Plan\r\n")).toBe("c3964bb3b70a");
});
test("byte size counts UTF-8 after CRLF → LF", () => {
  expect(byteSize("ä\r\n")).toBe(3);
});
test("only CRLF is normalised", () => {
  expect(normaliseText("a\r\nb\rc\n")).toBe("a\nb\rc\n");
});
test("the size limit is 1 MiB", () => {
  expect(MAX_BYTES).toBe(1_048_576);
});
