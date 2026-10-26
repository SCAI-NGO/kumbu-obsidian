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

const DEVICE = "E2E-node";
/** How long before a user operation an agent write may land and still meet it as a conflict (hint and download time). */
const BEFORE_MS = 1500;
/** The 2 s debounce plus round trips: an agent write landing this long after a user edit may still meet it. */
const AFTER_MS = 3000;

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
const seed = Number(process.env.E2E_SEED ?? Date.now() % 1_000_000);
const seconds = Number(process.env.E2E_SECONDS ?? 180);
const quietSeconds = Number(process.env.E2E_QUIET_SECONDS ?? 15);
const clean = process.env.E2E_CLEAN === "1";

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

interface Op { t: number; side: "user" | "agent"; kind: string; paths: string[]; }
const ops: Op[] = [];
/** When the device's own writes reached the server, per path. */
const deviceWrites: { t: number; path: string }[] = [];
const conflicts: { t: number; original: string; copy: string }[] = [];
const isCopy = (p: string) => p.includes("(conflict ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The device's RemoteApi, recording when each of its writes landed. */
function recording(api: KumbuApi): RemoteApi {
  const note = (...paths: string[]) => { for (const path of paths) deviceWrites.push({ t: Date.now(), path }); };
  return {
    versions: (since, state) => api.versions(since, state),
    read: (path) => api.read(path),
    put: async (path, content, base) => { const r = await api.put(path, content, base); note(path); return r; },
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
  console.log(`seed ${seed}, folder ${root}, ${seconds} s of operations`);

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
    check: (full) => void engine.check(full),
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
      ops.push({ t: Date.now(), side: "user", kind: "edit", paths: [p] });
    } else if (r < 0.38) {
      const p = pick(local);
      if (p !== undefined) {
        files.remove(p);
        engine.localDeleted(p);
        ops.push({ t: Date.now(), side: "user", kind: "delete", paths: [p] });
      }
    } else if (r < 0.45) {
      const from = pick(local);
      const to = pick(pool.filter((p) => !files.exists(p)));
      if (from !== undefined && to !== undefined) {
        await files.rename(from, to);
        engine.localRenamed(from, to);
        ops.push({ t: Date.now(), side: "user", kind: "rename", paths: [from, to] });
      }
    } else if (r < 0.8) {
      const p = pick(pool)!;
      const current = await agent.read(p);
      let put = await agent.put(p, `${current?.content ?? `# ${p}\n`}agent ${n}\n`, current?.version ?? null);
      if (!put.ok) put = await agent.put(p, `${put.conflict.content}agent ${n}\n`, put.conflict.version);
      ops.push({ t: Date.now(), side: "agent", kind: put.ok ? "edit" : "edit (409 twice)", paths: [p] });
    } else {
      const remote = (await agent.versions(null, null)).entries.filter((e) => e.version !== null && !isCopy(e.path));
      const e = pick(remote);
      if (e !== undefined && r < 0.9) {
        const result = await agent.remove(e.path, e.version!);
        ops.push({ t: Date.now(), side: "agent", kind: result.ok ? "delete" : "delete (refused)", paths: [e.path] });
      } else if (e !== undefined) {
        const taken = new Set(remote.map((x) => x.path));
        const to = pick(pool.filter((p) => !taken.has(p)));
        if (to !== undefined) {
          const result = await agent.move(e.path, to);
          ops.push({ t: Date.now(), side: "agent", kind: result.ok ? "move" : "move (refused)", paths: [e.path, to] });
        }
      }
    }
    await sleep(200 + random() * 300);
  }

  console.log(`${ops.length} operations; quiet for ${quietSeconds} s, then a full check`);
  await sleep(quietSeconds * 1000);
  await engine.idle();
  const before = (await compare(files, agent)).diff;
  console.log(`before the full check (hints and since answers only): ${before.length === 0 ? "converged" : `${before.length} paths differ: ${before.join(", ")}`}`);
  await engine.check(true);
  await engine.idle();
  const status = engine.status();
  hints.stop();
  await engine.stop();

  const { diff, remote, localPaths } = await compare(files, agent);

  // A conflict copy is expected only where both sides touched the path close together: an agent write landing
  // from shortly before a user operation until the device's next write of that path reached the server.
  const unexpected: string[] = [];
  for (const c of conflicts.slice(firstCopies)) {
    const met = ops.some((u) => u.side === "user" && u.paths.includes(c.original) && u.t <= c.t && ops.some((a) => {
      if (a.side !== "agent" || !a.paths.includes(c.original)) return false;
      const landed = deviceWrites.find((w) => w.path === c.original && w.t >= u.t)?.t ?? u.t;
      return a.t >= u.t - BEFORE_MS && a.t <= Math.max(u.t + AFTER_MS, landed + 500);
    }));
    if (!met) unexpected.push(c.original);
  }
  const copiesOnDisk = localPaths.filter(isCopy);
  const strayCopies = copiesOnDisk.filter((p) => !conflicts.some((c) => c.copy === p));

  const kinds = new Map<string, number>();
  for (const o of ops) kinds.set(`${o.side} ${o.kind}`, (kinds.get(`${o.side} ${o.kind}`) ?? 0) + 1);
  console.log(`operations: ${[...kinds].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`conflict copies: ${firstCopies} from the first sync, ${conflicts.length - firstCopies} during the run, ${copiesOnDisk.length} on disk`);
  console.log(`status: ${status.mode}; not synced: ${status.notSynced.map((s) => `${s.path} (${s.reason})`).join(", ") || "none"}`);
  console.log(`notes: ${localPaths.length} local, ${remote.size} in Kumbu²`);

  const ok = firstOk && diff.length === 0 && unexpected.length === 0 && strayCopies.length === 0 && !authLost && status.mode !== "offline";
  if (diff.length > 0) console.error(`not converged:\n  ${diff.join("\n  ")}`);
  for (const p of unexpected) {
    console.error(`unexpected conflict copy for ${p}; operations on it:`);
    for (const o of ops.filter((x) => x.paths.includes(p))) console.error(`  ${new Date(o.t).toISOString()} ${o.side} ${o.kind} ${o.paths.join(" → ")}`);
    for (const w of deviceWrites.filter((x) => x.path === p)) console.error(`  ${new Date(w.t).toISOString()} device write landed`);
  }
  if (strayCopies.length > 0) console.error(`conflict copies nobody reported: ${strayCopies.join(", ")}`);
  if (authLost) console.error("the device key stopped working");
  if (status.mode === "offline") console.error("the engine ended offline");
  if (ok) console.log(`converged: ${unexpected.length} unexpected conflict copies`);
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e: unknown) => {
  console.error(e);
  process.exit(1);
});
