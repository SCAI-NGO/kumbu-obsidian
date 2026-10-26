// SPDX-License-Identifier: AGPL-3.0-or-later
// The API key lives only in Obsidian's SecretStorage (spec §8); data.json holds the secret's id.
import type { App } from "obsidian";

export function secretsAvailable(app: App): boolean {
  // Missing below Obsidian 1.11.4, which the manifest requires but an old app may still load.
  return (app as Partial<App>).secretStorage !== undefined;
}

export function readKey(app: App, id: string): string | null {
  if (!id) return null;
  const key = app.secretStorage.getSecret(id);
  return key ? key : null;
}

export function storeKey(app: App, id: string, key: string): void {
  app.secretStorage.setSecret(id, key);
}

/** SecretStorage has no delete in the 1.11.4 API: an empty secret counts as none. */
export function forgetKey(app: App, id: string): void {
  if (id) app.secretStorage.setSecret(id, "");
}
