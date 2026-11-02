# Overnighter brief: shared vaults in the plugin

Hi, thank you for taking this one on! This repository is the Obsidian sync plugin of Kumbu², a Markdown second brain served over MCP. The server can share a vault between people since its 0.3.0, and tonight's work is what the plugin needs to sync one: it sends its version when pairing, it stops taking an ordinary refusal for a revoked key (today a read-only member's first edit would stop the whole sync and forget the connection), and it keeps a person's device name from reaching the other people in a shared vault.

## What to read, in this order

1. This brief
2. Spec: `docs/superpowers/specs/2026-11-02-shared-vaults-design.md`. Its status line says "draft"; the maintainer has reviewed and approved it.
3. Plan: `docs/superpowers/plans/2026-11-02-shared-vaults.md`; start with Task 0. Its section "Where this plan goes beyond the spec" says where and why it differs from the spec, and its section "The server's contract" holds the server's exact JSON, as you have no access to that repository.

There is no `CLAUDE.md` in this repository; everything you need from one is here and in the plan. `README.md` describes the plugin.

## Where you run

- Branch `feature/plugin-0.2.0`; everything you push there survives, everything else does not.
- The cloud environment may lack tools. Installing what you need (SDKs, CLIs, packages) is fine; please do it without asking and note it in the report.
- Task 0 (setup plus first build and tests) should take about **15 minutes**, likely far less: CI does it all in about 30 seconds. If it takes much longer, something is off: note it and carry on if you can.
- Node 22 or newer (CI uses 22; `engines` says `>=22`). pnpm 10.28.0, as `packageManager` says: `npm install -g pnpm@10.28.0` if it is missing. No .NET here, and no server: the tests run against in-memory fakes in `test/fakes/`.
- Docker test containers: not needed.
- If superpowers skills are not available, please emulate subagent-driven development with the plain Agent tool.
- **Nothing here has been run yet.** The machine this was written on has neither node nor pnpm, so there was no dry run. The baseline numbers come from CI (run 41452071699: 18 test files, 317 tests). Plan and tests were checked by reading the code. A test that doesn't behave as the plan predicts is quite possible: trust the code you see, fix the test or the step, and note it.

## How to work

- Task by task as in the plan: a fresh subagent does red test, green, commit, then every mutation individually (break, watch it fail, restore with `git checkout -- <file>`). Then a spec-compliance review and a code-quality review, each by its own subagent. Then you, the controller, push.
- Subagent-driven: one fresh subagent per task. Subagents commit locally, and never merge, push or switch branches; only you, the controller, push.
- Commit and push after every task. Commit messages imperative and free-form ("Tell a refusal from a revoked key by its code"), no Conventional Commits prefix, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Full verification at the end of each task that touches `src/`, and at the very end, as CI does: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`. `pnpm build` is the type check (`tsc --noEmit` first, also over `test/` and `e2e/`); a test run alone doesn't give it, as Vitest doesn't type-check. Known failures before you start: none.
- One file's tests: `pnpm exec vitest run test/<file>.test.ts`; one test: add `-t "<part of its name>"`.
- Only `pnpm test`, `pnpm lint` and `pnpm build` output count as evidence.
- `pnpm e2e` needs a live server and is not part of CI: please don't try to run it. `pnpm build` still type-checks `e2e/`.
- **Style:** British English in code, comments, docs, commits and test names. Match the surrounding code's naming, idiom and sparse comments; comments only where the reasoning isn't obvious. New source files start with `// SPDX-License-Identifier: AGPL-3.0-or-later`. `src/engine/`, `src/api/` and `src/live/` import nothing from Obsidian.
- **Nothing committed names an organisation, customer or employer**: code, docs, test data, examples. Use Alice, Bob, `Work`, `Beet`, `Laptop`, `Phone`.
- **Clients branch on `code` and `type`, never on the sentence.**
- **Uncertainty is welcome.** When spec and plan leave something open, decide it, say so in a commit message, and list it in the report. If the spec or the plan seems wrong, build the safer reading (local text is never lost; not knowing means the device name is left out), write down why, and carry on. The plan's line numbers are from `5481746` and drift as you go; the code it quotes counts.

## A few things that matter to us

- **Please do not merge, tag, release or deploy**, and leave `gitops-*`/`argocd-*` and devices alone: rollout is something Chris does together with a person. The maintainer sets the tag; a tag starts the release workflow.
- **No version change.** `manifest.json`, `package.json` and `versions.json` say 0.2.0 already, deliberately: an earlier release with that number held no changes and was deleted.
- No secrets in logs, assertions, test data or the report. The test key is the existing fake `kumbu_x`.
- Specs outside this topic stay as they are, and so does this one; if one looks wrong, mention it in the report.
- **Final decision of the maintainer, not to be reopened:** if it can't be known whether a vault is shared (the list failed, the vault isn't listed, the field is absent), the device name is left out. It fails closed.
- **Local text is never lost.** A test that shows otherwise (the plan's Task 5 pins this) is a reason to stop and work out why, not to adjust the test.
- **Security boundary:** this repository has no separate security review process, so here is the line.
  - **Touched:** how a 403 is read (`expectOk` in `src/api/client.ts`: a 403 with a `code` no longer counts as a lost key; without one it still does; so does every 401). What a conflict copy says, in its name and its text (`src/engine/paths.ts`, `src/engine/conflict.ts`, `src/engine/engine.ts`): this keeps a person's device name from reaching the other people in a shared vault, and it outlives their membership, so it is the part to be careful with. The plugin's version is added to the pairing request.
  - **Not touched, on purpose:** key handling. How the key is stored and forgotten (`src/obsidian/secret.ts`), the `Authorization` header, the https rule for where a key may be sent (`serverProblem`), the revoking of a key (`revokeSelf`, whose `client.ts:167` treats any 403 as revoked on purpose), `onAuthLost` and what it forgets. No new dependency, no cryptographic code.
  - **Also unchanged:** the device name still goes to the server when pairing, where it becomes the key's name; what the server shows of it is the server's matter. In a vault that isn't shared, copies still name the device, exactly as today.
- **At the end:** the report and the draft pull request (the plan's Task 10). There is no `open-items.md` in this repository, and no `STATUS` file: the pull request is the signal.

## Out of scope

- A renamed vault: the plugin asks by the old name, gets 404 and stops with its existing sentence; pairing again is accepted.
- Retrying a refused change when the rights change. It isn't sent again until the file changes or the plugin restarts; the plan says so, and the report should too.
- Conflict copies made before a vault was shared: they keep their old names and text.
- The settings' "I have an API key already" flow, which lists only vaults the key can write to (`src/obsidian/settingsTab.ts:101`).
- The server (`kumbukumbu`, a separate repository): its side is built.
- Publishing the release, and any documentation beyond what the plan's Task 9 changes in `README.md`.

## The report

Last commit: `docs/superpowers/overnighter/2026-11-02-shared-vaults-report.md` with:

- the environment;
- Task 0 planned against measured;
- per task the commit and the real test output;
- every mutation individually, with the test that caught it, or "not caught";
- deviations and the calls you made, including where the plan's predictions were wrong;
- surprises;
- open points for Chris, with **what he must check by hand** first, as nothing here has run in Obsidian or against a real server (the plan's Task 10 lists it);
- the PR link.

Then open a **draft** pull request from `feature/plugin-0.2.0` to `master`. **Do not merge it.** Its body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. If no pull request can be opened, put the compare URL `https://github.com/SCAI-NGO/kumbu-obsidian/compare/master...feature/plugin-0.2.0` in the report.

## When you are done or stuck

Send a short message via `PushNotification` if it is available; otherwise the PR is the signal, and the report says so. If you get stuck, push what you have, write down in the report where and why, and stop there. A clear account of being stuck is worth more than a guess. Getting through the refusals (Tasks 1 to 5) with everything green and honestly reported is already a good night's work.
