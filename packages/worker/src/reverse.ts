// Reverse half: Colibri -> Slack.
//
// Consumes Jetstream-shaped commit events for social.colibri.message and
// social.colibri.reaction from the `atproto-events` queue and mirrors them
// into Slack as the bot user, posted under the author's name and avatar.
//
// Loop safety: every record authored by the bot repo (BOT_DID) is skipped
// here; every Slack event authored by the bot user is skipped in index.ts.
//
// Idempotency: Slack `ts` cannot be chosen, so each mirrored record gets a
// `com.feelingofcomputing.bridge.slackMirror` record on the bot repo, keyed
// by the source rkey, holding the Slack coordinates. A redelivered or
// replayed `create` finds it and does nothing; `update` and `delete` commits
// (which carry no record body on the wire) resolve through it.

import {
  BOT_DID,
  deleteRecord,
  getBskySession,
  getRecord,
  parseAtUri,
  putRecord,
  resolveDid,
  slackTsFromTid,
  type AtprotoEnv,
} from "./atproto";
import { bridgeChannelRkey, channelForRef, channelForSlackId } from "@slack-sync/shared";

// The rkey a mirrored record's `channel` field carries, from a Slack channel id.
const chanRkey = (slackId: string | undefined): string | undefined => {
  const c = slackId ? channelForSlackId(slackId) : undefined;
  return c ? bridgeChannelRkey(c) : undefined;
};
import { emojiNameFor } from "@slack-sync/shared";
import { logEvent } from "./eventlog";
import { renderFacets, escapeMrkdwn, type ColibriFacet } from "./mrkdwn";
import { SLACK_USER_DID_MAP } from "@slack-sync/shared";

export const MIRROR_COLLECTION = "com.feelingofcomputing.bridge.slackMirror";
export const MIRROR_EVENT_TYPE = "colibri_mirror"; // Slack message metadata event_type

// ── wire types ─────────────────────────────────────────────────────────────
export interface JetstreamCommit {
  did: string;
  time_us: number;
  kind: "commit";
  commit: {
    rev?: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    record?: unknown;
    cid?: string;
  };
}
export type JetstreamEvent = JetstreamCommit | { did: string; time_us: number; kind: string };

export function isJetstreamCommit(e: unknown): e is JetstreamCommit {
  const x = e as JetstreamCommit;
  return (
    !!x &&
    typeof x.did === "string" &&
    x.kind === "commit" &&
    !!x.commit &&
    typeof x.commit.collection === "string" &&
    typeof x.commit.rkey === "string" &&
    ["create", "update", "delete"].includes(x.commit.operation)
  );
}

interface ColibriMessage {
  text: string;
  facets?: ColibriFacet[];
  channel?: string;
  parent?: string;
  createdAt?: string;
  attachments?: Array<{ blob?: { ref?: { $link?: string }; mimeType?: string }; name?: string }>;
}
interface ColibriReaction {
  emoji: string;
  parent?: string; // at-uri (client)
  targetMessage?: string; // bare rkey (bridge, pre-2026-09-07)
}
interface Mirror {
  $type: typeof MIRROR_COLLECTION;
  source: string;
  sourceCid?: string;
  slackChannelId: string;
  slackTs: string;
  slackThreadTs?: string;
  emojiName?: string;
  postedAt: string;
}

export interface ReverseEnv extends AtprotoEnv {
  SLACK_BOT_TOKEN?: string;
}

// ── Slack Web API ──────────────────────────────────────────────────────────
async function slack<T = Record<string, unknown>>(
  env: ReverseEnv,
  method: string,
  body: Record<string, unknown>,
  tolerated: string[] = [],
): Promise<T & { ok: boolean; error?: string }> {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {
    throw new Error(`slack ${method}: 429 retry-after=${r.headers.get("Retry-After")}`);
  }
  const j = (await r.json()) as T & { ok: boolean; error?: string };
  if (!j.ok && !tolerated.includes(j.error ?? "")) {
    throw new Error(`slack ${method}: ${j.error ?? r.status}`);
  }
  return j;
}

// ── author resolution (cached per isolate) ─────────────────────────────────
const DID_SLACK_USER = new Map<string, string>(
  Object.entries(SLACK_USER_DID_MAP).map(([slackId, did]) => [did, slackId]),
);
const slackUserForDid = (did: string) => DID_SLACK_USER.get(did);

interface Author {
  name: string;
  handle?: string;
  avatar?: string;
}
const authorCache = new Map<string, Author>();
async function resolveAuthor(did: string): Promise<Author> {
  const hit = authorCache.get(did);
  if (hit) return hit;
  let out: Author | null = null;
  try {
    const r = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (r.ok) {
      const p = (await r.json()) as { handle?: string; displayName?: string; avatar?: string };
      if (p.handle || p.displayName) {
        out = { name: p.displayName?.trim() || p.handle!, handle: p.handle, avatar: p.avatar };
      }
    }
  } catch {}
  if (!out) {
    const doc = await resolveDid(did);
    out = { name: doc.handle ?? did, handle: doc.handle };
  }
  authorCache.set(did, out);
  return out;
}

// ── mirror records ─────────────────────────────────────────────────────────
async function getMirror(rkey: string): Promise<{ cid: string; value: Mirror } | null> {
  const r = await getRecord<Mirror>(BOT_DID, MIRROR_COLLECTION, rkey);
  return r ? { cid: r.cid, value: r.value } : null;
}

// ── reference resolution ───────────────────────────────────────────────────
// A reference to a message (a reply's `parent`, a reaction's target) in either
// spelling -> { did, rkey }. A bare rkey can only have been written by the
// bridge, so it lives on the bot repo.
function parseMessageRef(ref: string | undefined): { did: string; rkey: string } | null {
  if (!ref) return null;
  const at = parseAtUri(ref);
  if (at) return at.collection === "social.colibri.message" ? { did: at.did, rkey: at.rkey } : null;
  return /^[2-7a-z]{13}$/.test(ref) ? { did: BOT_DID, rkey: ref } : null;
}

// Slack coordinates of a message in either repo.
//   bridged message  -> Slack ts decoded from the rkey; channel from the record
//   native message   -> its slackMirror record
async function slackCoordsFor(
  ref: { did: string; rkey: string },
): Promise<{ channel: string; ts: string; threadTs?: string } | null> {
  if (ref.did === BOT_DID) {
    const rec = await getRecord<ColibriMessage>(BOT_DID, "social.colibri.message", ref.rkey);
    if (!rec) return null;
    const ch = channelForRef(rec.value.channel);
    if (!ch) return null;
    const ts = slackTsFromTid(ref.rkey);
    // The bridge writes `parent` = the Slack thread root, so one hop is the root.
    const threadTs = rec.value.parent ? slackTsFromTid(parseMessageRef(rec.value.parent)?.rkey ?? ref.rkey) : ts;
    return { channel: ch.slack, ts, threadTs };
  }
  const m = await getMirror(ref.rkey);
  if (!m) return null;
  return { channel: m.value.slackChannelId, ts: m.value.slackTs, threadTs: m.value.slackThreadTs ?? m.value.slackTs };
}

// ── rendering ──────────────────────────────────────────────────────────────
// Body only: the author is the post's username/icon (chat:write.customize).
// The `@name: ` byline is prepended only when that scope is missing.
const byline = (author: Author, text: string) => `@${escapeMrkdwn(author.name)}: ${text}`;

async function renderMessage(did: string, rec: ColibriMessage): Promise<string> {
  const parts: string[] = [];
  parts.push(
    renderFacets(rec.text ?? "", rec.facets, {
      slackUserForDid,
      slackChannelForRkey: (rkey) => channelForRef(rkey)?.slack,
    }),
  );
  if (Array.isArray(rec.attachments) && rec.attachments.length > 0) {
    const pds = (await resolveDid(did)).pds;
    for (const a of rec.attachments) {
      const cid = a.blob?.ref?.$link;
      if (!cid || !pds) continue;
      const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`;
      parts.push(`\n<${url}|${escapeMrkdwn(a.name || a.blob?.mimeType || "attachment")}>`);
    }
  }
  let text = parts.join("");
  if (text.length > 4000) text = text.slice(0, 3997) + "…";
  return text;
}

// ── handlers ───────────────────────────────────────────────────────────────
export async function handleAtprotoEvent(ev: JetstreamEvent, env: ReverseEnv): Promise<string> {
  if (!isJetstreamCommit(ev)) return `skip kind=${(ev as { kind?: string }).kind}`;
  if (ev.did === BOT_DID) return "skip self (bot repo)";
  const c = ev.commit;
  if (c.collection === "social.colibri.message") {
    return c.operation === "delete" ? unmirrorMessage(ev, env) : mirrorMessage(ev, env);
  }
  if (c.collection === "social.colibri.reaction") {
    return c.operation === "delete" ? unmirrorReaction(ev, env) : mirrorReaction(ev, env);
  }
  return `skip collection=${c.collection}`;
}

async function mirrorMessage(ev: JetstreamCommit, env: ReverseEnv): Promise<string> {
  const rec = ev.commit.record as ColibriMessage | undefined;
  if (!rec || typeof rec.text !== "string") return "skip message without record";
  const ch = channelForRef(rec.channel);
  if (!ch) return `skip unmapped channel ${rec.channel}`;
  const rkey = ev.commit.rkey;
  const source = `at://${ev.did}/social.colibri.message/${rkey}`;

  const existing = await getMirror(rkey);
  if (existing && existing.value.sourceCid && existing.value.sourceCid === ev.commit.cid) {
    return `skip already mirrored ${rkey} -> ${existing.value.slackChannelId}/${existing.value.slackTs}`;
  }

  const sess = await getBskySession(env);
  // Logged before the Slack call so the feed carries the record even if the
  // post fails; see eventlog.ts on the duplicate a retry can produce.
  const note = await logEvent(sess, {
    op: ev.commit.operation === "update" ? "update" : "create",
    subject: source,
    cid: ev.commit.cid,
    channel: bridgeChannelRkey(ch),
    via: "colibri",
  });
  const author = await resolveAuthor(ev.did);
  const text = await renderMessage(ev.did, rec);
  const metadata = { event_type: MIRROR_EVENT_TYPE, event_payload: { uri: source, cid: ev.commit.cid ?? "" } };

  if (existing) {
    await slack(env, "chat.update", {
      channel: existing.value.slackChannelId,
      ts: existing.value.slackTs,
      text,
      metadata,
    });
    await putRecord(sess, MIRROR_COLLECTION, rkey, {
      ...existing.value,
      sourceCid: ev.commit.cid,
    } satisfies Mirror);
    return `updated ${rkey} -> ${existing.value.slackChannelId}/${existing.value.slackTs}${note}`;
  }

  let threadTs: string | undefined;
  let threadNote = "";
  const parentRef = parseMessageRef(rec.parent);
  if (parentRef) {
    const coords = await slackCoordsFor(parentRef);
    if (coords && coords.channel === ch.slack) threadTs = coords.threadTs ?? coords.ts;
    else threadNote = ` (parent ${rec.parent} not resolvable, posted top-level)`;
  }

  const post = { channel: ch.slack, text, metadata, unfurl_links: false, unfurl_media: false } as Record<string, unknown>;
  if (threadTs) post.thread_ts = threadTs;
  // username/icon_url need chat:write.customize; fall back to a plain post if
  // the app was installed without it.
  let res = await slack<{ ts: string }>(
    env,
    "chat.postMessage",
    { ...post, username: `${author.name} (Colibri)`, ...(author.avatar ? { icon_url: author.avatar } : {}) },
    ["missing_scope"],
  );
  if (!res.ok) res = await slack<{ ts: string }>(env, "chat.postMessage", { ...post, text: byline(author, text) });

  await putRecord(sess, MIRROR_COLLECTION, rkey, {
    $type: MIRROR_COLLECTION,
    source,
    sourceCid: ev.commit.cid,
    slackChannelId: ch.slack,
    slackTs: res.ts,
    slackThreadTs: threadTs ?? res.ts,
    postedAt: new Date().toISOString(),
  } satisfies Mirror);
  return `posted ${rkey} -> ${ch.slack}/${res.ts}${threadTs ? ` in thread ${threadTs}` : ""}${threadNote}${note}`;
}

async function unmirrorMessage(ev: JetstreamCommit, env: ReverseEnv): Promise<string> {
  const rkey = ev.commit.rkey;
  const m = await getMirror(rkey);
  // A delete commit carries no record, so the mirror is the only evidence the
  // record was ever FoC's. One we never mirrored cannot be logged.
  if (!m) return `skip delete of unmirrored ${rkey}`;
  const sess = await getBskySession(env);
  const note = await logEvent(sess, {
    op: "delete",
    subject: m.value.source,
    channel: chanRkey(m.value.slackChannelId),
    via: "colibri",
  });
  await slack(env, "chat.delete", { channel: m.value.slackChannelId, ts: m.value.slackTs }, [
    "message_not_found",
    "cant_delete_message",
  ]);
  await deleteRecord(sess, MIRROR_COLLECTION, rkey);
  return `deleted ${rkey} -> ${m.value.slackChannelId}/${m.value.slackTs}${note}`;
}

async function mirrorReaction(ev: JetstreamCommit, env: ReverseEnv): Promise<string> {
  const rec = ev.commit.record as ColibriReaction | undefined;
  if (!rec || typeof rec.emoji !== "string") return "skip reaction without record";
  const rkey = ev.commit.rkey;
  const existing = await getMirror(rkey);
  if (existing) return `skip already mirrored reaction ${rkey}`;
  const target = parseMessageRef(rec.parent ?? rec.targetMessage);
  if (!target) return `skip reaction with unparseable target ${rec.parent ?? rec.targetMessage}`;
  const name = emojiNameFor(rec.emoji);
  if (!name) return `skip reaction: no Slack name for ${JSON.stringify(rec.emoji)}`;
  const coords = await slackCoordsFor(target);
  if (!coords) return `skip reaction: target ${target.did}/${target.rkey} not mirrored`;
  const sess = await getBskySession(env);
  // A resolvable target is what makes a reaction FoC's; the channel comes from
  // the target's Slack side, since the reaction record names no channel.
  const note = await logEvent(sess, {
    op: ev.commit.operation === "update" ? "update" : "create",
    subject: `at://${ev.did}/social.colibri.reaction/${rkey}`,
    cid: ev.commit.cid,
    channel: chanRkey(coords.channel),
    via: "colibri",
  });
  await slack(env, "reactions.add", { channel: coords.channel, timestamp: coords.ts, name }, [
    "already_reacted",
  ]);
  await putRecord(sess, MIRROR_COLLECTION, rkey, {
    $type: MIRROR_COLLECTION,
    source: `at://${ev.did}/social.colibri.reaction/${rkey}`,
    sourceCid: ev.commit.cid,
    slackChannelId: coords.channel,
    slackTs: coords.ts,
    emojiName: name,
    postedAt: new Date().toISOString(),
  } satisfies Mirror);
  return `reacted :${name}: ${rkey} -> ${coords.channel}/${coords.ts}${note}`;
}

async function unmirrorReaction(ev: JetstreamCommit, env: ReverseEnv): Promise<string> {
  const rkey = ev.commit.rkey;
  const m = await getMirror(rkey);
  if (!m || !m.value.emojiName) return `skip delete of unmirrored reaction ${rkey}`;
  const sess = await getBskySession(env);
  const note = await logEvent(sess, {
    op: "delete",
    subject: m.value.source,
    channel: chanRkey(m.value.slackChannelId),
    via: "colibri",
  });
  await slack(
    env,
    "reactions.remove",
    { channel: m.value.slackChannelId, timestamp: m.value.slackTs, name: m.value.emojiName },
    ["no_reaction", "message_not_found"],
  );
  await deleteRecord(sess, MIRROR_COLLECTION, rkey);
  return `unreacted :${m.value.emojiName}: ${rkey}${note}`;
}
