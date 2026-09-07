#!/usr/bin/env bun
// Backfill com.feelingofcomputing.bridge.event so a reader can switch over to
// the feed alone, instead of crawling the bot repo and every member repo first.
//
// One `create` entry per FoC record that already exists, in both directions:
//   bot repo      social.colibri.message / .reaction   (Slack-origin)
//   member repos  social.colibri.message / .reaction   (Colibri-native)
// Member repos come from `social.colibri.member` on the community, and a native
// record only counts as FoC's if its channel maps -- a member's repo also holds
// their other communities' rooms.
//
// rkey is derived from the SUBJECT's own TID, not from now, so the backfilled
// entries interleave in the order the content was written and all sort before
// the entries the live bridge has been minting since deploy. A tailer's "stop
// at the last rkey I hold" keeps working across the switch-over. Entries carry
// `backfill: true` and `at` = the record's own time, because there was no
// observation to timestamp.
//
// Idempotent and resumable: every subject already present in the collection is
// skipped, so a run interrupted by a rate limit continues where it stopped.
//
// Dry run by default. --live needs BSKY_HANDLE + BSKY_APP_PASSWORD.
//
//   bun packages/backfill/src/events.ts
//   BSKY_HANDLE=… BSKY_APP_PASSWORD=… bun packages/backfill/src/events.ts --live

import { parseArgs } from "node:util";
import { BOT_DID, tidFromMicros } from "../../worker/src/atproto";
import { channelForRef, COMMUNITY_DID } from "../../worker/src/channels";
import { buildEvent, EVENT_COLLECTION, type BridgeEvent } from "../../worker/src/eventlog";

const PDS = "https://bsky.social";
const BOT_PDS = "https://jellybaby.us-east.host.bsky.network";
const COMMUNITY_PDS = "https://colibri.social";
const MESSAGES = "social.colibri.message";
const REACTIONS = "social.colibri.reaction";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    live: { type: "boolean", default: false },
    // A create costs 3 of the PDS's 5000 points/hour, so one run stays under.
    limit: { type: "string", default: "1600" },
    batch: { type: "string", default: "50" },
    "delay-ms": { type: "string", default: "1000" },
  },
});
const LIVE = values.live;
const LIMIT = parseInt(values.limit!, 10);
const BATCH = parseInt(values.batch!, 10);
const DELAY = parseInt(values["delay-ms"]!, 10);

// ── reads ──────────────────────────────────────────────────────────────────
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}\n${await r.text()}`);
  return (await r.json()) as T;
}

interface Rec {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

async function listAll(pds: string, repo: string, collection: string): Promise<Rec[]> {
  const out: Rec[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page++) {
    const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", repo);
    u.searchParams.set("collection", collection);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    let j: { records?: Rec[]; cursor?: string };
    try {
      j = await getJson(u.toString());
    } catch (e) {
      // A repo that has never held this collection answers 400, not an empty page.
      if (String(e).includes("400")) return out;
      throw e;
    }
    out.push(...(j.records ?? []));
    cursor = j.cursor;
    if (!cursor || !(j.records ?? []).length) break;
  }
  return out;
}

const pdsCache = new Map<string, string>();
async function pdsFor(did: string): Promise<string> {
  if (did === BOT_DID) return BOT_PDS;
  const hit = pdsCache.get(did);
  if (hit) return hit;
  const doc = await getJson<{ service?: Array<{ id: string; type: string; serviceEndpoint: string }> }>(
    `https://plc.directory/${did}`,
  );
  const pds =
    doc.service?.find((s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer")
      ?.serviceEndpoint ?? PDS;
  pdsCache.set(did, pds);
  return pds;
}

// ── TID helpers ────────────────────────────────────────────────────────────
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
function microsFromTid(tid: string): bigint {
  let n = 0n;
  for (const c of tid) {
    const v = TID_ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`bad tid ${tid}`);
    n = (n << 5n) | BigInt(v);
  }
  return n >> 10n;
}
const rkeyOf = (uri: string) => uri.split("/").pop()!;
const didOf = (uri: string) => uri.slice(5).split("/")[0]!;

// A message's channel in either spelling -> the bare rkey the bridge writes.
const channelRkey = (ref: unknown): string | undefined =>
  typeof ref === "string" ? channelForRef(ref)?.oldRkey : undefined;

// A reaction names its target as an at-uri (`parent`) or a bare rkey on the bot
// repo (`targetMessage`, pre-2026-09-07).
function targetUri(v: Record<string, unknown>): string | undefined {
  const p = v.parent;
  if (typeof p === "string" && p.startsWith("at://")) return p;
  const t = v.targetMessage ?? p;
  return typeof t === "string" && /^[2-7a-z]{13}$/.test(t)
    ? `at://${BOT_DID}/${MESSAGES}/${t}`
    : undefined;
}

// ── gather ─────────────────────────────────────────────────────────────────
console.log(LIVE ? "LIVE" : "dry run", "— reading the corpus\n");

const members = (
  await listAll(COMMUNITY_PDS, COMMUNITY_DID, "social.colibri.member")
).map((r) => String(r.value.subject));
const repos = [BOT_DID, ...members.filter((d) => d !== BOT_DID)];
console.log(`community members: ${members.length}; repos to read: ${repos.length}`);

const messages: Rec[] = [];
const reactions: Rec[] = [];
for (const did of repos) {
  const pds = await pdsFor(did);
  const [m, r] = await Promise.all([listAll(pds, did, MESSAGES), listAll(pds, did, REACTIONS)]);
  messages.push(...m);
  reactions.push(...r);
  if (m.length || r.length) {
    console.log(`  ${did}  messages ${String(m.length).padStart(4)}  reactions ${String(r.length).padStart(4)}`);
  }
}

// channel per message uri; a native message in another community maps to nothing
const channelOf = new Map<string, string | undefined>();
for (const m of messages) {
  const did = didOf(m.uri);
  // The bot writes the pre-migration bare rkey; a client writes an at-uri.
  channelOf.set(m.uri, channelRkey(m.value.channel) ?? (did === BOT_DID ? String(m.value.channel ?? "") || undefined : undefined));
}

// ── decide ─────────────────────────────────────────────────────────────────
interface Planned {
  rkey: string;
  event: BridgeEvent;
}
const planned: Planned[] = [];
const skipped = { foreign: 0, unresolvedTarget: 0, alreadyLogged: 0 };

const existing = await listAll(BOT_PDS, BOT_DID, EVENT_COLLECTION);
const loggedSubjects = new Set(existing.map((e) => String(e.value.subject)));
const usedRkeys = new Set(existing.map((e) => rkeyOf(e.uri)));
console.log(`\nevents already in the collection: ${existing.length}`);

function mint(subjectRkey: string): string {
  let micros = microsFromTid(subjectRkey);
  let rkey = tidFromMicros(micros, 0);
  while (usedRkeys.has(rkey)) rkey = tidFromMicros(++micros, 0);
  usedRkeys.add(rkey);
  return rkey;
}

function plan(rec: Rec, channel: string | undefined, at: string) {
  if (loggedSubjects.has(rec.uri)) {
    skipped.alreadyLogged++;
    return;
  }
  planned.push({
    rkey: mint(rkeyOf(rec.uri)),
    event: buildEvent(
      {
        op: "create",
        subject: rec.uri,
        cid: rec.cid,
        channel,
        via: didOf(rec.uri) === BOT_DID ? "slack" : "colibri",
        backfill: true,
      },
      at,
    ),
  });
}

const timeOf = (rec: Rec): string =>
  typeof rec.value.createdAt === "string"
    ? rec.value.createdAt
    : new Date(Number(microsFromTid(rkeyOf(rec.uri)) / 1000n)).toISOString();

for (const m of messages) {
  const ch = channelOf.get(m.uri);
  // A bot-repo record is FoC's by construction. A native one is only FoC's if
  // its channel maps -- members belong to other communities too.
  if (didOf(m.uri) !== BOT_DID && !ch) {
    skipped.foreign++;
    continue;
  }
  plan(m, ch, timeOf(m));
}
for (const r of reactions) {
  const t = targetUri(r.value);
  const ch = t ? channelOf.get(t) : undefined;
  if (didOf(r.uri) !== BOT_DID && !ch) {
    skipped.foreign++;
    continue;
  }
  if (!t || !channelOf.has(t)) skipped.unresolvedTarget++;
  plan(r, ch, timeOf(r));
}

planned.sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
const batchPlan = planned.slice(0, LIMIT);

console.log(`
messages read        ${String(messages.length).padStart(5)}
reactions read       ${String(reactions.length).padStart(5)}
already logged       ${String(skipped.alreadyLogged).padStart(5)}
skipped, not FoC's   ${String(skipped.foreign).padStart(5)}
reactions w/o channel${String(skipped.unresolvedTarget).padStart(5)}   (logged, channel omitted)
to write             ${String(planned.length).padStart(5)}   this run: ${batchPlan.length}
write points         ${String(batchPlan.length * 3).padStart(5)}   (PDS allows 5000/hour)
`);

for (const p of batchPlan.slice(0, 3)) console.log("  first:", p.rkey, JSON.stringify(p.event));
for (const p of batchPlan.slice(-2)) console.log("  last: ", p.rkey, JSON.stringify(p.event));

if (planned.length > batchPlan.length) {
  console.log(
    `\n${planned.length - batchPlan.length} left after this run — re-run in an hour, it resumes`,
  );
}

if (!LIVE) {
  console.log("\ndry run — pass --live to write");
  process.exit(0);
}

// ── write ──────────────────────────────────────────────────────────────────
const HANDLE = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE || !PASSWORD) {
  console.error("--live needs BSKY_HANDLE + BSKY_APP_PASSWORD");
  process.exit(1);
}
const sess = await getJson<{ did: string; accessJwt: string }>(
  `${PDS}/xrpc/com.atproto.server.createSession`,
).catch(async () => {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status} ${await r.text()}`);
  return (await r.json()) as { did: string; accessJwt: string };
});
if (sess.did !== BOT_DID) throw new Error(`logged in as ${sess.did}, expected the bot`);

let written = 0;
for (let i = 0; i < batchPlan.length; i += BATCH) {
  const chunk = batchPlan.slice(i, i + BATCH);
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.applyWrites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.accessJwt}` },
    body: JSON.stringify({
      repo: sess.did,
      writes: chunk.map((p) => ({
        $type: "com.atproto.repo.applyWrites#create",
        collection: EVENT_COLLECTION,
        rkey: p.rkey,
        value: p.event,
      })),
    }),
  });
  if (r.status === 429) {
    console.error(`\nrate limited after ${written}; re-run to resume (reset ${r.headers.get("ratelimit-reset")})`);
    process.exit(2);
  }
  if (!r.ok) throw new Error(`applyWrites ${r.status} ${await r.text()}`);
  written += chunk.length;
  console.log(`  ${written}/${batchPlan.length}`);
  if (DELAY) await new Promise((res) => setTimeout(res, DELAY));
}
console.log(`\nwrote ${written}`);
