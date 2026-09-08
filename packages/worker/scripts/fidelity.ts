// Differential check of the forward walker against Slack's own plaintext.
//
// Every Slack message event carries `blocks` (what we walk) AND `text`
// (Slack's own flattening of the same message). The second is an independent
// reference: content present in Slack's text and absent from ours is content
// the walker dropped. This is what would have caught the rich_text_list bug.
//
//   bun scripts/fidelity.ts                 # whole slackRaw archive
//   bun scripts/fidelity.ts --json out.json # dump divergences as a fixture
import { derive, lostWords, words } from "../test/support/compare";

const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const PDS = "https://jellybaby.us-east.host.bsky.network";

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

const seen = new Map<string, string[]>();  // element type -> example ts
const bad: any[] = [];
let withBlocks = 0, clean = 0;

for await (const v of raw()) {
  if (v.eventType !== "message") continue;
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  if (!Array.isArray(inner.blocks) || typeof inner.text !== "string") continue;
  withBlocks++;

  const collect = (els: any[] | undefined, into: Set<string>) => {
    for (const e of els ?? []) { if (e?.type) into.add(e.type); collect(e.elements, into); }
  };
  const types = new Set<string>();
  for (const b of inner.blocks) { types.add(b.type); collect(b.elements, types); }
  for (const t of types) if (!seen.has(t)) seen.set(t, [inner.ts]);

  const missing = lostWords(inner.blocks, inner.text);
  const theirs = words(inner.text);
  if (missing.length === 0) clean++;
  else bad.push({ ts: inner.ts, channel: v.slackChannelId, types: [...types], missing: missing.slice(0, 12),
                  missingCount: missing.length, refWords: theirs.length,
                  slack: inner.text.slice(0, 160), ours: derive(inner.blocks).text.slice(0, 160) });
}

console.log(`${withBlocks} messages with blocks + reference text: ${clean} lossless, ${bad.length} divergent\n`);
console.log("element types in the archive:");
for (const [t, [ts]] of [...seen].sort()) console.log(`  ${t.padEnd(26)} e.g. ${ts}`);
// Group by the element types present, so a systematic drop stands out from noise.
const byShape = new Map<string, { n: number; lost: number; ref: number; eg: any }>();
for (const d of bad) {
  const key = d.types.filter((t: string) => t !== "rich_text" && t !== "rich_text_section" && t !== "text").sort().join(",") || "(plain)";
  const g = byShape.get(key) ?? { n: 0, lost: 0, ref: 0, eg: d };
  g.n++; g.lost += d.missingCount; g.ref += d.refWords;
  if (d.missingCount / d.refWords > g.eg.missingCount / g.eg.refWords) g.eg = d;
  byShape.set(key, g);
}
console.log("\ndivergent messages grouped by element types present:");
for (const [k, g] of [...byShape].sort((a, b) => b[1].lost / b[1].ref - a[1].lost / a[1].ref)) {
  console.log(`  ${String(Math.round((100 * g.lost) / g.ref)).padStart(3)}% of words lost  n=${String(g.n).padStart(3)}  [${k}]`);
  console.log(`       eg ${g.eg.ts} slack=${JSON.stringify(g.eg.slack.slice(0, 90))}`);
  console.log(`                       ours =${JSON.stringify(g.eg.ours.slice(0, 90))}`);
}
if (process.argv.includes("--detail")) {
  console.log("\ndivergences, worst first:");
  for (const d of bad.sort((a, b) => b.missingCount / b.refWords - a.missingCount / a.refWords).slice(0, 15)) {
    console.log(`\n  ${d.channel} ${d.ts}  ${d.missingCount}/${d.refWords} words missing  [${d.types.join(",")}]`);
    console.log(`    slack: ${JSON.stringify(d.slack)}`);
    console.log(`    ours : ${JSON.stringify(d.ours)}`);
    console.log(`    lost : ${d.missing.join(" ")}`);
  }
}
const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined;
if (out) { await Bun.write(out, JSON.stringify(bad, null, 1)); console.log(`\nwrote ${bad.length} to ${out}`); }
