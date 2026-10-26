// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

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
    files: ["src/engine/**", "src/api/**", "src/live/**"],
    rules: noObsidian,
  },
  {
    // Build tooling runs in Node, never in Obsidian.
    files: ["esbuild.config.mjs"],
    languageOptions: { globals: { process: "readonly" } },
    rules: { "obsidianmd/no-nodejs-modules": "off" },
  },
  {
    // Tests name ".obsidian" on purpose: it is the default config folder the paths must skip.
    // Tests run in Node, not in a popout window.
    files: ["test/**"],
    languageOptions: { globals: { setImmediate: "readonly" } },
    rules: { "obsidianmd/hardcoded-config-path": "off", "obsidianmd/prefer-window-timers": "off" },
  },
]);
