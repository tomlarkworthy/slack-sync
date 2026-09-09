#!/usr/bin/env bun
// Reference implementation of the Slack→Colibri bridge backfill.
// Design: https://wiki.feelingof.com/slack-colibri-bridge/
//
// Reads a day's worth of Slack history JSON (Mariano's dump-history.js output)
// and publishes each message as a `social.colibri.message` record on a bot's
// atproto repo. Two-pass: top-level first, then thread replies with `parent`
// set from a deterministic TID derived from `thread_ts`.
//
// Channel lookup precedence:
//   1. tools/slack-to-colibri-channel.json (community-owner-pre-created channels)
//   2. otherwise deterministic rkey derived from Slack channel.created;
//      live mode lazy-creates the channel + updates the category's channelOrder
//      (needs COLIBRI_COMMUNITY_URI + COLIBRI_CATEGORY_RKEY).
//
// Rich text: when a message carries Slack's structured `blocks` (rich_text),
// it's walked into Colibri `text + facets` covering mentions, channels, links,
// bold/italic/strikethrough/code, code blocks, quotes, lists, and emoji
// (resolved via vendor/feeling-of-computing/conversations/src/emoji-data.js).
// Falls back to the legacy `text` field with regex link extraction when
// `blocks` is absent (older Slack messages, app-posted messages without blocks).
//
// Idempotent: every rkey is derived from Slack identifiers; uses putRecord.
// Dry-run by default. Pass --live to publish.
// --live always needs BSKY_HANDLE + BSKY_APP_PASSWORD.

import { appendFileSync, readFileSync } from "node:fs";
import {
  BOT_DID,
  channelFacetUri,
  channelForSlackId,
  didForSlackUser,
  emojiForName,
  FacetBuilder,
  hash10,
  tidFromMicros,
  tidFromSlackTs,
  walkBlocks,
  type WalkContext,
} from "@slack-sync/shared";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PDS = "https://bsky.social";
const USERS_JSON = "vendor/feeling-of-computing/history/users.json";
const CHANNELS_JSON = "vendor/feeling-of-computing/history/channels.json";
const SLACK_TO_DID_JSON = "tools/slack-to-did.json";
const SLACK_TO_COLIBRI_CHANNEL_JSON = "tools/slack-to-colibri-channel.json";
const EMOJI_DATA_JS =
  "vendor/feeling-of-computing/conversations/src/emoji-data.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "src-day": { type: "string" },
    "src-dir": {
      type: "string",
      default: "vendor/feeling-of-computing/history",
    },
    limit: { type: "string", default: "1000" },
    live: { type: "boolean", default: false },
    "diff-published": { type: "boolean", default: false },
    emit: { type: "string" },
    "skip-unmapped-channels": { type: "boolean", default: false },
    "delay-ms": { type: "string", default: "200" },
  },
});

if (!values["src-day"]) {
  console.error("usage: bun pages/slack-colibri-bridge.ts --src-day YYYY/MM/DD [--limit N] [--live]");
  process.exit(1);
}

const srcDay = values["src-day"]!;
const srcDir = values["src-dir"]!;
const limit = parseInt(values.limit!, 10);
const dryRun = !values.live;
const emitPath = values.emit;
const skipUnmapped = values["skip-unmapped-channels"]!;
const diffPublished = values["diff-published"]! || !!emitPath;
const delayMs = parseInt(values["delay-ms"]!, 10);

// ── reference data ──────────────────────────────────────────────────────────
type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string };
};
const users: SlackUser[] = JSON.parse(readFileSync(USERS_JSON, "utf-8"));
const nameOf = new Map<string, string>(
  users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name || u.id]),
);

type SlackChannel = { id: string; name: string; created: number };
const channels: SlackChannel[] = JSON.parse(readFileSync(CHANNELS_JSON, "utf-8"));
const channelOf = new Map<string, SlackChannel>(channels.map((c) => [c.id, c]));

const SLACK_TO_DID: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(SLACK_TO_DID_JSON, "utf-8"));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      const did = typeof v === "string" ? v : (v as any)?.did;
      if (did) map[k] = did;
    }
  } catch {}
  return map;
})();

const MANUAL_CHANNELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(SLACK_TO_COLIBRI_CHANNEL_JSON, "utf-8"));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_")) continue;
      const rkey = typeof v === "string" ? v : (v as any)?.rkey;
      if (rkey) map[k] = rkey;
    }
  } catch {}
  return map;
})();

// emoji map (Mariano's tables); loaded dynamically because the file lives in a vendor submodule
let EMOJI_MAP = new Map<string, string>();
try {
  const url = pathToFileURL(resolvePath(process.cwd(), EMOJI_DATA_JS)).href;
  const mod: any = await import(url);
  for (const [name, unicode] of mod.entries ?? []) EMOJI_MAP.set(name, unicode);
  for (const [name, unicode] of Object.entries(mod.aliases ?? {}))
    EMOJI_MAP.set(name, unicode as string);
} catch {
  console.error(`(emoji data not loaded from ${EMOJI_DATA_JS}; falling back to :name:)`);
}

// Reaction rkey: synthesise time from the *message* ts so reactions live next to
// their target in TID order; clockId distinguishes the emoji. With 10 bits of
// clockId space and a small number of distinct emojis per message, collisions
// are rare; collisions just merge two emoji into one reaction record, which
// `slackRaw` can correct if we re-derive.
function tidForReaction(messageTs: string, emojiName: string) {
  return tidFromSlackTs(messageTs, hash10(`react:${emojiName}`));
}
function colibriChannelRkey(slackChannelId: string): string {
  const ch = channelOf.get(slackChannelId);
  if (!ch) throw new Error(`unknown slack channel ${slackChannelId}`);
  return tidFromMicros(BigInt(ch.created) * 1_000_000n, hash10(slackChannelId));
}

// ── facet builder ──────────────────────────────────────────────────────────
const enc = new TextEncoder();
const utf8Len = (s: string) => enc.encode(s).length;

// The blocks walker, the channel table, the DID map and the emoji table all
// live in @slack-sync/shared — this package had its own copy of every one of
// them, and each pair drifted. Workspace-specific data still comes from the
// dumps on disk, layered over the shared defaults through WalkContext.
const walkContext: WalkContext = {
  nameForUser: (id) => nameOf.get(id) ?? id,
  // The dump's slack-to-did.json is the source of truth at backfill time; the
  // map bundled into the worker is the same table, exported. Prefer the file.
  didForUser: (id) => SLACK_TO_DID[id] ?? didForSlackUser(id),
  channelRef: (id) => {
    const ch = channelForSlackId(id);
    if (ch) return { name: ch.name, uri: channelFacetUri(ch) };
    // A channel the shared table does not carry. The dump has its name but
    // only a pre-migration rkey, and the client resolves an at-uri — so no
    // facet rather than one it renders as an unresolved chip.
    return undefined;
  },
  emojiFor: (name) => EMOJI_MAP.get(name) ?? emojiForName(name),
};

// ── message builder ─────────────────────────────────────────────────────────

function buildMessage(m: any, channelRkey: string, parentRkey?: string) {
  const author = nameOf.get(m.user || "") || m.user || "unknown";
  const claimedDid = SLACK_TO_DID[m.user || ""];

  const b = new FacetBuilder();
  if (claimedDid)
    b.emit(`@${author}`, {
      $type: "social.colibri.richtext.facet#mention",
      did: claimedDid,
    });
  else b.emit(`@${author}`);
  b.emit(": ");

  if (Array.isArray(m.blocks) && m.blocks.some((blk: any) => blk?.type === "rich_text")) {
    walkBlocks(m.blocks, b, walkContext);
  } else {
    // Legacy fallback: plain text + URL regex link facets + entity decoding.
    legacyTextFallback(m.text || "", b);
  }

  let { text, facets } = b.finish();

  // 2048-char hard cap. If we truncate, drop any facets that extend past the cut.
  if (text.length > 2048) {
    text = text.slice(0, 2048);
    const maxBytes = utf8Len(text);
    facets = facets.filter((f) => f.index.byteEnd <= maxBytes);
  }

  return {
    rkey: tidFromSlackTs(m.ts),
    record: {
      $type: "social.colibri.message",
      text,
      channel: channelRkey,
      createdAt: new Date(parseFloat(m.ts) * 1000).toISOString(),
      facets,
      attachments: [],
      ...(parentRkey ? { parent: parentRkey } : {}),
    },
    hasBlocks: Array.isArray(m.blocks) && m.blocks.length > 0,
    facetCount: facets.length,
    truncated: false,
  };
}

function emojiForReaction(name: string): string {
  // Strip Slack ":name::skin-tone-X:" → look up base name, accept the loss of skin tone in v0.
  const baseName = name.split("::")[0];
  return EMOJI_MAP.get(baseName) ?? `:${name}:`;
}

// Walk a message's `reactions` array → one reaction record per emoji (per
// message). Multiple Slack users with the same emoji collapse into one record
// (they'd all author from the bot anyway and the appview likely dedupes by
// (author, emoji, target)). Multi-reactor count is preserved losslessly in
// `slackRaw`.
function reactionsFor(m: any, targetMessageRkey: string, botDid: string) {
  const out: { rkey: string; record: any; userCount: number; name: string; emoji: string }[] = [];
  for (const r of m.reactions ?? []) {
    if (!r?.name) continue;
    const emoji = emojiForReaction(r.name);
    out.push({
      rkey: tidForReaction(m.ts, r.name),
      name: r.name,
      emoji,
      userCount: (r.users ?? []).length || r.count || 1,
      record: {
        $type: "social.colibri.reaction",
        emoji,
        // `parent` (at-uri) is what Colibri's lexicon requires; `targetMessage` is
        // the pre-lexicon field kept for existing readers. Same as the worker.
        parent: `at://${botDid}/social.colibri.message/${targetMessageRkey}`,
        targetMessage: targetMessageRkey,
      },
    });
  }
  return out;
}

function legacyTextFallback(raw: string, b: FacetBuilder) {
  const decoded = raw
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(decoded)) !== null) {
    if (m.index > last) b.emit(decoded.slice(last, m.index));
    b.emit(m[0], {
      $type: "social.colibri.richtext.facet#link",
      uri: m[0],
    });
    last = m.index + m[0].length;
  }
  if (last < decoded.length) b.emit(decoded.slice(last));
}

// ── load day's data ─────────────────────────────────────────────────────────
const dayPath = `${srcDir}/${srcDay}`;
let topLevelRaw: any[];
let repliesRaw: any[] = [];
// A missing day file is an error, not an empty day: swallowing it made a wrong
// --src-day, a wrong CWD (every path here is relative to the repository root)
// and a day the dump does not cover all look like "0 messages, converged".
try {
  topLevelRaw = JSON.parse(readFileSync(`${dayPath}.json`, "utf-8"));
} catch (e) {
  console.error(`cannot read ${dayPath}.json: ${(e as Error).message}`);
  console.error(`(paths are relative to the repository root; cwd is ${process.cwd()})`);
  process.exit(1);
}
// A day with no thread replies is legitimate, so this one stays optional.
try {
  repliesRaw = JSON.parse(readFileSync(`${dayPath}.replies.json`, "utf-8"));
} catch {}

let tops = topLevelRaw
  .filter(
    (m) =>
      m.type === "message" &&
      !m.subtype &&
      m.text &&
      (!m.thread_ts || m.thread_ts === m.ts),
  )
  .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
  .slice(0, limit);

let replies = repliesRaw
  .filter(
    (m) =>
      m.type === "message" &&
      !m.subtype &&
      m.text &&
      m.thread_ts &&
      m.thread_ts !== m.ts,
  )
  .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
  .slice(0, limit);

const slackChannelsTouched = new Set<string>(
  [...tops, ...replies].map((m) => m.channel_id).filter(Boolean),
);

const channelMap: Record<string, string> = {};
const channelSrc: Record<string, "manual" | "derived"> = {};
for (const cid of slackChannelsTouched) {
  if (MANUAL_CHANNELS[cid]) {
    channelMap[cid] = MANUAL_CHANNELS[cid];
    channelSrc[cid] = "manual";
  } else {
    channelMap[cid] = colibriChannelRkey(cid);
    channelSrc[cid] = "derived";
  }
}
let allManual = [...slackChannelsTouched].every(
  (cid) => channelSrc[cid] === "manual",
);
// A channel with no entry in slack-to-colibri-channel.json has no Colibri
// channel yet. Lazy-create writes it into the *bot's* repo, but the community
// lives on its own DID and the facet at-uri points there — so the chip renders
// unresolved, the bug we just repaired. Until the owner creates the channel,
// drop its messages rather than publish them somewhere they cannot be read.
if (skipUnmapped && !allManual) {
  const dropped = [...slackChannelsTouched].filter((cid) => channelSrc[cid] !== "manual");
  for (const cid of dropped) {
    console.log(`  SKIPPING #${channelOf.get(cid)?.name ?? cid}: no Colibri channel`);
    slackChannelsTouched.delete(cid);
  }
  const keep = (m: any) => !dropped.includes(m.channel_id);
  tops = tops.filter(keep);
  replies = replies.filter(keep);
  allManual = true;
}

// ── preview ─────────────────────────────────────────────────────────────────
console.log(`=== ${srcDay} ===`);
console.log(
  `top-level: ${tops.length}  replies: ${replies.length}  channels: ${slackChannelsTouched.size}`,
);
console.log("");
console.log(`CHANNELS (${allManual ? "manual mapping" : "deterministic / lazy-create"}):`);
for (const cid of slackChannelsTouched) {
  const ch = channelOf.get(cid)!;
  console.log(
    `  ${cid.padEnd(13)}  ${ch.name.padEnd(22)}  → ${channelMap[cid]}  [${channelSrc[cid]}]`,
  );
}

const fmtRow = (
  m: any,
  built: ReturnType<typeof buildMessage>,
  parent?: string,
) => {
  const tags = `${built.hasBlocks ? "B" : "."}${built.facetCount.toString().padStart(2, " ")}`;
  const parentCol = parent ? `parent=${parent}` : "                  ";
  const rxCount = (m.reactions ?? []).length;
  const rxTag = rxCount ? `+${rxCount}r` : "    ";
  return `  ${m.ts}  ${(m.channel_name || "?").padEnd(20)}  ${built.rkey}  ${parentCol}  ${tags} ${rxTag}  '${built.record.text.slice(0, 70).replace(/\n/g, " ")}…'`;
};

console.log("");
console.log("TOP-LEVEL:");
for (const m of tops)
  console.log(fmtRow(m, buildMessage(m, channelMap[m.channel_id])));

console.log("");
console.log("REPLIES:");
for (const m of replies) {
  const parent = tidFromSlackTs(m.thread_ts!);
  console.log(fmtRow(m, buildMessage(m, channelMap[m.channel_id], parent), parent));
}

const allWithReactions: { m: any; targetRkey: string }[] = [];
for (const m of tops)
  if (m.reactions?.length)
    allWithReactions.push({ m, targetRkey: tidFromSlackTs(m.ts) });
for (const m of replies)
  if (m.reactions?.length)
    allWithReactions.push({ m, targetRkey: tidFromSlackTs(m.ts) });

if (allWithReactions.length > 0) {
  console.log("");
  console.log("REACTIONS:");
  for (const { m, targetRkey } of allWithReactions) {
    // The preview runs before the login that defines `did`; the bot's identity
    // is fixed, so use it. Reading `did` here threw
    // "Cannot access 'did' before initialization" on any day with reactions —
    // i.e. --dry-run was broken for most days.
    for (const r of reactionsFor(m, targetRkey, BOT_DID)) {
      console.log(
        `  ${m.ts}  target=${targetRkey}  rkey=${r.rkey}  ${r.emoji} (:${r.name}: ×${r.userCount})`,
      );
    }
  }
}

// ── the records a live run would write ─────────────────────────────────────
// Exactly what --live puts, minus the channel/category bootstrap: top-level
// messages, replies, reactions. --emit writes them as JSONL for
// scripts/post-records.ts, which publishes them through the worker — the bot's
// app password exists only as a Worker secret, so the CLI derives and the
// worker writes.
//
// --diff-published narrows that to the records that would actually change. A
// re-run rewrites every record for the day, so this is how the blast radius of
// a repair is known before it writes; on a day that was never backfilled every
// record is new and it reports them all.
if (diffPublished) {
  const APPVIEW_PDS = "https://jellybaby.us-east.host.bsky.network";
  // The PDS returns CBOR-decoded maps in canonical key order, which is not the
  // order we build them in — compare by value, or every record looks changed.
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
        : v;
  const shapeOf = (facets: any[] | undefined) =>
    (facets ?? [])
      .flatMap((f: any) => (f.features ?? []).map((x: any) => String(x.$type).split("#")[1]))
      .sort()
      .join(",");
  const toPut: { collection: string; rkey: string; record: any }[] = [
    ...tops.map((m) => buildMessage(m, channelMap[m.channel_id])),
    ...replies.map((m) => buildMessage(m, channelMap[m.channel_id], tidFromSlackTs(m.thread_ts!))),
  ].map((b) => ({ collection: "social.colibri.message", rkey: b.rkey, record: b.record }));
  for (const { m, targetRkey } of allWithReactions)
    for (const r of reactionsFor(m, targetRkey, BOT_DID))
      toPut.push({ collection: "social.colibri.reaction", rkey: r.rkey, record: r.record });

  const emit: typeof toPut = [];
  let same = 0, fresh = 0;
  const changed: string[] = [];
  for (const item of toPut) {
    const { collection, rkey, record } = item;
    const u = new URL(`${APPVIEW_PDS}/xrpc/com.atproto.repo.getRecord`);
    u.searchParams.set("repo", BOT_DID);
    u.searchParams.set("collection", collection);
    u.searchParams.set("rkey", rkey);
    const r = await fetch(u);
    if (!r.ok) {
      fresh++;
      emit.push(item);
      changed.push(`  ${rkey}  NEW  ${collection.split(".").pop()}`);
      continue;
    }
    const cur = ((await r.json()) as any).value;
    const dText = cur.text !== record.text;
    const dRest = JSON.stringify(stable(cur)) !== JSON.stringify(stable(record));
    if (!dRest) {
      same++;
      continue;
    }
    emit.push(item);
    changed.push(
      `  ${rkey}  ${dText ? "text" : "    "}\n` +
        (dText ? `    - ${JSON.stringify(cur.text?.slice(0, 160))}\n    + ${JSON.stringify(record.text?.slice(0, 160))}\n` : "") +
        (shapeOf(cur.facets) !== shapeOf(record.facets)
          ? `    - [${shapeOf(cur.facets)}]\n    + [${shapeOf(record.facets)}]\n`
          : `    - ${JSON.stringify(cur)}\n    + ${JSON.stringify(record)}\n`),
    );
  }
  console.log("");
  console.log(
    `DIFF vs PUBLISHED: ${changed.length} would change (${fresh} new), ${same} unchanged, of ${toPut.length}`,
  );
  for (const line of changed) console.log(line);
  // Emit only what differs: a re-run of a backfilled day is then a no-op, and
  // a day never backfilled emits all of it.
  if (emitPath && emit.length)
    appendFileSync(emitPath, emit.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

if (dryRun) {
  console.log("");
  console.log("(dry-run; pass --live to publish)");
  process.exit(0);
}

// ── live mode ───────────────────────────────────────────────────────────────
const HANDLE = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE || !PASSWORD) {
  console.error("set BSKY_HANDLE, BSKY_APP_PASSWORD");
  process.exit(1);
}
const COMMUNITY_URI = process.env.COLIBRI_COMMUNITY_URI;
const CATEGORY_RKEY = process.env.COLIBRI_CATEGORY_RKEY;
if (!allManual && (!COMMUNITY_URI || !CATEGORY_RKEY)) {
  console.error("some channels need lazy-create; set COLIBRI_COMMUNITY_URI + COLIBRI_CATEGORY_RKEY,");
  console.error(`or add them to ${SLACK_TO_COLIBRI_CHANNEL_JSON}`);
  process.exit(1);
}
const COMMUNITY_RKEY = COMMUNITY_URI?.split("/").pop();

const sessRes = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
});
if (!sessRes.ok) throw new Error(`login: ${await sessRes.text()}`);
const sess: any = await sessRes.json();
const did = sess.did as string;
// The preview above assumed BOT_DID; publishing as anyone else would write the
// community's history into the wrong repo.
if (did !== BOT_DID) {
  throw new Error(`logged in as ${did}, expected ${BOT_DID} — check BSKY_HANDLE`);
}
const auth = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${sess.accessJwt}`,
};
console.error(`logged in as @${sess.handle} (${did})`);

async function put(collection: string, rkey: string, record: any) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ repo: did, collection, rkey, record }),
  });
  if (!r.ok)
    throw new Error(`putRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}
async function get(repo: string, collection: string, rkey: string): Promise<{ uri: string; cid: string; value: any } | null> {
  const r = await fetch(
    `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=${collection}&rkey=${rkey}`,
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getRecord ${collection}/${rkey}: ${r.status}`);
  return (await r.json()) as { uri: string; cid: string; value: any };
}

if (!allManual) {
  const catRes = await get(did, "social.colibri.category", CATEGORY_RKEY!);
  if (!catRes) {
    console.error(`category ${CATEGORY_RKEY} not found on ${did}; create it first`);
    process.exit(1);
  }
  const categoryRecord: any = catRes.value;
  const existingOrder: string[] = categoryRecord.channelOrder || [];
  const newRkeys: string[] = [];

  for (const cid of slackChannelsTouched) {
    if (channelSrc[cid] === "manual") continue;
    const rkey = channelMap[cid];
    const ch = channelOf.get(cid)!;
    const existing = await get(did, "social.colibri.channel", rkey);
    if (!existing) {
      await put("social.colibri.channel", rkey, {
        $type: "social.colibri.channel",
        name: ch.name,
        type: "text",
        category: CATEGORY_RKEY,
        community: COMMUNITY_RKEY,
        ownerOnly: false,
      });
      console.error(`  created #${ch.name} (${rkey})`);
    }
    if (!existingOrder.includes(rkey)) newRkeys.push(rkey);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (newRkeys.length > 0) {
    categoryRecord.channelOrder = [...existingOrder, ...newRkeys];
    await put("social.colibri.category", CATEGORY_RKEY!, categoryRecord);
    console.error(`  category.channelOrder +${newRkeys.length}`);
  }
}

console.error("");
console.error("top-level…");
let okT = 0, failT = 0;
for (const m of tops) {
  const built = buildMessage(m, channelMap[m.channel_id]);
  try {
    await put("social.colibri.message", built.rkey, built.record);
    okT++;
  } catch (e) {
    failT++;
    console.error(`  fail ${m.ts}: ${e}`);
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
}

console.error("");
console.error("replies…");
let okR = 0, failR = 0;
for (const m of replies) {
  const parent = tidFromSlackTs(m.thread_ts!);
  const built = buildMessage(m, channelMap[m.channel_id], parent);
  try {
    await put("social.colibri.message", built.rkey, built.record);
    okR++;
  } catch (e) {
    failR++;
    console.error(`  fail ${m.ts}: ${e}`);
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
}

console.error("");
console.error("reactions…");
let okX = 0, failX = 0;
for (const { m, targetRkey } of allWithReactions) {
  for (const r of reactionsFor(m, targetRkey, did)) {
    try {
      await put("social.colibri.reaction", r.rkey, r.record);
      okX++;
    } catch (e) {
      failX++;
      console.error(`  fail ${m.ts} ${r.name}: ${e}`);
    }
    if (delayMs > 0) await new Promise((rs) => setTimeout(rs, delayMs));
  }
}

console.error("");
console.error(`done: ${okT} top-level, ${okR} replies, ${okX} reactions, ${failT + failR + failX} failed`);
