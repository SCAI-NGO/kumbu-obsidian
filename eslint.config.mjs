// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

const noObsidian = {
  "no-restricted-imports": ["error", {
    paths: [{ name: "obsidian", message: "The engine, the API client and the hints run without Obsidian." }],
  }],
};

export default defineConfig([
  globalIgnores(["main.js", "node_modules/", "coverage/", ".superpowers/"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
        },
      },
    },
  },
  {
    rules: {
      // The product's names keep their casing in the middle of a sentence, like "Obsidian Sync".
      "obsidianmd/ui/sentence-case": ["warn", { brands: [...DEFAULT_BRANDS, "Kumbu²", "Kumbu² Sync", "Connect Obsidian", "K7QM-4XDA"] }],
    },
  },
  {
    // Chris decided: "Keep Kumbu²" always puts the local text in Obsidian's .trash, whatever the user's trash
    // setting; only this adapter calls Vault.trash, for that one case (VaultFiles.trashToLocal).
    files: ["src/obsidian/vaultFiles.ts"],
    rules: { "obsidianmd/prefer-file-manager-trash-file": "off" },
  },
  {
    // minAppVersion is 1.11.4: display() and setWarning() are what that version has; their 1.13 successors
    // (getSettingDefinitions, setDestructive) would not run there.
    files: ["src/obsidian/settingsTab.ts", "src/obsidian/modals.ts"],
    rules: { "@typescript-eslint/no-deprecated": "off", "obsidianmd/settings-tab/prefer-setting-definitions": "off" },
  },
  {
    files: ["src/engine/**", "src/api/**", "src/live/**"],
    rules: noObsidian,
  },
  {
    // Build tooling runs in Node, never in Obsidian.
    files: ["esbuild.config.mjs", "vitest.config.ts"],
    languageOptions: { globals: { process: "readonly" } },
    rules: { "obsidianmd/no-nodejs-modules": "off" },
  },
  {
    // Tests name ".obsidian" on purpose: it is the default config folder the paths must skip.
    // Tests run in Node, not in a popout window.
    files: ["test/**"],
    languageOptions: { globals: { setImmediate: "readonly", process: "readonly" } },
    rules: { "obsidianmd/hardcoded-config-path": "off", "obsidianmd/prefer-window-timers": "off" },
  },
]);
