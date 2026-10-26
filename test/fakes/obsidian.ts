// SPDX-License-Identifier: AGPL-3.0-or-later
// The "obsidian" package ships types only; tests resolve it here and mock what they use.
export const requestUrl = (): never => {
  throw new Error("requestUrl is mocked per test");
};
export class Notice { constructor(readonly message: string) {} }
export const Platform = { isMacOS: false, isWin: false, isLinux: true, isMobileApp: false, isAndroidApp: false, isIosApp: false, isDesktopApp: true };
export class TAbstractFile { constructor(public path: string) {} }
export class TFile extends TAbstractFile { stat = { size: 0 }; }
export class TFolder extends TAbstractFile {}

/** An open editor: `buffer` is what the user sees, `saved` is set once save() wrote it to disk. */
export class MarkdownView {
  saves = 0;
  constructor(public file: TFile | null, public buffer: string, private readonly onSave: (text: string) => void) {}
  getViewData(): string { return this.buffer; }
  save(): Promise<void> {
    this.saves++;
    this.onSave(this.buffer);
    return Promise.resolve();
  }
}
