// SPDX-License-Identifier: AGPL-3.0-or-later
// The window's timers and WebSocket in the shapes the engine and the hints take.
import type { SocketLike } from "../live/hints";
import type { Clock } from "../engine/ports";

export const windowClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export function openSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    close: () => ws.close(),
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (e: MessageEvent) => socket.onmessage?.({ data: typeof e.data === "string" ? e.data : "" });
  ws.onclose = (e: CloseEvent) => socket.onclose?.({ code: e.code });
  ws.onerror = () => socket.onerror?.();
  return socket;
}
