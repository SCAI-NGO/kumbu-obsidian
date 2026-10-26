// SPDX-License-Identifier: AGPL-3.0-or-later
// The "obsidian" package ships types only; tests resolve it here and mock what they use.
export const requestUrl = (): never => {
  throw new Error("requestUrl is mocked per test");
};
export class Notice { constructor(readonly message: string) {} }
export const Platform = { isMacOS: false, isWin: false, isLinux: true, isMobileApp: false, isAndroidApp: false, isIosApp: false, isDesktopApp: true };
