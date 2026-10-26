// SPDX-License-Identifier: AGPL-3.0-or-later
// The plugin: settings and state in data.json, the engine and the hints wired to the vault's events.
import { Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import { KumbuApi } from "./api/client";
import { SyncEngine } from "./engine/engine";
import type { SyncState, SyncStatus } from "./engine/ports";
import { HintConnection, wsUrlFor } from "./live/hints";
import { obsidianHttp } from "./obsidian/http";
import { openSocket, windowClock } from "./obsidian/runtime";
import { readKey, secretsAvailable } from "./obsidian/secret";
import { VaultFiles } from "./obsidian/vaultFiles";

export interface Settings { server: string; vault: string; device: string; secretId: string; }
export interface PluginData { settings: Settings; state: SyncState; }

export const emptyState = (): SyncState => ({ bases: {}, cursor: null, lastFullAt: null, lastSyncAt: null });
const emptySettings = (): Settings => ({ server: "", vault: "", device: "", secretId: "" });

export default class KumbuSyncPlugin extends Plugin {
  data: PluginData = { settings: emptySettings(), state: emptyState() };
  engine: SyncEngine | null = null;
  api: KumbuApi | null = null;
  private hints: HintConnection | null = null;

  override async onload(): Promise<void> {
    this.data = normalise(await this.loadData());
    if (!secretsAvailable(this.app)) {
      new Notice("Kumbu² Sync needs Obsidian 1.11.4 or newer.");
      return;
    }

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.engine?.check(false) });
    this.registerEvent(this.app.vault.on("create", (f) => this.ifFile(f, (p) => this.engine?.localChanged(p))));
    this.registerEvent(this.app.vault.on("modify", (f) => this.ifFile(f, (p) => this.engine?.localChanged(p))));
    this.registerEvent(this.app.vault.on("delete", (f) => this.ifFile(f, (p) => this.engine?.localDeleted(p))));
    this.registerEvent(this.app.vault.on("rename", (f, old) => this.ifFile(f, (p) => this.engine?.localRenamed(old, p))));
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "visible") void this.engine?.check(true);
    });
    // After the layout is ready, so the start-up scan of the vault doesn't fire "create" for every file.
    this.app.workspace.onLayoutReady(() => void this.startSync());
  }

  override onunload(): void {
    void this.stopSync();
  }

  get connected(): boolean {
    const s = this.data.settings;
    return s.server !== "" && s.vault !== "" && s.device !== "" && readKey(this.app, s.secretId) !== null;
  }

  /** Builds the engine and the hints for the connected vault and starts them; nothing when not connected. */
  async startSync(): Promise<void> {
    await this.stopSync();
    const s = this.data.settings;
    const key = readKey(this.app, s.secretId);
    if (!s.server || !s.vault || !s.device || key === null) return;
    const api = new KumbuApi(obsidianHttp, s.server, s.vault, key);
    const engine = this.buildEngine(api);
    this.api = api;
    this.engine = engine;
    this.hints = new HintConnection({
      ticket: () => api.wsTicket(),
      wsUrl: (ticket) => wsUrlFor(s.server, ticket),
      open: openSocket,
      vault: s.vault,
      clock: windowClock,
      random: Math.random,
      check: (full) => void engine.check(full),
      onMode: (mode) => engine.setConnectionMode(mode),
    });
    await engine.start();
    this.hints?.start();
  }

  async stopSync(): Promise<void> {
    this.hints?.stop();
    this.hints = null;
    const engine = this.engine;
    this.engine = null;
    this.api = null;
    await engine?.stop();
  }

  buildEngine(api: KumbuApi): SyncEngine {
    return new SyncEngine({
      vault: this.data.settings.vault,
      device: this.data.settings.device,
      local: new VaultFiles(this.app),
      remote: api,
      state: {
        load: () => Promise.resolve(structuredClone(this.data.state)),
        save: async (state) => {
          this.data.state = structuredClone(state);
          await this.saveData(this.data);
        },
      },
      clock: windowClock,
      onStatus: (status) => this.statusChanged(status),
      onConflict: (original, copy) => {
        new Notice(`Kumbu² Sync: ${original} was changed on both sides. Your text is in ${copy}.`);
      },
      onAuthLost: () => this.authLost(),
    });
  }

  /** Task 10 shows this in the status bar and the settings. */
  protected statusChanged(_status: SyncStatus): void {}

  protected authLost(): void {
    new Notice("Kumbu² Sync: this key expired or was revoked. Pair again in the settings.");
    void this.stopSync();
  }

  private ifFile(file: TAbstractFile, then: (path: string) => void): void {
    if (file instanceof TFile) then(file.path);
  }
}

function normalise(raw: unknown): PluginData {
  const data = (raw ?? {}) as Partial<PluginData>;
  return {
    settings: { ...emptySettings(), ...(data.settings ?? {}) },
    state: { ...emptyState(), ...(data.state ?? {}), bases: { ...(data.state?.bases ?? {}) } },
  };
}
