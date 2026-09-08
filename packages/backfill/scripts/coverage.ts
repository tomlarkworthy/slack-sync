// Which published messages came from backfill (no Slack event envelope) and
// which days they cover — the set a repair run has to span.
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
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  if (inner.ts) archived.add(inner.ts);
  if (v.slackTs) archived.add(v.slackTs);
}
const day = (ts: string) => new Date(Number(ts.split(".")[0]) * 1000).toISOString().slice(0, 10).replace(/-/g, "/");
const days = new Map<string, number>();
let total = 0, bf = 0;
for await (const r of records("social.colibri.message")) {
  total++;
  const ts = slackTsFromTid(r.uri.split("/").pop()!);
  if (archived.has(ts)) continue;
  bf++;
  days.set(day(ts), (days.get(day(ts)) ?? 0) + 1);
}
console.log(`${archived.size} archived envelopes; ${bf}/${total} published messages have none (backfill-era)`);
console.log(`${days.size} days:`);
for (const [d, n] of [...days].sort()) console.log(`  ${d} ${n}`);
