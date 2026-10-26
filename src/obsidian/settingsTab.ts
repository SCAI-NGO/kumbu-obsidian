// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings → Kumbu² Sync: pairing (or a key made by hand) when not connected, the sync's state when connected.
import { Notice, PluginSettingTab, SecretComponent, Setting, type App } from "obsidian";
import type KumbuSyncPlugin from "../main";
import { isValidDeviceName, serverProblem } from "../engine/paths";
import { reasonText } from "./texts";

const DEVICE_RULE = "A device name has 1 to 32 letters, digits, spaces, dashes or underscores.";

export class KumbuSettingTab extends PluginSettingTab {
  private code = "";
  private pickedSecret: string | null = null;
  private pickedVault: string | null = null;
  private busy = false;

  constructor(app: App, private readonly plugin: KumbuSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // The tab already carries the plugin's name; a heading repeating it is against Obsidian's guidelines.
    containerEl.createEl("p", { cls: "setting-item-description", text: "Keeps this vault in sync with a Kumbu² vault." });
    if (this.plugin.connected) this.showConnected(containerEl);
    else this.showNotConnected(containerEl);
  }

  /** Redraws when open, for status changes. */
  refresh(): void {
    if (this.containerEl.isShown() && !this.busy) this.display();
  }

  private showNotConnected(el: HTMLElement): void {
    const s = this.plugin.data.settings;
    new Setting(el).setName("Server URL").setDesc("HTTPS, or HTTP for localhost only").addText((t) => t
      .setPlaceholder("https://kumbu.example.org")
      .setValue(s.server)
      .onChange(async (v) => {
        s.server = v.trim();
        await this.plugin.saveAll();
      }));
    new Setting(el).setName("Device name").setDesc("Shown in conflict copies and the key name").addText((t) => t
      .setValue(s.device)
      .onChange(async (v) => {
        s.device = v.trim();
        await this.plugin.saveAll();
      }));
    new Setting(el).setName("Pairing code").setDesc("From \"Connect Obsidian\" in the web app").addText((t) => t
      .setPlaceholder("K7QM-4XDA")
      .setValue(this.code)
      .onChange((v) => { this.code = v; }));
    new Setting(el).addButton((b) => b.setButtonText("Connect").setCta().onClick(async () => {
      if (!this.valid()) return;
      if (!this.code.trim()) {
        new Notice("Enter the pairing code from the web app.");
        return;
      }
      let paired = false;
      await this.whileBusy(b.buttonEl, async () => { paired = await this.plugin.connectWithPairing(this.code); });
      if (paired) this.code = "";
      this.display();
    }));

    const fallback = el.createEl("details", { cls: "kumbu-sync-fallback" });
    fallback.createEl("summary", { text: "I have an API key already" });
    new Setting(fallback).setName("API key").setDesc("A key with write access, made on the API keys page").addComponent((c) =>
      new SecretComponent(this.app, c).setValue(this.pickedSecret ?? "").onChange((id) => {
        this.pickedSecret = id;
        this.pickedVault = null;
        void this.showVaults(vaults, fallbackConnect);
      }));
    const vaults = fallback.createDiv();
    const fallbackConnect = new Setting(fallback).addButton((b) => b.setButtonText("Connect").onClick(async () => {
      if (!this.valid()) return;
      if (!this.pickedSecret || !this.pickedVault) {
        new Notice("Pick an API key and a vault first.");
        return;
      }
      const secret = this.pickedSecret;
      const vault = this.pickedVault;
      await this.whileBusy(b.buttonEl, () => this.plugin.connectWithKey(secret, vault));
      this.display();
    }));
    fallbackConnect.settingEl.hide();
    if (this.pickedSecret) void this.showVaults(vaults, fallbackConnect);
  }

  private async showVaults(el: HTMLElement, connect: Setting): Promise<void> {
    el.empty();
    connect.settingEl.hide();
    const id = this.pickedSecret;
    if (!id) return;
    const problem = serverProblem(this.plugin.data.settings.server);
    if (problem !== null) {
      el.createEl("p", { cls: "kumbu-sync-muted", text: problem });
      return;
    }
    let vaults: { name: string; canWrite: boolean }[];
    try {
      vaults = (await this.plugin.listVaults(id)).filter((v) => v.canWrite);
    } catch (e) {
      el.createEl("p", { cls: "kumbu-sync-muted", text: e instanceof Error ? e.message : "The server can't be reached." });
      return;
    }
    if (vaults.length === 0) {
      el.createEl("p", { cls: "kumbu-sync-muted", text: "This key can't write to any vault." });
      return;
    }
    this.pickedVault ??= vaults[0]!.name;
    new Setting(el).setName("Vault").addDropdown((d) => {
      for (const v of vaults) d.addOption(v.name, v.name);
      d.setValue(this.pickedVault ?? "").onChange((v) => { this.pickedVault = v; });
    });
    connect.settingEl.show();
  }

  private showConnected(el: HTMLElement): void {
    const s = this.plugin.data.settings;
    const status = this.plugin.engine?.status();
    new Setting(el).setName("Server").setDesc(s.server);
    new Setting(el).setName("Vault").setDesc(s.vault);
    new Setting(el).setName("Device").setDesc(s.device);
    const last = status?.lastSyncAt ?? this.plugin.data.state.lastSyncAt;
    new Setting(el).setName("Last sync").setDesc(last ? new Date(last).toLocaleString() : "Not yet");
    new Setting(el).setName("Connection").setDesc(status ? status.mode : "Starting");

    const notSynced = status?.notSynced ?? [];
    if (notSynced.length > 0) {
      new Setting(el).setName("Not synced").setHeading();
      for (const n of notSynced) new Setting(el).setName(n.path || "Kumbu² vault").setDesc(reasonText(n));
    }
    const conflicts = status?.conflicts ?? [];
    if (conflicts.length > 0) {
      new Setting(el).setName("Open conflict copies").setDesc("Merge what you need into the original, then delete the copy.").setHeading();
      for (const c of conflicts) new Setting(el).setName(c);
    }

    new Setting(el)
      .addButton((b) => b.setButtonText("Sync now").onClick(() => void this.plugin.syncNow()))
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(async () => {
        await this.plugin.disconnect();
        this.display();
      }));
  }

  private valid(): boolean {
    const s = this.plugin.data.settings;
    const problem = serverProblem(s.server);
    if (problem !== null) {
      new Notice(problem);
      return false;
    }
    if (!isValidDeviceName(s.device)) {
      new Notice(DEVICE_RULE);
      return false;
    }
    return true;
  }

  private async whileBusy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    this.busy = true;
    button.disabled = true;
    try {
      await work();
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }
}
