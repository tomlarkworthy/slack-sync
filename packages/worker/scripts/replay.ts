// Re-derive already-published messages from the slackRaw archive, after a fix
// to the derivation. Reads the bot repo's slackRaw records, keeps the newest
// envelope per (channel, ts) — so an edited message replays as its final text,
// not its first — and POSTs them to /slack/replay.
//
//   INJECT_TOKEN=… bun scripts/replay.ts --has-list --dry-run
//   INJECT_TOKEN=… bun scripts/replay.ts --has-list
//   INJECT_TOKEN=… bun scripts/replay.ts --ts 1788810788.677819
//
// --has-list selects messages whose blocks contain a rich_text_list (the
// 2026-09-07 walker fix). WORKER_URL defaults to the deployed worker.

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const PDS = "https://jellybaby.us-east.host.bsky.network";
const COLLECTION = "com.feelingofcomputing.bridge.slackRaw";
const BATCH = 20;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const hasListFilter = args.includes("--has-list");
const tsFilter = new Set(args.flatMap((a, i) => (args[i - 1] === "--ts" ? [a] : [])));
if (!hasListFilter && tsFilter.size === 0) {
  throw new Error("usage: replay.ts (--has-list | --ts <slack ts>…) [--dry-run]");
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
  const match = tsFilter.size ? tsFilter.has(inner.ts ?? "") : containsList(inner.blocks);
  if (!match) continue;
  const prev = newest.get(key);
  if (!prev || (v.capturedAt ?? "") > (prev.capturedAt ?? "")) newest.set(key, v);
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
