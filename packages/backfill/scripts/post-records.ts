// Publish the records `--emit` derived, through the worker. The bot's app
// password exists only as a Worker secret, so the CLI derives and the worker
// writes.
//
//   INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts /tmp/out.jsonl [--dry-run]
//
// /backfill/records creates as well as updates. For a repair, --repair-only
// posts to /repair/messages instead, which refuses an rkey that is not already
// published — so a run that should only fix existing records cannot add any.

import { readFileSync } from "node:fs";

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
const BATCH = 20; // each record costs a getRecord + a putRecord; stay well under the Worker subrequest cap

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const repairOnly = args.includes("--repair-only");
const path = args.find((a) => !a.startsWith("--"));
if (!path) throw new Error("usage: post-records.ts <emit.jsonl> [--repair-only] [--dry-run]");
const token = process.env.INJECT_TOKEN;
if (!token && !dryRun) throw new Error("INJECT_TOKEN not set");

const items = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { collection: string; rkey: string; record: unknown });
// One record can be derived twice (a reply reached from two days' runs).
const byKey = new Map(items.map((i) => [`${i.collection}/${i.rkey}`, i]));
const counts: Record<string, number> = {};
for (const i of byKey.values()) counts[i.collection] = (counts[i.collection] ?? 0) + 1;
console.log(
  `${items.length} emitted records, ${byKey.size} distinct: ${Object.entries(counts).map(([c, n]) => `${n} ${c.split(".").pop()}`).join(", ")}`,
);
if (repairOnly && [...byKey.values()].some((i) => i.collection !== "social.colibri.message"))
  throw new Error("--repair-only posts to /repair/messages, which only takes social.colibri.message");
if (dryRun) process.exit(0);

const totals: Record<string, number> = {};
const all = [...byKey.values()];
const endpoint = repairOnly ? "/repair/messages" : "/backfill/records";
for (let i = 0; i < all.length; i += BATCH) {
  const batch = all.slice(i, i + BATCH);
  const res = await fetch(`${WORKER_URL}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(repairOnly ? batch.map(({ rkey, record }) => ({ rkey, record })) : batch),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`batch ${i / BATCH + 1}: ${res.status} ${text}`);
    process.exit(1);
  }
  const r = JSON.parse(text) as Record<string, string[]>;
  for (const [k, v] of Object.entries(r)) totals[k] = (totals[k] ?? 0) + v.length;
  console.log(
    `batch ${i / BATCH + 1}: ${Object.entries(r).map(([k, v]) => `${k} ${v.length}`).join(", ")}`,
  );
  if (r.absent?.length) console.log(`  absent: ${r.absent.join(" ")}`);
}
console.log(Object.entries(totals).map(([k, n]) => `${k} ${n}`).join(", "));
