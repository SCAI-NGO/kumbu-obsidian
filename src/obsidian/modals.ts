// SPDX-License-Identifier: AGPL-3.0-or-later
// The first sync's one question, the list behind it, the result screen and the disconnect confirmation.
import { Modal, Setting, type App } from "obsidian";
import type { Choice, FirstSyncSummary, MergePlan } from "../engine/firstSync";
import { conflictCopyPath } from "../engine/paths";
import { choiceIntro, differTitle, hasAttachments, notSyncedSummary, resultHeadline } from "./texts";

/** Asks once for all differing notes (spec §6). Closing it without Continue cancels the first sync. */
export class ConflictChoiceModal extends Modal {
  private choice: Choice = "both";
  private resolve: ((c: Choice | null) => void) | null = null;

  constructor(app: App, private readonly plan: MergePlan, private readonly vault: string, private readonly device: string) {
    super(app);
  }

  choose(): Promise<Choice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    const n = this.plan.differing.length;
    const merging = this.plan.toUpload.length + this.plan.toDownload.length + this.plan.same.length;
    this.setTitle(differTitle(n, this.vault));
    const { contentEl } = this;
    contentEl.addClass("kumbu-sync-choice");
    contentEl.createEl("p", { text: choiceIntro(merging, n) });
    const example = conflictCopyPath(this.plan.differing[0] ?? "Plan.md", this.device, new Date());
    const options: [Choice, string, string][] = [
      ["both", "Keep both (safest)", `Kumbu² keeps its version; your local text becomes a copy next to it, e.g. ${example}`],
      ["local", "Keep local", "Your text replaces the Kumbu² version. The old one stays in Kumbu²'s history."],
      ["kumbu", "Keep Kumbu²", "The Kumbu² text replaces yours. Your local version goes to Obsidian's trash first."],
    ];
    const list = contentEl.createDiv({ cls: "kumbu-sync-options" });
    for (const [value, title, desc] of options) {
      const label = list.createEl("label", { cls: "kumbu-sync-option" });
      if (value === "both") label.addClass("is-recommended");
      const input = label.createEl("input", { type: "radio", attr: { name: "kumbu-sync-choice", value } });
      input.checked = value === this.choice;
      input.addEventListener("change", () => { if (input.checked) this.choice = value; });
      const text = label.createDiv();
      text.createDiv({ cls: "kumbu-sync-option-title", text: title });
      text.createDiv({ cls: "kumbu-sync-option-desc", text: desc });
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(`Show the ${n} notes`).onClick(() => {
        new NotesListModal(this.app, differTitle(n, this.vault), this.plan.differing).open();
      }))
      .addButton((b) => b.setButtonText("Continue").setCta().onClick(() => this.finish(this.choice)));
  }

  override onClose(): void {
    this.contentEl.empty();
    this.finish(null);
  }

  private finish(choice: Choice | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(choice);
    if (choice !== null) this.close();
  }
}

/** A read-only list of paths. */
export class NotesListModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly paths: string[]) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    const list = this.contentEl.createEl("ul", { cls: "kumbu-sync-paths" });
    for (const p of this.paths) list.createEl("li", { text: p });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Shown after every first sync, also when nothing went wrong (spec §3). */
export class ResultModal extends Modal {
  constructor(app: App, private readonly vault: string, private readonly summary: FirstSyncSummary) {
    super(app);
  }

  override onOpen(): void {
    const s = this.summary;
    this.setTitle(`Connected to ${this.vault}`);
    const { contentEl } = this;
    contentEl.addClass("kumbu-sync-result");
    contentEl.createEl("p", { cls: "kumbu-sync-headline", text: resultHeadline(s.conflictCopies) });
    const counts = contentEl.createDiv({ cls: "kumbu-sync-counts" });
    const notSynced = s.notSynced.filter((n) => n.reason !== "damaged-vault");
    for (const [label, value] of [["uploaded", s.uploaded], ["downloaded", s.downloaded], ["unchanged", s.unchanged], ["not synced", notSynced.length]] as const) {
      const cell = counts.createDiv({ cls: "kumbu-sync-count" });
      cell.createDiv({ cls: "kumbu-sync-count-value", text: String(value) });
      cell.createDiv({ cls: "kumbu-sync-count-label", text: label });
    }
    const summary = notSyncedSummary(notSynced);
    if (summary) contentEl.createEl("p", { text: summary + (hasAttachments(notSynced) ? " (Kumbu² keeps text only)" : "") });
    contentEl.createEl("p", { text: "From now on changes sync live." });
    new Setting(contentEl).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** A sentence and two buttons; resolves true for the action. */
export class ConfirmModal extends Modal {
  private resolve: ((ok: boolean) => void) | null = null;

  constructor(app: App, private readonly title: string, private readonly sentence: string, private readonly action: string) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.sentence });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setWarning().onClick(() => {
        this.answer(true);
        this.close();
      }));
  }

  override onClose(): void {
    this.contentEl.empty();
    this.answer(false);
  }

  private answer(ok: boolean): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(ok);
  }
}
