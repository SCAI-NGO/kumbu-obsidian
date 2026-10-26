// SPDX-License-Identifier: AGPL-3.0-or-later
// "Kumbu² ● live · 3 not synced" in the status bar; a click opens the settings.
import type { SyncStatus } from "../engine/ports";
import { statusText } from "./texts";

export { statusText };

export class StatusBar {
  constructor(private readonly el: HTMLElement, onClick: () => void) {
    el.addClass("kumbu-sync-status", "mod-clickable");
    el.addEventListener("click", onClick);
    this.hide();
  }

  update(s: SyncStatus): void {
    this.el.removeClass("kumbu-sync-hidden");
    this.el.setText(statusText(s));
    this.el.toggleClass("is-offline", s.mode === "offline");
    this.el.setAttr("aria-label", s.busy ? "Syncing" : s.lastSyncAt ? `Last sync ${new Date(s.lastSyncAt).toLocaleString()}` : "Not synced yet");
  }

  hide(): void {
    this.el.addClass("kumbu-sync-hidden");
  }
}
