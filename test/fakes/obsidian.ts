// SPDX-License-Identifier: AGPL-3.0-or-later
// The "obsidian" package ships types only; tests resolve it here and mock what they use.
export const requestUrl = (): never => {
  throw new Error("requestUrl is mocked per test");
};
export class Notice { constructor(readonly message: string) {} }
export const Platform = { isMacOS: false, isWin: false, isLinux: true, isMobileApp: false, isAndroidApp: false, isIosApp: false, isDesktopApp: true };
export class TAbstractFile { constructor(public path: string) {} }
export class TFile extends TAbstractFile { stat = { size: 0, mtime: 0 }; }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }

/** The parts of Obsidian's Editor the adapter uses, over a view's buffer. */
export class FakeEditor {
  cursor = 0;
  scroll = { top: 0, left: 0 };
  sets = 0;
  constructor(private readonly view: MarkdownView) {}
  getValue(): string { return this.view.buffer; }
  setValue(text: string): void { this.sets++; this.view.buffer = text; this.cursor = 0; this.scroll = { top: 0, left: 0 }; }
  getCursor(): { line: number; ch: number } { return this.offsetToPos(this.cursor); }
  setCursor(pos: { line: number; ch: number }): void { this.cursor = this.posToOffset(pos); }
  posToOffset(pos: { line: number; ch: number }): number {
    const lines = this.view.buffer.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) offset += lines[i]!.length + 1;
    return offset + pos.ch;
  }
  offsetToPos(offset: number): { line: number; ch: number } {
    const before = this.view.buffer.slice(0, offset).split("\n");
    return { line: before.length - 1, ch: before[before.length - 1]!.length };
  }
  getScrollInfo(): { top: number; left: number } { return this.scroll; }
  scrollTo(x?: number | null, y?: number | null): void { this.scroll = { left: x ?? 0, top: y ?? 0 }; }
}

/**
 * An open editor: `buffer` is what the user sees. save() is asynchronous like Obsidian's (a disk write): it takes
 * the buffer when called, runs `whileSaving` (a keystroke in the gap), then writes what it took.
 */
export class MarkdownView {
  saves = 0;
  whileSaving: (() => void) | null = null;
  readonly editor: FakeEditor;
  constructor(public file: TFile | null, public buffer: string, private readonly onSave: (text: string) => void) {
    this.editor = new FakeEditor(this);
  }
  getViewData(): string { return this.buffer; }
  async save(): Promise<void> {
    this.saves++;
    const text = this.buffer;
    await Promise.resolve();
    this.whileSaving?.();
    this.whileSaving = null;
    this.onSave(text);
  }
}
