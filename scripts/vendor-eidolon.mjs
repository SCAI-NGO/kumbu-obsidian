// SPDX-License-Identifier: AGPL-3.0-or-later
// The sync engine, the API client, the hints and their test fakes live in Kumbu²'s Eidolon core
// (packages/eidolon-core in the kumbukumbu repository); this plugin keeps a copy of them, unchanged.
//
//   node scripts/vendor-eidolon.mjs [<kumbukumbu checkout>]          copy them from the commit in eidolon-core.json
//   node scripts/vendor-eidolon.mjs --check [<kumbukumbu checkout>]  fail if the copy differs from that commit
//
// Without a checkout, the commit is fetched from the repository eidolon-core.json names.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const here = join(import.meta.dirname, "..");
const core = "packages/eidolon-core";
/** Folders taken whole, so a file removed there goes here too; and single files beside the plugin's own. */
const FOLDERS = [["src/engine", "src/engine"], ["src/api", "src/api"], ["src/live", "src/live"]];
const FILES = ["test/fakes/fakeFiles.ts", "test/fakes/fakeServer.ts", "test/fakes/harness.ts"].map((p) => [p, p]);

const args = process.argv.slice(2);
const check = args.includes("--check");
const given = args.find((a) => a !== "--check");
const { repository, commit } = JSON.parse(readFileSync(join(here, "eidolon-core.json"), "utf8"));
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`eidolon-core.json names no full commit hash ("${commit}").`);

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
let source;
let cleanup = () => {};
if (given === undefined) {
  source = mkdtempSync(join(tmpdir(), "eidolon-"));
  cleanup = () => rmSync(source, { recursive: true, force: true });
  git(source, "init", "--quiet");
  git(source, "fetch", "--quiet", "--depth=1", repository, commit);
  git(source, "checkout", "--quiet", "FETCH_HEAD");
} else {
  source = given;
}

try {
  const files = (root, dir) => existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => relative(root, join(e.parentPath, e.name))).sort()
    : [];
  const pairs = [];
  for (const [from, to] of FOLDERS) {
    const theirs = files(join(source, core), from).map((p) => relative(from, p));
    const ours = files(here, to).map((p) => relative(to, p));
    for (const p of new Set([...theirs, ...ours])) pairs.push([join(from, p), join(to, p)]);
  }
  pairs.push(...FILES);

  const read = (path) => (existsSync(path) ? readFileSync(path) : null);
  const differ = pairs.filter(([from, to]) => {
    const a = read(join(source, core, from));
    const b = read(join(here, to));
    return a === null || b === null || !a.equals(b);
  });

  if (check) {
    if (differ.length > 0) {
      console.error(`The plugin's copy of the Eidolon core differs from ${commit.slice(0, 12)}:\n${differ.map(([, to]) => `  ${to}`).join("\n")}\n`
        + "Change these files in kumbukumbu's packages/eidolon-core, then run node scripts/vendor-eidolon.mjs.");
      process.exitCode = 1;
    } else {
      console.log(`The copy of the Eidolon core matches ${commit.slice(0, 12)}.`);
    }
  } else {
    for (const [, to] of FOLDERS) rmSync(join(here, to), { recursive: true, force: true });
    for (const [from, to] of pairs) {
      if (existsSync(join(source, core, from))) cpSync(join(source, core, from), join(here, to));
      else rmSync(join(here, to), { force: true });
    }
    console.log(`Copied the Eidolon core of ${commit.slice(0, 12)}: ${differ.length} file(s) changed.`);
  }
} finally {
  cleanup();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
