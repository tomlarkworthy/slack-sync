// What the published archive looks like, and which days a backfill re-run has
// to cover. Two questions the repair and extension runs both needed:
//   - how far back does the archive go, and does any record still carry the
//     literal "• " / "> " markers the pre-block-facet walker emitted;
//   - which messages came from the backfill CLI (no archived Slack envelope),
//     since those are the ones /slack/replay cannot repair.
import { slackTsFromTid } from "@slack-sync/shared";

const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const PDS = "https://jellybaby.us-east.host.bsky.network";

async function* records(collection: string) {
  let cursor: string | undefined;
  do {
    const u = new URL(`${PDS}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", BOT_DID);
    u.searchParams.set("collection", collection);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = (await (await fetch(u)).json()) as any;
    for (const r of j.records) yield r;
    cursor = j.records.length ? j.cursor : undefined;
  } while (cursor);
}

const archived = new Set<string>();
for await (const r of records("com.feelingofcomputing.bridge.slackRaw")) {
  const v = r.value as any;
  const inner = v.payload?.event?.message ?? v.payload?.event ?? {};
  if (inner.ts) archived.add(inner.ts);
  if (v.slackTs) archived.add(v.slackTs);
}

const at = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000).toISOString();
const byMonth = new Map<string, { n: number; damaged: number }>();
const backfillDays = new Map<string, number>();
let total = 0;
for await (const r of records("social.colibri.message")) {
  total++;
  const ts = slackTsFromTid(r.uri.split("/").pop()!);
  const iso = at(ts);
  const text: string = r.value.text ?? "";
  const damaged = /(^|\n)\s*•\s/.test(text) || /(^|\n)>\s/.test(text);
  const m = byMonth.get(iso.slice(0, 7)) ?? { n: 0, damaged: 0 };
  m.n++;
  if (damaged) m.damaged++;
  byMonth.set(iso.slice(0, 7), m);
  if (archived.has(ts)) continue;
  const day = iso.slice(0, 10).replace(/-/g, "/");
  backfillDays.set(day, (backfillDays.get(day) ?? 0) + 1);
}

console.log(`${total} published messages, by month:`);
for (const [mo, e] of [...byMonth].sort())
  console.log(`  ${mo}  ${e.n}${e.damaged ? `  literal • / > markers: ${e.damaged}` : ""}`);
const bf = [...backfillDays.values()].reduce((a, b) => a + b, 0);
console.log(`\n${archived.size} archived Slack envelopes; ${bf} messages have none (backfill CLI's own), over ${backfillDays.size} days:`);
for (const [d, n] of [...backfillDays].sort()) console.log(`  ${d} ${n}`);
