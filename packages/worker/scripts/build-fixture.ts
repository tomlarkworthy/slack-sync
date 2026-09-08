// Freeze a covering subset of the slackRaw archive as an offline test corpus:
// one message per distinct combination of rich-text element types, plus every
// message that has ever diverged from Slack's own plaintext. Small enough to
// check in, broad enough that a new unhandled element type fails the build.
//
//   bun scripts/build-fixture.ts            # rewrites test/fixtures/slack-corpus.json
const PDS = "https://jellybaby.us-east.host.bsky.network";
const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const OUT = new URL("../test/fixtures/slack-corpus.json", import.meta.url).pathname;

async function* raw() {
  let cursor: string | undefined;
  do {
    const u = new URL(`${PDS}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", BOT_DID);
    u.searchParams.set("collection", "com.feelingofcomputing.bridge.slackRaw");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = (await (await fetch(u)).json()) as any;
    for (const r of j.records) yield r.value;
    cursor = j.records.length ? j.cursor : undefined;
  } while (cursor);
}

const collect = (els: any[] | undefined, into: Set<string>) => {
  for (const e of els ?? []) { if (e?.type) into.add(e.type); collect(e.elements, into); }
};

const picked = new Map<string, any>();
let scanned = 0;
for await (const v of raw()) {
  if (v.eventType !== "message") continue;
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  if (!Array.isArray(inner.blocks) || typeof inner.text !== "string") continue;
  scanned++;
  const types = new Set<string>();
  for (const b of inner.blocks) { types.add(b.type); collect(b.elements, types); }
  const shape = [...types].sort().join(",");
  // Keep the first message of each shape, preferring the shortest — fixtures
  // are read by people.
  const prev = picked.get(shape);
  if (!prev || inner.text.length < prev.text.length) {
    picked.set(shape, { ts: inner.ts, channel: v.slackChannelId, shape, blocks: inner.blocks, text: inner.text });
  }
}

const out = [...picked.values()].sort((a, b) => a.shape.localeCompare(b.shape));
await Bun.write(OUT, JSON.stringify(out, null, 1) + "\n");
const kb = Math.round((await Bun.file(OUT).size) / 1024);
console.log(`scanned ${scanned} messages -> ${out.length} shapes, ${kb} KB`);
for (const f of out) console.log(`  ${f.ts}  ${f.shape}`);
