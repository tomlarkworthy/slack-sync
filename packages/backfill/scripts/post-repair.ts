// Publish records derived by `--emit` through the worker's /repair/messages.
// The bot's app password exists only as a Worker secret, so the CLI derives
// and the worker writes. Update-only: the worker refuses an rkey that is not
// already published.
//
//   INJECT_TOKEN=… bun packages/backfill/scripts/post-repair.ts /tmp/repair.jsonl [--dry-run]

import { readFileSync } from "node:fs";

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
const BATCH = 50;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const path = args.find((a) => !a.startsWith("--"));
if (!path) throw new Error("usage: post-repair.ts <emit.jsonl> [--dry-run]");
const token = process.env.INJECT_TOKEN;
if (!token && !dryRun) throw new Error("INJECT_TOKEN not set");

const items = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { rkey: string; record: unknown });
// One rkey can be derived twice (a reply reached from two days' runs).
const byRkey = new Map(items.map((i) => [i.rkey, i]));
console.log(`${items.length} emitted records, ${byRkey.size} distinct rkeys`);
if (dryRun) process.exit(0);

const totals = { written: 0, unchanged: 0, absent: 0 };
const all = [...byRkey.values()];
for (let i = 0; i < all.length; i += BATCH) {
  const res = await fetch(`${WORKER_URL}/repair/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(all.slice(i, i + BATCH)),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`batch ${i / BATCH + 1}: ${res.status} ${text}`);
    process.exit(1);
  }
  const r = JSON.parse(text) as { written: string[]; unchanged: string[]; absent: string[] };
  totals.written += r.written.length;
  totals.unchanged += r.unchanged.length;
  totals.absent += r.absent.length;
  console.log(`batch ${i / BATCH + 1}: written ${r.written.length}, unchanged ${r.unchanged.length}, absent ${r.absent.length}`);
  if (r.absent.length) console.log(`  absent: ${r.absent.join(" ")}`);
}
console.log(`written ${totals.written}, unchanged ${totals.unchanged}, absent ${totals.absent}`);
