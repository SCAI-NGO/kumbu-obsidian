// SPDX-License-Identifier: AGPL-3.0-or-later
// HttpFn over Obsidian's requestUrl: no CORS, works on mobile (spec §8); text and binary bodies alike.
import { requestUrl } from "obsidian";
import type { HttpFn } from "../api/client";
import { OfflineError } from "../engine/ports";

export const obsidianHttp: HttpFn = async (r) => {
  let response;
  try {
    response = await requestUrl({
      url: r.url,
      method: r.method,
      headers: r.headers,
      body: r.body,
      contentType: r.headers["Content-Type"],
      // requestUrl throws on 4xx by default; the client needs the status and the server's sentence.
      throw: false,
    });
  } catch (e) {
    throw new OfflineError(e instanceof Error ? e.message : "The request failed.");
  }
  let text = "";
  let bytes: ArrayBuffer | undefined;
  try {
    // The body as it came: an attachment's bytes; the text below is the same body decoded.
    bytes = response.arrayBuffer;
    text = response.text;
  } catch {
    // An answer without a body (204, 304).
  }
  return { status: response.status, headers: response.headers, text, bytes };
};
