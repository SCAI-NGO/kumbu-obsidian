// SPDX-License-Identifier: AGPL-3.0-or-later
// The plugin: settings and state in data.json, the engine and the hints wired to the vault's events.
import { Notice, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import { KumbuApi, redeemPairing, trimServer } from "./api/client";
import { SyncEngine } from "./engine/engine";
import { defaultDeviceName, secretId, serverProblem } from "./engine/paths";
import { AuthError, OfflineError, type SyncState, type SyncStatus } from "./engine/ports";
import { HintConnection, wsUrlFor } from "./live/hints";
import { obsidianHttp } from "./obsidian/http";
import { ConfirmModal, ConflictChoiceModal, ResultModal } from "./obsidian/modals";
import { openSocket, windowClock } from "./obsidian/runtime";
import { forgetKey, readKey, secretsAvailable, storeKey } from "./obsidian/secret";
import { KumbuSettingTab } from "./obsidian/settingsTab";
import { StatusBar } from "./obsidian/statusBar";
import { VaultFiles } from "./obsidian/vaultFiles";

/** `ownsSecret`: the secret was stored by pairing (and is forgotten on disconnect), not picked by the user. */
export interface Settings { server: string; vault: string; device: string; secretId: string; ownsSecret: boolean; }
export interface PluginData { settings: Settings; state: SyncState; }

export const emptyState = (): SyncState => ({ bases: {}, cursor: null, lastFullAt: null, lastSyncAt: null });
const emptySettings = (): Settings => ({ server: "", vault: "", device: "", secretId: "", ownsSecret: false });

function platformName(): string {
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return "iOS";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isWin) return "Windows";
  return "Linux";
}

export default class KumbuSyncPlugin extends Plugin {
  data: PluginData = { settings: emptySettings(), state: emptyState() };
  engine: SyncEngine | null = null;
  api: KumbuApi | null = null;
  private hints: HintConnection | null = null;
  private statusBar: StatusBar | null = null;
  private tab: KumbuSettingTab | null = null;

  override async onload(): Promise<void> {
    this.data = normalise(await this.loadData());
    if (!secretsAvailable(this.app)) {
      new Notice("Kumbu² Sync needs Obsidian 1.11.4 or newer.");
      return;
    }
    if (!this.data.settings.device) this.data.settings.device = defaultDeviceName(platformName(), Math.random);

    this.tab = new KumbuSettingTab(this.app, this);
    this.addSettingTab(this.tab);
    this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.openSettings());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
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

  /**
   * Builds the engine and the hints for the connected vault and starts them; nothing when not connected.
   * A vault whose first sync never finished (no cursor yet) runs the first sync again, with its question.
   */
  async startSync(): Promise<void> {
    await this.stopSync();
    const s = this.data.settings;
    const key = readKey(this.app, s.secretId);
    if (!s.server || !s.vault || !s.device || key === null) {
      this.statusBar?.hide();
      return;
    }
    // data.json can be edited by hand or synced from elsewhere: the key never goes to a plain-http server.
    const problem = serverProblem(s.server);
    if (problem !== null) {
      new Notice(`Kumbu² Sync: ${problem}`);
      this.statusBar?.hide();
      return;
    }
    const api = new KumbuApi(obsidianHttp, s.server, s.vault, key);
    const engine = this.buildEngine(api);
    this.api = api;
    this.engine = engine;
    // Hints and polling run from the start: a reconnect after a network loss also retries an unfinished first sync.
    this.startHints(api, engine);
    if (this.data.state.cursor === null) {
      await this.firstSync(engine);
      return;
    }
    await engine.start();
  }

  /** An unfinished first sync is retried by the engine's check, with the choice already made. */
  async syncNow(): Promise<void> {
    if (this.engine) await this.engine.check(false);
    else await this.startSync();
  }

  /** Pairing: the code becomes a device key in SecretStorage, then the first sync runs. */
  async connectWithPairing(code: string): Promise<void> {
    const s = this.data.settings;
    const problem = serverProblem(s.server);
    if (problem !== null) {
      new Notice(problem);
      return;
    }
    let paired;
    try {
      paired = await redeemPairing(obsidianHttp, s.server, code, s.device);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : "The server can't be reached.");
      return;
    }
    const id = secretId(paired.vault, s.device, this.app.vault.getName());
    storeKey(this.app, id, paired.key);
    await this.connectTo(paired.vault, id, true);
  }

  /** The fallback: a key the user made by hand and keeps in SecretStorage themself. */
  async connectWithKey(id: string, vault: string): Promise<void> {
    await this.connectTo(vault, id, false);
  }

  async listVaults(id: string): Promise<{ name: string; canWrite: boolean }[]> {
    const key = readKey(this.app, id);
    if (key === null) throw new Error("This secret is empty.");
    return new KumbuApi(obsidianHttp, this.data.settings.server, "", key).vaults();
  }

  async disconnect(): Promise<void> {
    const ok = await new ConfirmModal(this.app, "Disconnect", "This stops syncing. Your files stay as they are.", "Disconnect").ask();
    if (!ok) return;
    await this.forgetConnection();
  }

  async saveAll(): Promise<void> {
    await this.saveData(this.data);
  }

  private async connectTo(vault: string, id: string, ownsSecret: boolean): Promise<void> {
    await this.stopSync();
    const s = this.data.settings;
    s.server = trimServer(s.server);
    s.vault = vault;
    s.secretId = id;
    s.ownsSecret = ownsSecret;
    this.data.state = emptyState();
    await this.saveAll();
    await this.startSync();
  }

  private async firstSync(engine: SyncEngine): Promise<void> {
    const s = this.data.settings;
    let summary;
    try {
      summary = await engine.firstSync((plan) => new ConflictChoiceModal(this.app, plan, s.vault, s.device).choose());
    } catch (e) {
      // Lost key: onAuthLost said so. Stopped (Disconnect, unload): nothing to say.
      if (e instanceof AuthError || this.engine !== engine) return;
      const why = e instanceof OfflineError ? e.message : "an unexpected error";
      new Notice(`Kumbu² Sync: the first sync stopped (${why}). It goes on by itself once the server can be reached.`);
      return;
    }
    // Cancelled: not connected, nothing kept but the server and the device name. (A finished one shows its
    // result through onFirstSyncDone, also when it finishes on a retry.)
    if (summary === null) await this.forgetConnection();
  }

  private async forgetConnection(): Promise<void> {
    await this.stopSync();
    const s = this.data.settings;
    if (s.ownsSecret) forgetKey(this.app, s.secretId);
    s.vault = "";
    s.secretId = "";
    s.ownsSecret = false;
    this.data.state = emptyState();
    await this.saveAll();
    this.statusBar?.hide();
    this.tab?.refresh();
  }

  private openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  private startHints(api: KumbuApi, engine: SyncEngine): void {
    const s = this.data.settings;
    this.hints?.stop();
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
    this.hints.start();
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
      onFirstSyncDone: (summary) => new ResultModal(this.app, this.data.settings.vault, summary).open(),
    });
  }

  private statusChanged(status: SyncStatus): void {
    this.statusBar?.update(status);
    if (!status.busy) this.tab?.refresh();
  }

  private authLost(): void {
    new Notice("Kumbu² Sync: this key expired or was revoked. Pair again in the settings.");
    void this.forgetConnection();
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
