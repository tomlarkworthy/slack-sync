// Re-derive already-published messages from the slackRaw archive, after a fix
// to the derivation. Reads the bot repo's slackRaw records, keeps the newest
// envelope per (channel, ts) — so an edited message replays as its final text,
// not its first — and POSTs them to /slack/replay.
//
//   INJECT_TOKEN=… bun scripts/replay.ts --stale --dry-run
//   INJECT_TOKEN=… bun scripts/replay.ts --stale
//   INJECT_TOKEN=… bun scripts/replay.ts --ts 1788810788.677819
//
// --reformat selects records whose block-level facets (quote, list, codeblock,
// channel) differ from what the walker produces now — a mapping change rather
// than a loss, which --stale cannot see.
//
// --stale asks the question directly rather than naming a bug: for every
// archived message, does the published Colibri record still carry every word
// of Slack's own plaintext? A record derived by a walker that has since been
// fixed does not, and gets re-derived. --has-list is the older, narrower
// selector (blocks containing a rich_text_list).
// WORKER_URL defaults to the deployed worker.

import { derive, lostFrom, lostWords } from "@slack-sync/shared";
import { tidFromSlackTs } from "../src/atproto";

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const PDS = "https://jellybaby.us-east.host.bsky.network";
const COLLECTION = "com.feelingofcomputing.bridge.slackRaw";
const BATCH = 20;


const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const hasListFilter = args.includes("--has-list");
const staleFilter = args.includes("--stale");
const reformatFilter = args.includes("--reformat");
const tsFilter = new Set(args.flatMap((a, i) => (args[i - 1] === "--ts" ? [a] : [])));
if (!hasListFilter && !staleFilter && !reformatFilter && tsFilter.size === 0) {
  throw new Error("usage: replay.ts (--stale | --reformat | --has-list | --ts <slack ts>…) [--dry-run]");
}
const token = process.env.INJECT_TOKEN;
if (!token && !dryRun) throw new Error("INJECT_TOKEN not set");

type Raw = {
  slackTs?: string;
  slackChannelId?: string;
  eventType?: string;
  capturedAt?: string;
  payload?: any;
};

async function* slackRaw(): AsyncGenerator<Raw> {
  let cursor: string | undefined;
  do {
    const u = new URL(`${PDS}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", BOT_DID);
    u.searchParams.set("collection", COLLECTION);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`listRecords ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { records: Array<{ value: Raw }>; cursor?: string };
    for (const rec of j.records) yield rec.value;
    cursor = j.records.length ? j.cursor : undefined;
  } while (cursor);
}

const containsList = (els: any[] | undefined): boolean =>
  (els ?? []).some((e) => e?.type === "rich_text_list" || containsList(e?.elements));

// Published Colibri messages, by rkey, for --stale.
const published = new Map<string, { text: string; facets: any[] }>();
if (staleFilter || reformatFilter) {
  let cursor: string | undefined;
  do {
    const u = new URL(`${PDS}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", BOT_DID);
    u.searchParams.set("collection", "social.colibri.message");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = (await (await fetch(u)).json()) as any;
    for (const r of j.records) published.set(r.uri.split("/").pop(), r.value);
    cursor = j.records.length ? j.cursor : undefined;
  } while (cursor);
  console.log(`read ${published.size} published messages`);
}

// publishMessage truncates the text at this length and drops the facets past
// it. A record sitting on the cap is missing content by design, not by a
// walker bug: every filter below would see a fresh derivation doing better and
// select it on every run, and the worker would cap it again. Not repairable.
const TEXT_CAP = 2048;
const atCap = (rec: { text?: string }) => (rec.text ?? "").length >= TEXT_CAP;

// Stale = the published record drops words of Slack's plaintext that a fresh
// derivation would keep. The second half matters: a record where Slack
// autolinked a bare domain that its own block tree carries as plain text loses
// words no replay can restore — re-POSTing those forever would be churn.
function isStale(inner: any): boolean {
  const rec = published.get(tidFromSlackTs(inner.ts));
  if (!rec || atCap(rec)) return false;
  const now = lostFrom(rec.text ?? "", rec.facets, inner.text ?? "").length;
  if (now === 0) return false;
  return lostWords(inner.blocks, inner.text ?? "").length < now;
}

// A structural change rather than a loss: the published record does not carry
// the block-level facets the current walker produces (quote, list, codeblock,
// channel — where we used to synthesise "> " and "• " as literal text). Word
// counts are unchanged, so isStale cannot see these. Compare only the block
// features: the byline adds a #mention the block-only derivation has not got.
const BLOCK_FEATURES = new Set(["quote", "list", "codeblock", "channel"]);
const blockShape = (facets: any[] | undefined): string =>
  (facets ?? [])
    .flatMap((f: any) => (f.features ?? []).map((x: any) => String(x.$type).split("#")[1]))
    .filter((k: string) => BLOCK_FEATURES.has(k))
    .sort()
    .join(",");

function needsReformat(inner: any): boolean {
  const rec = published.get(tidFromSlackTs(inner.ts));
  if (!rec || atCap(rec)) return false;
  return blockShape(rec.facets) !== blockShape(derive(inner.blocks).facets);
}

// Newest envelope per message, plus the messages deleted afterwards. The key
// is the *target* ts: a message_changed envelope carries the edit's own ts in
// event.ts and the message's in event.message.ts, and the derivation writes
// tidFromSlackTs(event.message.ts). Keying on event.ts would replay a create
// and its edit as two independent messages, and queue order does not promise
// the edit lands last.
const PUBLISHABLE = new Set([undefined, "file_share", "message_changed"]);
const newest = new Map<string, Raw>();
const deleted = new Set<string>();
let scanned = 0;
// Pass 1: the newest envelope per message. The filter runs in pass 2, on that
// envelope alone — testing every envelope would select a message because some
// superseded edit of it looks wrong, then replay the current one, which is
// already correct, forever.
for await (const v of slackRaw()) {
  scanned++;
  if (v.eventType !== "message") continue;
  const ev = v.payload?.event ?? {};
  if (ev.subtype === "message_deleted") {
    deleted.add(`${v.slackChannelId}/${ev.deleted_ts ?? ev.previous_message?.ts}`);
    continue;
  }
  if (!PUBLISHABLE.has(ev.subtype)) continue;
  const inner = ev.message ?? ev;
  const key = `${v.slackChannelId}/${inner.ts}`;
  const prev = newest.get(key);
  if (!prev || (v.capturedAt ?? "") > (prev.capturedAt ?? "")) newest.set(key, v);
}

// Pass 2: select.
for (const [key, v] of [...newest]) {
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  const match = tsFilter.size
    ? tsFilter.has(inner.ts ?? "")
    : staleFilter || reformatFilter
      ? Array.isArray(inner.blocks) &&
        typeof inner.text === "string" &&
        ((staleFilter && isStale(inner)) || (reformatFilter && needsReformat(inner)))
      : containsList(inner.blocks);
  if (!match) newest.delete(key);
}

const picked = [...newest].filter(([k]) => !deleted.has(k)).map(([, v]) => v);
console.log(`scanned ${scanned} slackRaw records -> ${picked.length} messages to replay`);
for (const v of picked) {
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  console.log(`  ${v.slackChannelId} ${inner.ts} ${ev.subtype ?? "message"} captured=${v.capturedAt}`);
}
if (dryRun) process.exit(0);

for (let i = 0; i < picked.length; i += BATCH) {
  const batch = picked.slice(i, i + BATCH).map((v) => v.payload);
  const res = await fetch(`${WORKER_URL}/slack/replay`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  console.log(`batch ${i / BATCH + 1}: ${res.status} ${await res.text()}`);
  if (!res.ok) process.exit(1);
}
