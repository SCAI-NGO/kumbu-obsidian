# End-to-end race run

`pnpm e2e` runs the real sync engine, API client and live hints in Node against a running Kumbu² server and checks that both sides end up the same.

What it does:

1. Seeds a fresh temp folder with 30 notes and the test vault with 30 notes (through the agent's key). 15 paths are on both sides: 7 with the same text and 8 with different text. Among the paths are umlauts and folders (`Besprechung März.md`, `Ärger/über die Sache.md`, `Projekte/Tief/Notiz.md`).
2. Runs the first sync with "Keep both" and expects 15 uploaded, 15 downloaded, 7 unchanged and 8 conflict copies.
3. Runs 3 minutes of seeded random operations at 2–5 a second. The device side edits, trashes and renames files on disk and tells the engine, as Obsidian's vault events would. The agent side edits (read, then a versioned `PUT`), deletes and moves notes over the REST API with its own key, the same `NoteWriter` path that MCP's write tools use. The engine gets its hints over the real WebSocket. Every edit appends one unique line, its marker (`user 17`, `agent 18`). Every delete records the text it removed: the file's text for a user delete, the note read at the version that is then deleted for an agent delete.
4. Waits 15 s and checks **phase 1**, the live path alone (hints, `since` answers, uploads). Then it runs a full check and checks **phase 2**. Each phase asserts two things:
   - **Convergence:** every `.md` file outside dot folders equals the note at the same path in Kumbu², and no note is missing on either side.
   - **No lost edit:** every marker is in some note, conflict copy or `.trash` file, unless a recorded delete removed it. An engine that overwrites text it hasn't seen leaves both sides agreeing, and only this check catches it.
5. Checks every conflict copy made during the run. It must be explained by the **last** user operation on its path before the copy, and an agent write on that path that the server took. That write must have landed from 1.5 s before the user operation until whichever came first: the device's next write of that path reaching the server, or the copy itself. Any other copy counts as unexpected. The rules are in `e2e/rules.ts`, with tests in `test/e2eRules.test.ts`.

It exits with 0 and prints `converged: 0 unexpected conflict copies, 0 edits lost` when everything holds. It also prints which phases converged. Otherwise it exits with 1 and lists the differing paths per phase, the lost markers with the path each was written to, and, for each unexpected copy, the operations, device writes and copies on its path with their times.

### Showing that the checks fail

`E2E_FAULT` puts a deliberate bug into the harness (comma-separated):

- `lww`: on a 409 the device overwrites the server's text (last writer wins). With hints the engine almost always sees an agent's edit before it uploads, so this alone rarely bites.
- `drop-hints`: every hint is ignored, so only the final full check brings the agent's changes over. Phase 1 fails.
- `lww,drop-hints`: most uploads meet a 409 and overwrite. Phase 2 still converges, but edits are lost, and the run fails on them.

## Environment

| Variable | Meaning |
|---|---|
| `KUMBU_URL` | The server, e.g. `http://localhost:8080` |
| `KUMBU_VAULT` | An **empty** test vault. The run refuses a vault that has notes, unless `E2E_CLEAN=1` |
| `KUMBU_DEVICE_KEY` | A write key on that vault for the device (a pairing key or one made by hand) |
| `KUMBU_AGENT_KEY` | A second write key on the same vault, standing in for the agent |
| `E2E_SEED` | Optional: the seed for the operations (printed at the start). Timing still varies between runs |
| `E2E_SECONDS` | Optional: how long the operations run, default 180 |
| `E2E_QUIET_SECONDS` | Optional: the quiet time before the full check, default 15 |
| `E2E_CLEAN` | Optional: `1` trashes every note in the vault before seeding, so a vault can be used again |
| `E2E_FAULT` | Optional: a deliberate bug, see above. Never set for a real run |

`E2E_SEED`, `E2E_SECONDS` and `E2E_QUIET_SECONDS` must be whole numbers. Anything else stops the run with exit code 2.

Make the keys in the web app (Settings, API keys, with write access to the test vault only), or over the API as shown below. Never point the run at a vault with real notes: it edits, moves and trashes at random.

## Against the compose stack

In the kumbukumbu checkout run `docker compose up -d`. Then sign in, make a vault `E2E` and two write keys on it in the web app, and run:

```sh
KUMBU_URL=http://localhost:8080 KUMBU_VAULT=E2E \
KUMBU_DEVICE_KEY=kumbu_… KUMBU_AGENT_KEY=kumbu_… pnpm e2e
```

## Against a server run from source (no Docker image)

This is how the run was done for 0.1.0, where image builds could not reach the npm registry. You need a MongoDB replica set, e.g. `docker run -d -p 27108:27108 mongo:7.0 mongod --port 27108 --replSet rs0 --bind_ip_all`. Initiate it once with `rs.initiate({_id: "rs0", members: [{_id: 0, host: "localhost:27108"}]})`.

In the kumbukumbu checkout:

```sh
export Kumbu__Mongo__ConnectionString='mongodb://localhost:27108/?directConnection=true'
export Kumbu__Mongo__Database=kumbu_e2e
export Kumbu__PublicUrl=http://localhost:8108     # bootstrap-admin needs it, and the Origin check compares with it
export Kumbu__Search__Enabled=false               # no embedding model needed for the run
export ASPNETCORE_URLS=http://localhost:8108
export ASPNETCORE_ENVIRONMENT=Development

dotnet run --project src/Kumbu.Server -- bootstrap-admin   # prints http://localhost:8108/join#<code>
dotnet run --project src/Kumbu.Server                      # the server itself, in a second shell
```

Without a dev token there is no seeded user, so the first admin comes from the `bootstrap-admin` link. Make the account, the vault and the keys over the API. Requests from a session cookie need an `Origin` equal to `Kumbu:PublicUrl`:

```sh
U=http://localhost:8108; O="Origin: $U"; J=$(mktemp)
curl -s -c "$J" -H "$O" -H 'Content-Type: application/json' \
  -d '{"code":"<code from the link>","username":"e2e","password":"<12 characters or more>"}' "$U/api/join"
curl -s -b "$J" -H "$O" -H 'Content-Type: application/json' -d '{"name":"E2E"}' "$U/api/vaults"
curl -s -b "$J" -H "$O" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-device","vaults":{"E2E":"write"}}' "$U/api/keys"   # → "key": "kumbu_…"
curl -s -b "$J" -H "$O" -H 'Content-Type: application/json' \
  -d '{"name":"e2e-agent","vaults":{"E2E":"write"}}' "$U/api/keys"
```

Then run `pnpm e2e` with `KUMBU_URL=http://localhost:8108` and the two keys. For another run on the same vault, add `E2E_CLEAN=1`.

## How it is built

`pnpm e2e` bundles `e2e/run.ts` with esbuild into `.e2e/run.mjs` (git-ignored) and runs it with Node 22 or newer, which has `fetch` and `WebSocket` built in. `e2e/nodeFiles.ts` is `LocalFiles` over `node:fs`. Its `writeIf` checks and writes synchronously, as the Obsidian adapter does, so a user write can't land between the two. The user's writes go through a temp file and a rename, so the engine's asynchronous read never sees a half-written file.
