// SPDX-License-Identifier: AGPL-3.0-or-later
// The end-to-end race run against a real Kumbu² server (plan Task 11): a temp folder and a vault with 30 notes each,
// overlapping; the first sync with "Keep both"; then minutes of random operations from both sides, the device's
// through NodeFiles and the engine's event methods, the agent's over REST with its own key; then quiet, a full
// check, and the convergence assertion of the race tests. Exit 0 on convergence, 1 with a diff otherwise.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KumbuApi, type HttpFn } from "../src/api/client";
import { SyncEngine } from "../src/engine/engine";
import { eligibility } from "../src/engine/paths";
import {
  OfflineError, type Clock, type RemoteApi, type StateStore, type SyncState,
} from "../src/engine/ports";
import { normaliseText } from "../src/engine/version";
import { HintConnection, wsUrlFor } from "../src/live/hints";
import { openSocket } from "../src/obsidian/runtime";
import { NodeFiles } from "./nodeFiles";
import { lostMarkers, unexplainedCopies, type Copy, type Landed, type Op } from "./rules";

const DEVICE = "E2E-node";
/** How long before a user operation an agent write may land and still meet it as a conflict (hint and download time). */
const BEFORE_MS = 1500;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Set ${name} (see e2e/README.md).`);
    process.exit(2);
  }
  return value;
}

const server = required("KUMBU_URL");
const vault = required("KUMBU_VAULT");
const deviceKey = required("KUMBU_DEVICE_KEY");
const agentKey = required("KUMBU_AGENT_KEY");
function whole(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a whole number of 0 or more, not "${raw}".`);
    process.exit(2);
  }
  return value;
}

const seed = whole("E2E_SEED", Date.now() % 1_000_000);
const seconds = whole("E2E_SECONDS", 180);
const quietSeconds = whole("E2E_QUIET_SECONDS", 15);
const clean = process.env.E2E_CLEAN === "1";
/**
 * Deliberate bugs, comma-separated, to show that the checks fail: "lww" makes the device overwrite the server's
 * text on a 409 (last writer wins: an agent's edit is lost silently, both sides still agree); "drop-hints" ignores
 * every hint, so only the final full check brings the agent's changes over. With hints the engine mostly sees an
 * agent's edit before it uploads, so "lww" bites rarely alone; "lww,drop-hints" makes most uploads meet a 409.
 */
const faults = new Set((process.env.E2E_FAULT ?? "").split(",").filter((f) => f !== ""));
for (const f of faults) {
  if (f !== "lww" && f !== "drop-hints") {
    console.error(`E2E_FAULT takes "lww" and "drop-hints", not "${f}".`);
    process.exit(2);
  }
}

/** mulberry32: a small seeded PRNG, so a run's operations can be told again from its seed. */
function prng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nodeHttp: HttpFn = async (r) => {
  let response: Response;
  try {
    response = await fetch(new URL(r.url, server), {
      method: r.method, headers: r.headers, body: r.body, signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new OfflineError(e instanceof Error ? e.message : "The request failed.");
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  return { status: response.status, headers, text: await response.text() };
};

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

class MemoryState implements StateStore {
  state: SyncState = { bases: {}, cursor: null, lastFullAt: null, lastSyncAt: null };
  load(): Promise<SyncState> { return Promise.resolve(structuredClone(this.state)); }
  save(state: SyncState): Promise<void> { this.state = structuredClone(state); return Promise.resolve(); }
}

const ops: Op[] = [];
/** When the device's own writes reached the server, per path. */
const deviceWrites: Landed[] = [];
const conflicts: Copy[] = [];
/** The marker line each edit appended (only the agent's edits the server took). */
const markers: string[] = [];
const markerPath = new Map<string, string>();
/** The text each delete removed on purpose; markers in it may be gone. */
const removed: string[] = [];
const isCopy = (p: string) => p.includes("(conflict ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The device's RemoteApi, recording when each of its writes landed. */
function recording(api: KumbuApi): RemoteApi {
  const note = (...paths: string[]) => { for (const path of paths) deviceWrites.push({ t: Date.now(), path }); };
  return {
    versions: (since, state) => api.versions(since, state),
    read: (path) => api.read(path),
    put: async (path, content, base) => {
      let r = await api.put(path, content, base);
      if (faults.has("lww") && !r.ok) r = await api.put(path, content, r.conflict.version);
      note(path);
      return r;
    },
    remove: async (path, base) => { const r = await api.remove(path, base); note(path); return r; },
    move: async (from, to) => { const r = await api.move(from, to); note(from, to); return r; },
  };
}

async function remoteNotes(api: KumbuApi): Promise<Map<string, string>> {
  const answer = await api.versions(null, null);
  const notes = new Map<string, string>();
  for (const e of answer.entries) {
    if (e.version === null) continue;
    const note = await api.read(e.path);
    if (note !== null) notes.set(e.path, note.content);
  }
  return notes;
}

/** Convergence: every syncable local file equals the server's note at the same path, and no note is missing. */
async function compare(files: NodeFiles, agent: KumbuApi): Promise<{ diff: string[]; remote: Map<string, string>; localPaths: string[] }> {
  const remote = await remoteNotes(agent);
  const localPaths = (await files.list()).filter((p) => eligibility(p) === "sync");
  const diff: string[] = [];
  for (const p of localPaths) {
    const r = remote.get(p);
    if (r === undefined) diff.push(`only local: ${p}`);
    else if (normaliseText(files.textOf(p) ?? "") !== normaliseText(r)) diff.push(`different: ${p}`);
  }
  for (const p of remote.keys()) if (!localPaths.includes(p)) diff.push(`only in Kumbu²: ${p}`);
  return { diff, remote, localPaths };
}

/** Markers in no note, conflict copy or `.trash` file (local, or in Kumbu²) and in no deleted text. */
async function lost(files: NodeFiles, remote: Map<string, string>): Promise<string[]> {
  const surviving = [...remote.values()];
  for (const p of await files.list()) surviving.push(files.textOf(p) ?? "");
  return lostMarkers(markers, removed, surviving);
}

async function main(): Promise<number> {
  const random = prng(seed);
  const pick = <T,>(xs: T[]): T | undefined => xs.length === 0 ? undefined : xs[Math.floor(random() * xs.length)];
  const agent = new KumbuApi(nodeHttp, server, vault, agentKey);
  const deviceApi = new KumbuApi(nodeHttp, server, vault, deviceKey);

  const existing = (await agent.versions(null, null)).entries.filter((e) => e.version !== null);
  if (existing.length > 0) {
    if (!clean) {
      console.error(`The vault ${vault} has ${existing.length} notes; the run needs an empty one (or E2E_CLEAN=1 to trash them first).`);
      return 2;
    }
    for (const e of existing) await agent.remove(e.path, e.version!);
  }

  // 45 names: 0–14 local only, 15–29 on both sides (15–21 the same text, 22–29 different), 30–44 Kumbu² only.
  // Umlauts and folders on each kind: local only, the same on both, different on both, Kumbu² only.
  const special: Record<number, string> = {
    12: "Besprechung März.md", 20: "Projekte/Plan Q4.md", 25: "Ärger/über die Sache.md", 35: "Projekte/Tief/Notiz.md",
  };
  const names = Array.from({ length: 45 }, (_, i) => special[i] ?? `n${String(i).padStart(2, "0")}.md`);
  const root = mkdtempSync(join(tmpdir(), "kumbu-e2e-"));
  const files = new NodeFiles(root);
  for (let i = 0; i < 30; i++) files.write(names[i]!, `# ${names[i]}\n\nlocal seed ${i}\n`);
  for (let i = 15; i < 45; i++) {
    const text = i < 22 ? `# ${names[i]}\n\nlocal seed ${i}\n` : `# ${names[i]}\n\nKumbu² seed ${i}\n`;
    const r = await agent.put(names[i]!, text, null);
    if (!r.ok) throw new Error(`Seeding ${names[i]} failed.`);
  }
  console.log(`seed ${seed}, folder ${root}, ${seconds} s of operations${faults.size === 0 ? "" : `, FAULT ${[...faults].join(",")}`}`);

  let authLost = false;
  const state = new MemoryState();
  const engine = new SyncEngine({
    vault, device: DEVICE, local: files, remote: recording(deviceApi), state, clock,
    onStatus: () => undefined,
    onConflict: (original, copy) => conflicts.push({ t: Date.now(), original, copy }),
    onAuthLost: () => { authLost = true; },
  });
  let mode = "polling";
  const hints = new HintConnection({
    ticket: () => deviceApi.wsTicket(),
    wsUrl: (ticket) => wsUrlFor(server, ticket),
    open: openSocket,
    vault, clock, random: Math.random,
    check: (full) => { if (full || !faults.has("drop-hints")) void engine.check(full); },
    onMode: (m) => { mode = m; engine.setConnectionMode(m); },
  });
  hints.start();

  const summary = await engine.firstSync(() => Promise.resolve("both"));
  await engine.idle();
  if (summary === null) throw new Error("The first sync was cancelled.");
  const firstCopies = conflicts.length;
  console.log(`first sync: ${summary.uploaded} uploaded, ${summary.downloaded} downloaded, ${summary.unchanged} unchanged, ${summary.conflictCopies} conflict copies`);
  const firstOk = summary.uploaded === 15 && summary.downloaded === 15 && summary.unchanged === 7 && summary.conflictCopies === 8;
  if (!firstOk) console.error("first sync: expected 15 uploaded, 15 downloaded, 7 unchanged, 8 conflict copies");

  for (let w = 0; w < 50 && mode !== "live"; w++) await sleep(100);
  console.log(`hints: ${mode}`);

  const pool = [...names, "neu/eins.md", "neu/zwei.md", "Größe.md"];
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < end) {
    n++;
    const r = random();
    const local = (await files.list()).filter((p) => eligibility(p) === "sync" && !isCopy(p));
    if (r < 0.3) {
      const p = pick(pool)!;
      files.write(p, `${files.textOf(p) ?? `# ${p}\n`}user ${n}\n`);
      engine.localChanged(p);
      markers.push(`user ${n}`);
      markerPath.set(`user ${n}`, p);
      ops.push({ t: Date.now(), side: "user", kind: "edit", paths: [p], ok: true });
    } else if (r < 0.38) {
      const p = pick(local);
      if (p !== undefined) {
        removed.push(files.textOf(p) ?? "");
        files.remove(p);
        engine.localDeleted(p);
        ops.push({ t: Date.now(), side: "user", kind: "delete", paths: [p], ok: true });
      }
    } else if (r < 0.45) {
      const from = pick(local);
      const to = pick(pool.filter((p) => !files.exists(p)));
      if (from !== undefined && to !== undefined) {
        await files.rename(from, to);
        engine.localRenamed(from, to);
        ops.push({ t: Date.now(), side: "user", kind: "rename", paths: [from, to], ok: true });
      }
    } else if (r < 0.8) {
      const p = pick(pool)!;
      const current = await agent.read(p);
      let put = await agent.put(p, `${current?.content ?? `# ${p}\n`}agent ${n}\n`, current?.version ?? null);
      if (!put.ok) put = await agent.put(p, `${put.conflict.content}agent ${n}\n`, put.conflict.version);
      if (put.ok) { markers.push(`agent ${n}`); markerPath.set(`agent ${n}`, p); }
      ops.push({ t: Date.now(), side: "agent", kind: put.ok ? "edit" : "edit (409 twice)", paths: [p], ok: put.ok });
    } else {
      const remote = (await agent.versions(null, null)).entries.filter((e) => e.version !== null && !isCopy(e.path));
      const e = pick(remote);
      if (e !== undefined && r < 0.9) {
        // Read first, so the delete removes exactly the text recorded (it is refused if the note changed since).
        const note = await agent.read(e.path);
        const result = note === null ? { ok: false } : await agent.remove(e.path, note.version);
        if (result.ok) removed.push(note!.content);
        ops.push({ t: Date.now(), side: "agent", kind: result.ok ? "delete" : "delete (refused)", paths: [e.path], ok: result.ok });
      } else if (e !== undefined) {
        const taken = new Set(remote.map((x) => x.path));
        const to = pick(pool.filter((p) => !taken.has(p)));
        if (to !== undefined) {
          const result = await agent.move(e.path, to);
          ops.push({ t: Date.now(), side: "agent", kind: result.ok ? "move" : "move (refused)", paths: [e.path, to], ok: result.ok });
        }
      }
    }
    await sleep(200 + random() * 300);
  }

  console.log(`${ops.length} operations; quiet for ${quietSeconds} s, then a full check`);
  await sleep(quietSeconds * 1000);
  await engine.idle();
  // Phase 1: the live path alone (hints, since answers, uploads). Phase 2: after a forced full check.
  const live = await compare(files, agent);
  const liveLost = await lost(files, live.remote);
  await engine.check(true);
  await engine.idle();
  const status = engine.status();
  hints.stop();
  await engine.stop();
  const { diff, remote, localPaths } = await compare(files, agent);
  const finalLost = await lost(files, remote);

  const unexpected = unexplainedCopies(conflicts.slice(firstCopies), ops, deviceWrites, BEFORE_MS);
  const copiesOnDisk = localPaths.filter(isCopy);
  const strayCopies = copiesOnDisk.filter((p) => !conflicts.some((c) => c.copy === p));

  const kinds = new Map<string, number>();
  for (const o of ops) kinds.set(`${o.side} ${o.kind}`, (kinds.get(`${o.side} ${o.kind}`) ?? 0) + 1);
  const phase = (d: string[], l: string[]) => d.length === 0 && l.length === 0 ? "converged, nothing lost" : `${d.length} paths differ, ${l.length} edits lost`;
  console.log(`operations: ${[...kinds].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`edits: ${markers.length} markers written, ${removed.length} deletes recorded`);
  console.log(`conflict copies: ${firstCopies} from the first sync, ${conflicts.length - firstCopies} during the run, ${copiesOnDisk.length} on disk`);
  console.log(`status: ${status.mode}; not synced: ${status.notSynced.map((s) => `${s.path} (${s.reason})`).join(", ") || "none"}`);
  console.log(`notes: ${localPaths.length} local, ${remote.size} in Kumbu²`);
  console.log(`phase 1, before the full check (live path only): ${phase(live.diff, liveLost)}`);
  console.log(`phase 2, after the full check: ${phase(diff, finalLost)}`);

  const ok = firstOk && live.diff.length === 0 && liveLost.length === 0 && diff.length === 0 && finalLost.length === 0
    && unexpected.length === 0 && strayCopies.length === 0 && !authLost && status.mode !== "offline";
  if (live.diff.length > 0) console.error(`not converged before the full check:\n  ${live.diff.join("\n  ")}`);
  if (diff.length > 0) console.error(`not converged after the full check:\n  ${diff.join("\n  ")}`);
  const lostAll = [...new Set([...liveLost, ...finalLost])];
  if (lostAll.length > 0) {
    console.error(`${lostAll.length} edits lost (in no note, copy or trash, and not deleted):`);
    for (const m of lostAll.slice(0, 20)) console.error(`  ${m} (written to ${markerPath.get(m) ?? "?"})`);
  }
  for (const p of unexpected) {
    console.error(`unexpected conflict copy for ${p}; operations on it:`);
    for (const o of ops.filter((x) => x.paths.includes(p))) console.error(`  ${new Date(o.t).toISOString()} ${o.side} ${o.kind}${o.ok ? "" : " (no effect)"} ${o.paths.join(" → ")}`);
    for (const w of deviceWrites.filter((x) => x.path === p)) console.error(`  ${new Date(w.t).toISOString()} device write landed`);
    for (const c of conflicts.filter((x) => x.original === p)) console.error(`  ${new Date(c.t).toISOString()} copy made`);
  }
  if (strayCopies.length > 0) console.error(`conflict copies nobody reported: ${strayCopies.join(", ")}`);
  if (authLost) console.error("the device key stopped working");
  if (status.mode === "offline") console.error("the engine ended offline");
  if (ok) console.log(`converged: ${unexpected.length} unexpected conflict copies, 0 edits lost`);
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e: unknown) => {
  console.error(e);
  process.exit(1);
});
