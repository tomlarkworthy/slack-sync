// Publish the records `--emit` derived, through the worker. The bot's app
// password exists only as a Worker secret, so the CLI derives and the worker
// writes.
//
//   INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts records.jsonl
//
// Built for a long run over a link that may not hold: every batch is retried
// with backoff, progress is written to a watermark after each one, and a
// re-run resumes from it. Stopping it (^C) is safe — it finishes the batch in
// flight, writes the watermark and exits.
//
// The PDS meters writes per repo, so the run paces itself against the budget
// the worker reports and sleeps out an exhausted window rather than failing.
//
//   --retry-failures  re-post only the records the watermark recorded as failed.
//                     Run it after the main run, not alongside: it cannot roll
//                     `done` back, but a live run rewrites the whole watermark
//                     each batch and will restore the entry it just cleared.
//   --watermark <f>   default: <input>.watermark.json
//   --restart         ignore an existing watermark and start from line 0
//   --limit N         stop after N records this run (leaves the watermark set)
//   --delay-ms N      between batches (default 250)
//   --repair-only     post to /repair/messages, which refuses an unpublished rkey
//   --dry-run         count the input and stop

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
// Each record costs the worker a getRecord plus a putRecord; stay well inside
// the subrequest cap, and keep a failed batch small enough to be cheap to redo.
const BATCH = 20;
// Enough backoff to ride out a link that is down for half an hour, since that
// is the failure this run is built for. Past that, exiting on the watermark is
// better than a process holding a dead socket.
const MAX_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 300_000;
// Leave the PDS a margin: a bridge message arriving mid-run needs budget too.
const RESERVE = 50;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, dflt?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const dryRun = flag("--dry-run");
const repairOnly = flag("--repair-only");
const restart = flag("--restart");
const retryFailures = flag("--retry-failures");
const delayMs = Number(opt("--delay-ms", "250"));
const runLimit = Number(opt("--limit", "0"));
const path = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!path) throw new Error("usage: post-records.ts <records.jsonl> [--watermark f] [--restart] [--limit N] [--delay-ms N] [--repair-only] [--dry-run]");
const wmPath = opt("--watermark", `${path}.watermark.json`)!;
const token = process.env.INJECT_TOKEN;
if (!token && !dryRun) throw new Error("INJECT_TOKEN not set");

type Item = { collection: string; rkey: string; record: unknown };
const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
const items: Item[] = lines.map((l) => JSON.parse(l));
// One record can be derived twice (a reply reached from two days' runs). Keep
// the last, and keep the order stable so a line offset is a valid watermark.
const seen = new Map<string, number>();
for (const [i, it] of items.entries()) seen.set(`${it.collection}/${it.rkey}`, i);
const all = items.filter((it, i) => seen.get(`${it.collection}/${it.rkey}`) === i);

type Watermark = {
  input: string;
  records: number;
  done: number;
  totals: Record<string, number>;
  failures: Array<{ rkey: string; error: string }>;
  startedAt: string;
  updatedAt: string;
};
const fresh = (): Watermark => ({
  input: path,
  records: all.length,
  done: 0,
  totals: {},
  failures: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
let wm: Watermark = fresh();
if (!restart && existsSync(wmPath)) {
  const prev = JSON.parse(readFileSync(wmPath, "utf8")) as Watermark;
  // The input growing is normal — phase 1 appends days. Only a shrink or a
  // different file means the offset no longer addresses the same record.
  if (prev.input !== path || prev.records > all.length)
    throw new Error(`watermark ${wmPath} is for ${prev.input} (${prev.records} records); pass --restart to discard it`);
  wm = { ...prev, records: all.length };
}

const counts: Record<string, number> = {};
for (const i of all) counts[i.collection] = (counts[i.collection] ?? 0) + 1;
console.log(
  `${lines.length} lines, ${all.length} distinct records (${Object.entries(counts).map(([c, n]) => `${n} ${c.split(".").pop()}`).join(", ")})`,
);
console.log(`resuming at ${wm.done}/${all.length}${wm.done ? ` (${((wm.done / all.length) * 100).toFixed(1)}%)` : ""}`);
if (dryRun && !retryFailures) process.exit(0);
if (repairOnly && all.some((i) => i.collection !== "social.colibri.message"))
  throw new Error("--repair-only posts to /repair/messages, which only takes social.colibri.message");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saveWatermark = () => {
  wm.updatedAt = new Date().toISOString();
  writeFileSync(wmPath, JSON.stringify(wm, null, 1) + "\n");
};

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\n^C — finishing the batch in flight, then writing the watermark");
});

type Result = {
  created: string[];
  updated: string[];
  unchanged: string[];
  written?: string[];
  absent?: string[];
  failed?: Array<{ rkey: string; error: string }>;
  limit?: { remaining: number; limit: number; reset: number };
};

const endpoint = repairOnly ? "/repair/messages" : "/backfill/records";
async function postBatch(batch: Item[]): Promise<Result> {
  const body = JSON.stringify(repairOnly ? batch.map(({ rkey, record }) => ({ rkey, record })) : batch);
  let wait = 2000;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${WORKER_URL}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      // A dropped connection is the expected failure here, not the exception.
      if (attempt >= MAX_ATTEMPTS) throw e;
      console.log(`  network: ${(e as Error).message} — retry ${attempt}/${MAX_ATTEMPTS} in ${wait / 1000}s`);
      await sleep(wait);
      wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      continue;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as Result;
    // 4xx other than 429 is the request's fault; retrying cannot fix it.
    if (res.status !== 429 && res.status < 500) throw new Error(`${res.status}: ${text}`);
    if (attempt >= MAX_ATTEMPTS) throw new Error(`${res.status} after ${attempt} attempts: ${text}`);
    const after = Number(res.headers.get("retry-after"));
    const pause = Number.isFinite(after) && after > 0 ? after * 1000 : wait;
    console.log(`  ${res.status} — retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(pause / 1000)}s`);
    await sleep(pause);
    wait = Math.min(wait * 2, MAX_BACKOFF_MS);
  }
}

// A record the PDS failed on (a transient 500, say) is recorded and stepped
// over so a long run does not stall on it. This re-posts just those and drops
// the ones that land; the main watermark offset is left where it is.
if (retryFailures) {
  if (!wm.failures.length) {
    console.log("no recorded failures");
    process.exit(0);
  }
  const want = new Set(wm.failures.map((f) => f.rkey));
  const redo = all.filter((i) => want.has(i.rkey));
  console.log(`${wm.failures.length} recorded failures, ${redo.length} found in ${path}`);
  if (dryRun) process.exit(0);
  const still: typeof wm.failures = [];
  for (let i = 0; i < redo.length; i += BATCH) {
    const r = await postBatch(redo.slice(i, i + BATCH));
    for (const [k, v] of Object.entries(r)) if (Array.isArray(v)) wm.totals[k] = (wm.totals[k] ?? 0) + v.length;
    if (r.failed?.length) still.push(...r.failed);
    console.log(`  created ${r.created.length}, updated ${r.updated.length}, unchanged ${r.unchanged.length}, failed ${r.failed?.length ?? 0}`);
    if (delayMs > 0) await sleep(delayMs);
  }
  // The main run may be writing this same file. Re-read it and touch only the
  // failure list, so clearing a failure cannot roll `done` back to whatever it
  // was when this process started.
  if (existsSync(wmPath)) {
    const live = JSON.parse(readFileSync(wmPath, "utf8")) as Watermark;
    wm = { ...live, failures: live.failures.filter((f) => still.some((s2) => s2.rkey === f.rkey)) };
  } else {
    wm.failures = still;
  }
  saveWatermark();
  console.log(still.length ? `${still.length} still failing` : "all recorded failures cleared");
  process.exit(still.length ? 1 : 0);
}

const t0 = Date.now();
const startedAt = wm.done;
while (wm.done < all.length && !stopping) {
  if (runLimit && wm.done - startedAt >= runLimit) {
    console.log(`--limit ${runLimit} reached`);
    break;
  }
  const batch = all.slice(wm.done, wm.done + BATCH);
  let r: Result;
  try {
    r = await postBatch(batch);
  } catch (e) {
    console.error(`\nstopped at ${wm.done}/${all.length}: ${(e as Error).message}`);
    saveWatermark();
    console.error(`re-run the same command to resume from the watermark (${wmPath})`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(r)) if (Array.isArray(v)) wm.totals[k] = (wm.totals[k] ?? 0) + v.length;
  // Keep the watermark small: the first failures say what is wrong.
  if (r.failed?.length && wm.failures.length < 200) wm.failures.push(...r.failed);
  if (r.absent?.length) console.log(`  absent: ${r.absent.join(" ")}`);
  wm.done += batch.length;
  saveWatermark();

  const done = wm.done - startedAt;
  const rate = done / ((Date.now() - t0) / 1000);
  const etaMin = rate > 0 ? Math.round((all.length - wm.done) / rate / 60) : 0;
  const budget = r.limit && Number.isFinite(r.limit.remaining) ? ` budget ${r.limit.remaining}/${r.limit.limit}` : "";
  process.stdout.write(
    `\r${wm.done}/${all.length} (${((wm.done / all.length) * 100).toFixed(1)}%) ${rate.toFixed(1)}/s eta ${etaMin}m${budget}   `,
  );

  // The PDS's write budget is the real speed limit. Sleep out the window
  // rather than burning retries against a 429.
  if (r.limit && Number.isFinite(r.limit.remaining) && r.limit.remaining < RESERVE) {
    const secs = Math.max(0, r.limit.reset - Math.floor(Date.now() / 1000)) + 5;
    console.log(`\nwrite budget ${r.limit.remaining} left — sleeping ${Math.round(secs / 60)}m for the window to reset`);
    for (let i = 0; i < secs && !stopping; i++) await sleep(1000);
    continue;
  }
  if (delayMs > 0) await sleep(delayMs);
}

saveWatermark();
console.log(`\n${Object.entries(wm.totals).map(([k, n]) => `${k} ${n}`).join(", ")}`);
if (wm.failures.length) console.log(`${wm.failures.length} records failed; see ${wmPath}`);
console.log(wm.done >= all.length ? "complete" : `stopped at ${wm.done}/${all.length}; re-run to resume`);
