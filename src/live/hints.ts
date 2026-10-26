// SPDX-License-Identifier: AGPL-3.0-or-later
// The "vault changed" hints over a WebSocket, with backoff, a polling fallback and the hourly full check (spec §6).
import { AuthError, OfflineError, type Clock, type ConnectionMode } from "../engine/ports";
import { CLOSE_KEY_REVOKED, type HintMessage } from "../api/types";
import { trimServer } from "../api/client";

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface HintOptions {
  ticket: () => Promise<string>;
  wsUrl: (ticket: string) => string;
  open: (url: string) => SocketLike;
  vault: string;
  clock: Clock;
  random: () => number;
  check: (full: boolean) => void;
  onMode: (m: ConnectionMode) => void;
}

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60_000;
const POLL_AFTER_FAILURES = 3;
const POLL_MS = 2 * 60_000;
const FULL_CHECK_MS = 60 * 60_000;

/** https://host → wss://host/api/ws?ticket=…, http → ws. */
export function wsUrlFor(server: string, ticket: string): string {
  return `${trimServer(server).replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`;
}

export class HintConnection {
  private socket: SocketLike | null = null;
  private failures = 0;
  private stopped = true;
  private reconnectTimer: unknown = null;
  private pollTimer: unknown = null;
  private hourlyTimer: unknown = null;

  constructor(private readonly o: HintOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleHourly();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    for (const t of [this.reconnectTimer, this.pollTimer, this.hourlyTimer]) if (t !== null) this.o.clock.clearTimeout(t);
    this.reconnectTimer = this.pollTimer = this.hourlyTimer = null;
  }

  private async connect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.stopped) return;
    let ticket: string;
    try {
      ticket = await this.o.ticket();
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof AuthError) {
        // The engine's own next call meets the same 401 and reports it.
        this.stop();
        this.o.check(false);
        return;
      }
      this.failed(e instanceof OfflineError);
      return;
    }
    if (this.stopped) return;

    const socket = this.o.open(this.o.wsUrl(ticket));
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.failures = 0;
      this.stopPolling();
      this.o.onMode("live");
      // Whatever changed while there was no connection.
      this.o.check(false);
    };
    socket.onmessage = (e) => {
      if (socket !== this.socket) return;
      let message: Partial<HintMessage>;
      try {
        message = JSON.parse(e.data) as Partial<HintMessage>;
      } catch {
        return;
      }
      if (message.type === "changed" && message.vault === this.o.vault) this.o.check(false);
    };
    socket.onerror = () => undefined;
    socket.onclose = (e) => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (e.code === CLOSE_KEY_REVOKED) {
        this.stop();
        this.o.check(false);
        return;
      }
      this.failed(false);
    };
  }

  private failed(offline: boolean): void {
    this.failures++;
    if (this.failures >= POLL_AFTER_FAILURES) this.startPolling();
    if (offline) this.o.onMode("offline");
    else if (this.failures >= POLL_AFTER_FAILURES) this.o.onMode("polling");
    const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (this.failures - 1));
    this.reconnectTimer = this.o.clock.setTimeout(() => void this.connect(), this.o.random() * delay);
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    const poll = () => {
      this.pollTimer = this.o.clock.setTimeout(() => {
        this.o.check(false);
        poll();
      }, POLL_MS);
    };
    poll();
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) this.o.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleHourly(): void {
    this.hourlyTimer = this.o.clock.setTimeout(() => {
      this.o.check(true);
      this.scheduleHourly();
    }, FULL_CHECK_MS);
  }
}
