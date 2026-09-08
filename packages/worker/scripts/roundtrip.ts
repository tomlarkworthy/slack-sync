// True round trip over the archive: Slack blocks -> (forward walker) ->
// Colibri text+facets -> (reverse renderer) -> Slack mrkdwn, compared with the
// mrkdwn Slack itself sent in the same event. Both halves live in this repo
// and mrkdwn.ts calls itself the inverse of the walker; this is the only thing
// that checks that claim.
//
//   bun scripts/roundtrip.ts [--detail]
import { canonMrkdwn, derive } from "../test/support/compare";
import { renderFacets } from "../src/mrkdwn";
import { SLACK_USER_DID_MAP } from "../src/slack-to-did";

const PDS = "https://jellybaby.us-east.host.bsky.network";
const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob";
const DID_TO_SLACK = Object.fromEntries(Object.entries(SLACK_USER_DID_MAP).map(([u, d]) => [d, u]));

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

let n = 0, exact = 0;
const diffs: any[] = [];
const seenTs = new Set<string>();
for await (const v of raw()) {
  if (v.eventType !== "message") continue;
  const ev = v.payload?.event ?? {};
  const inner = ev.message ?? ev;
  if (!Array.isArray(inner.blocks) || typeof inner.text !== "string") continue;
  if (seenTs.has(inner.ts)) continue;
  seenTs.add(inner.ts);
  n++;
  const { text, facets } = derive(inner.blocks, (id: string) => id);
  const back = renderFacets(text, facets, {
    slackUserForDid: (did) => DID_TO_SLACK[did],
  });
  // Our mention renders as "@U…" text unless the user is in the DID map; Slack
  // spells every mention <@U…>. Normalise ours up to Slack's spelling.
  const ours = canonMrkdwn(back.replace(/(?<!<)@([UW][A-Z0-9]{6,})(?!>)/g, "<@$1>"));
  const theirs = canonMrkdwn(inner.text);
  if (ours === theirs) exact++;
  else diffs.push({ ts: inner.ts, channel: v.slackChannelId, ours, theirs });
}

console.log(`${n} distinct messages: ${exact} round-trip exactly (${Math.round((100 * exact) / n)}%), ${diffs.length} differ`);
const unesc = (s: string) => s.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
const classify = (d: any) => {
  if (/^&gt; /m.test(d.ours) && /^> /m.test(d.theirs)) return "quote marker escaped: Slack shows a literal '>' not a blockquote";
  if (unesc(d.ours) === unesc(d.theirs)) return "we escape `&` in body text; Slack's own plaintext does not (ours is the safe spelling)";
  if (d.ours.replace(/`+/g, "`") === d.theirs.replace(/`+/g, "`")) return "code fence: block rendered as inline";
  if (d.ours.replace(/[*_~]/g, "") === d.theirs.replace(/[*_~]/g, "")) return "style marker nesting order";
  return "other";
};
const groups = new Map<string, any[]>();
for (const d of diffs) groups.set(classify(d), [...(groups.get(classify(d)) ?? []), d]);
console.log();
for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(g.length).padStart(4)}  ${k}`);
  if (process.argv.includes("--detail")) {
    for (const d of g.slice(0, 2)) {
      let i = 0; while (i < d.ours.length && i < d.theirs.length && d.ours[i] === d.theirs[i]) i++;
      console.log(`        ${d.ts} first diff @${i}\n          ours  : ${JSON.stringify(d.ours.slice(Math.max(0,i-40), i+40))}\n          slack : ${JSON.stringify(d.theirs.slice(Math.max(0,i-40), i+40))}`);
    }
    for (const d of [] as any[]) {
      console.log(`        ${d.ts}\n          ours  : ${JSON.stringify(d.ours.slice(0, 130))}\n          slack : ${JSON.stringify(d.theirs.slice(0, 130))}`);
    }
  }
}
