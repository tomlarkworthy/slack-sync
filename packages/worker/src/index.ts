// Cloudflare Worker entry for the FoC Slack -> Colibri bridge.
//
// Two halves in one script:
//
//   fetch() — Slack Events API receiver. HMAC-verifies, short-circuits
//     url_verification challenges, and otherwise enqueues the envelope to
//     a CF Queue. Returns 200 to Slack within milliseconds, well inside
//     the 3-second ack budget — no PDS-blocking work happens here.
//
//   queue() — drains the queue. For each event:
//     1. Write a `com.feelingofcomputing.bridge.slackRaw` record (lossless
//        capture of the raw envelope, keyed by event_id, idempotent on
//        Slack redelivery).
//     2. Dispatch by event.type:
//          message          -> publish social.colibri.message
//          reaction_added   -> publish social.colibri.reaction
//          reaction_removed -> delete  social.colibri.reaction
//     Throws on failure -> CF retries up to max_retries -> dead-letters.
//
// Channel map is hardcoded — channel additions require a redeploy. Will
// migrate to KV once the channel set is no longer hand-maintained.

import {
  aliases as EMOJI_ALIASES,
  entries as EMOJI_ENTRIES,
} from "./emoji-data";
import { didForSlackUser } from "./slack-to-did";

const PDS = "https://bsky.social";
const BOT_SLACK_USER_ID = "U0B7685PHGD"; // focbridge; skip its own join messages
const SLACK_RAW_COLLECTION = "com.feelingofcomputing.bridge.slackRaw";

// Slack channel id -> Colibri channel rkey on the community owner's repo.
// Mirror of tools/slack-to-colibri-channel.json on the backfill side.
// All under new "Feeling of Computing" community (3mn5nudqvhs2x) on
// did:plc:j7nm3lrd5h7fm3sfhcv3lhfv.
const CHANNEL_MAP: Record<string, string> = {
  C01932BJGE8: "3mn5tlwafrh2k", // present-company
  CCL5VVBAN:   "3mn5tmbyexz27", // share-your-work
  C5T9GPWFL:   "3mn5tmllqd72d", // thinking-together
  C050QK4917D: "3mn5tlntcfa2f", // of-ai
  C03RR0W5DGC: "3mn5tk5v4yr2s", // devlog-together
  C5U3SEW6A:   "3mn5tle5l7c2z", // linking-together
  CEXED56UR:   "3mn5tjjdnai2t", // administrivia
  CGMJ7323Z:   "3mn5tjsyuvt2t", // announcements
  CC2JRGVLK:   "3mn5tkvfo2j2s", // introduce-yourself
  C0120A3L30R: "3mn5tn53kwy2w", // two-minute-week
  C0B7BGKT8MP: "3mn5tckh3ij24", // test-01
};

export interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
  EVENTS: Queue<SlackEventCallback>;
}

// ── shared types ────────────────────────────────────────────────────────────
interface SlackUrlVerification {
  type: "url_verification";
  token: string;
  challenge: string;
}
interface SlackEventCallback {
  type: "event_callback";
  team_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}
type SlackEnvelope = SlackUrlVerification | SlackEventCallback;
type SlackEvent = SlackMessageEvent | SlackReactionEvent | { type: string };

interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
}
interface SlackReactionEvent {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction: string;
  item?: { type: string; channel: string; ts: string };
  event_ts?: string;
}
type SlackBlock = { type: string; elements?: SlackBlockElement[] };
type SlackBlockElement = {
  type: string;
  elements?: SlackBlockElement[];
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  name?: string;
  unicode?: string;
  range?: string;
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
};

// ── HMAC ────────────────────────────────────────────────────────────────────
async function verifySlackSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;
  if (!signatureHeader.startsWith("v0=")) return false;
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 60 * 5) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`v0:${timestampHeader}:${rawBody}`),
  );
  const computed =
    "v0=" +
    Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// ── TID derivation (matches backfill) ──────────────────────────────────────
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
function tidFromMicros(microseconds: bigint, clockId = 0): string {
  let n = (microseconds << 10n) | BigInt(clockId & 0x3ff);
  const chars: string[] = [];
  for (let i = 0; i < 13; i++) {
    chars.push(TID_ALPHABET[Number(n & 0x1fn)]!);
    n >>= 5n;
  }
  return chars.reverse().join("");
}
function tidFromSlackTs(ts: string, clockId = 0): string {
  const [sec, usecRaw = ""] = ts.split(".");
  const usec = (usecRaw + "000000").slice(0, 6);
  return tidFromMicros(BigInt(sec!) * 1_000_000n + BigInt(usec), clockId);
}
function hash10(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) & 0x3ff;
}

// ── emoji map ───────────────────────────────────────────────────────────────
const EMOJI_MAP = new Map<string, string>();
for (const [name, unicode] of EMOJI_ENTRIES as Array<[string, string]>) {
  EMOJI_MAP.set(name, unicode);
}
for (const [name, unicode] of Object.entries(EMOJI_ALIASES)) {
  EMOJI_MAP.set(name, unicode as string);
}
function emojiForName(name: string): string {
  const base = name.split("::")[0]!;
  return EMOJI_MAP.get(base) ?? `:${name}:`;
}

// ── facet builder + blocks walker ──────────────────────────────────────────
const utf8enc = new TextEncoder();
const utf8Len = (s: string) => utf8enc.encode(s).length;

type Facet = {
  $type: "social.colibri.richtext.facet";
  index: { byteStart: number; byteEnd: number };
  features: unknown[];
};

class FacetBuilder {
  parts: string[] = [];
  facets: Facet[] = [];
  byteOffset = 0;
  emit(text: string, ...features: unknown[]) {
    if (!text) return;
    const start = this.byteOffset;
    this.parts.push(text);
    this.byteOffset += utf8Len(text);
    if (features.length > 0) {
      this.facets.push({
        $type: "social.colibri.richtext.facet",
        index: { byteStart: start, byteEnd: this.byteOffset },
        features,
      });
    }
  }
  finish() {
    return { text: this.parts.join(""), facets: this.facets };
  }
}

function walkBlocks(
  blocks: SlackBlock[],
  b: FacetBuilder,
  resolveUser: (id: string) => string,
) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== "rich_text") continue;
    walkRichTextElements(block.elements ?? [], b, resolveUser);
    if (i < blocks.length - 1) b.emit("\n");
  }
}

function walkRichTextElements(
  elements: SlackBlockElement[],
  b: FacetBuilder,
  resolveUser: (id: string) => string,
) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    switch (el.type) {
      case "rich_text_section":
        for (const item of el.elements ?? []) walkSectionItem(item, b, resolveUser);
        break;
      case "rich_text_quote": {
        const sub = new FacetBuilder();
        for (const item of el.elements ?? []) walkSectionItem(item, sub, resolveUser);
        const quoted = sub
          .finish()
          .text.split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        b.emit(quoted);
        break;
      }
      case "rich_text_preformatted": {
        const pre = new FacetBuilder();
        for (const item of el.elements ?? []) walkSectionItem(item, pre, resolveUser);
        const preText = pre.finish().text;
        if (preText) {
          b.emit("\n");
          const start = b.byteOffset;
          b.parts.push(preText);
          b.byteOffset += utf8Len(preText);
          b.facets.push({
            $type: "social.colibri.richtext.facet",
            index: { byteStart: start, byteEnd: b.byteOffset },
            features: [{ $type: "social.colibri.richtext.facet#code" }],
          });
          b.emit("\n");
        }
        break;
      }
    }
    if (i < elements.length - 1) b.emit("\n");
  }
}

function walkSectionItem(
  item: SlackBlockElement,
  b: FacetBuilder,
  resolveUser: (id: string) => string,
) {
  switch (item.type) {
    case "text": {
      const features: unknown[] = [];
      const s = item.style ?? {};
      if (s.bold) features.push({ $type: "social.colibri.richtext.facet#bold" });
      if (s.italic) features.push({ $type: "social.colibri.richtext.facet#italic" });
      if (s.strike) features.push({ $type: "social.colibri.richtext.facet#strikethrough" });
      if (s.code) features.push({ $type: "social.colibri.richtext.facet#code" });
      b.emit(item.text ?? "", ...features);
      break;
    }
    case "link":
      if (item.url)
        b.emit(item.text || item.url, {
          $type: "social.colibri.richtext.facet#link",
          uri: item.url,
        });
      break;
    case "user":
      if (item.user_id) {
        const did = didForSlackUser(item.user_id);
        const text = `@${resolveUser(item.user_id)}`;
        if (did) {
          b.emit(text, {
            $type: "social.colibri.richtext.facet#mention",
            did,
          });
        } else {
          b.emit(text);
        }
      }
      break;
    case "channel":
      if (item.channel_id) b.emit(`#${item.channel_id}`);
      break;
    case "emoji": {
      let unicode = "";
      if (item.unicode) {
        try {
          unicode = String.fromCodePoint(
            ...item.unicode.split("-").map((h) => parseInt(h, 16)),
          );
        } catch {}
      }
      b.emit(unicode || emojiForName(item.name ?? ""));
      break;
    }
    case "broadcast":
      if (item.range) b.emit(`@${item.range}`);
      break;
  }
}

// ── Slack user resolution (cached per isolate) ─────────────────────────────
const userNameCache = new Map<string, string>();
async function getDisplayName(userId: string, botToken: string): Promise<string> {
  const hit = userNameCache.get(userId);
  if (hit) return hit;
  try {
    const r = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const j = (await r.json()) as {
      ok: boolean;
      user?: { name?: string; real_name?: string; profile?: { display_name?: string } };
    };
    const name =
      j?.user?.profile?.display_name ||
      j?.user?.real_name ||
      j?.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ── bsky session (cached per isolate) ──────────────────────────────────────
let cachedSession: { did: string; accessJwt: string; expiresAt: number } | null = null;
async function getBskySession(env: Env) {
  if (cachedSession && cachedSession.expiresAt > Date.now() + 60_000) {
    return cachedSession;
  }
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  });
  if (!r.ok) throw new Error(`bsky login: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { did: string; accessJwt: string };
  cachedSession = { ...j, expiresAt: Date.now() + 90 * 60 * 1000 };
  return cachedSession;
}

async function putRecord(
  sess: { did: string; accessJwt: string },
  collection: string,
  rkey: string,
  record: unknown,
) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({ repo: sess.did, collection, rkey, record }),
  });
  if (!r.ok) throw new Error(`putRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function deleteRecord(
  sess: { did: string; accessJwt: string },
  collection: string,
  rkey: string,
) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({ repo: sess.did, collection, rkey }),
  });
  // 404 = already gone; treat as success (idempotent)
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`deleteRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}

// ── slackRaw lossless capture ──────────────────────────────────────────────
// rkey = sanitised event_id (Slack guarantees unique per event). Storing the
// full envelope under the bot's repo means any future change to derivation
// or any Colibri lexicon churn can be re-played without re-pulling Slack.
function rkeyForSlackRaw(eventId: string): string {
  // Slack event ids are alphanumeric (e.g. Ev0B840SK48Y). Lowercase for
  // safety; atproto rkeys allow [a-zA-Z0-9._:~-]{1,512}.
  return eventId.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function writeSlackRaw(
  envelope: SlackEventCallback,
  env: Env,
): Promise<string> {
  const eventId = envelope.event_id;
  if (!eventId) return "skip slackRaw: no event_id";
  const ev = envelope.event;
  const eventType = ev?.type ?? "unknown";
  // For messages, channel + ts live on event; for reactions, on event.item.
  const channelId =
    (ev as SlackMessageEvent | undefined)?.channel ??
    (ev as SlackReactionEvent | undefined)?.item?.channel ??
    "";
  const slackTs =
    (ev as SlackMessageEvent | undefined)?.ts ??
    (ev as SlackReactionEvent | undefined)?.item?.ts ??
    (ev as SlackReactionEvent | undefined)?.event_ts ??
    "";
  const sess = await getBskySession(env);
  const rkey = rkeyForSlackRaw(eventId);
  await putRecord(sess, SLACK_RAW_COLLECTION, rkey, {
    $type: SLACK_RAW_COLLECTION,
    slackChannelId: channelId,
    slackTs,
    eventType,
    payload: envelope,
    capturedAt: new Date().toISOString(),
  });
  return `slackRaw rkey=${rkey} type=${eventType}`;
}

// ── message publish ────────────────────────────────────────────────────────
async function publishMessage(
  ev: SlackMessageEvent,
  env: Env,
  eventId: string,
): Promise<string> {
  if (ev.subtype) return `skip subtype=${ev.subtype}`;
  if (ev.user === BOT_SLACK_USER_ID) return "skip self";
  if (!ev.channel || !ev.ts || !ev.text) return "skip missing-fields";

  const colibriChannel = CHANNEL_MAP[ev.channel];
  if (!colibriChannel) return `skip unmapped channel ${ev.channel}`;

  const author = ev.user ? await getDisplayName(ev.user, env.SLACK_BOT_TOKEN!) : "unknown";
  const resolveUser = (id: string) => userNameCache.get(id) ?? id;
  const authorDid = ev.user ? didForSlackUser(ev.user) : undefined;

  const b = new FacetBuilder();
  if (authorDid) {
    b.emit(`@${author}`, {
      $type: "social.colibri.richtext.facet#mention",
      did: authorDid,
    });
  } else {
    b.emit(`@${author}`);
  }
  b.emit(": ");
  if (Array.isArray(ev.blocks) && ev.blocks.some((x) => x?.type === "rich_text")) {
    walkBlocks(ev.blocks, b, resolveUser);
  } else {
    b.emit(ev.text);
  }
  let { text, facets } = b.finish();
  if (text.length > 2048) {
    text = text.slice(0, 2048);
    const maxBytes = utf8Len(text);
    facets = facets.filter((f) => f.index.byteEnd <= maxBytes);
  }

  const rkey = tidFromSlackTs(ev.ts);
  const parentRkey =
    ev.thread_ts && ev.thread_ts !== ev.ts ? tidFromSlackTs(ev.thread_ts) : undefined;

  const record: Record<string, unknown> = {
    $type: "social.colibri.message",
    text,
    channel: colibriChannel,
    createdAt: new Date(parseFloat(ev.ts) * 1000).toISOString(),
    facets,
    attachments: [],
  };
  if (parentRkey) record["parent"] = parentRkey;

  const sess = await getBskySession(env);
  await putRecord(sess, "social.colibri.message", rkey, record);
  return `published message rkey=${rkey} channel=${ev.channel}->${colibriChannel}`;
}

// ── reaction publish / delete ──────────────────────────────────────────────
function tidForReaction(messageTs: string, emojiName: string): string {
  // Same scheme as backfill: time = message ts, clock id = 10b hash of name.
  // Collisions on a single message are bounded by 2^10 distinct emojis (rare).
  return tidFromSlackTs(messageTs, hash10(`react:${emojiName}`));
}

async function publishReaction(
  ev: SlackReactionEvent,
  env: Env,
  _eventId: string,
): Promise<string> {
  if (!ev.item || ev.item.type !== "message") return `skip reaction on item.type=${ev.item?.type}`;
  const colibriChannel = CHANNEL_MAP[ev.item.channel];
  if (!colibriChannel) return `skip unmapped channel ${ev.item.channel}`;
  const targetRkey = tidFromSlackTs(ev.item.ts);
  const rkey = tidForReaction(ev.item.ts, ev.reaction);
  const sess = await getBskySession(env);
  await putRecord(sess, "social.colibri.reaction", rkey, {
    $type: "social.colibri.reaction",
    emoji: emojiForName(ev.reaction),
    targetMessage: targetRkey,
  });
  return `published reaction rkey=${rkey} :${ev.reaction}: -> ${targetRkey}`;
}

async function unpublishReaction(
  ev: SlackReactionEvent,
  env: Env,
  _eventId: string,
): Promise<string> {
  if (!ev.item || ev.item.type !== "message") return `skip reaction on item.type=${ev.item?.type}`;
  if (!CHANNEL_MAP[ev.item.channel]) return `skip unmapped channel ${ev.item.channel}`;
  const rkey = tidForReaction(ev.item.ts, ev.reaction);
  const sess = await getBskySession(env);
  await deleteRecord(sess, "social.colibri.reaction", rkey);
  return `deleted reaction rkey=${rkey} :${ev.reaction}:`;
}

// ── entry ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      const rawBody = await request.text();

      if (env.SLACK_SIGNING_SECRET) {
        const ok = await verifySlackSignature(
          rawBody,
          request.headers.get("X-Slack-Request-Timestamp"),
          request.headers.get("X-Slack-Signature"),
          env.SLACK_SIGNING_SECRET,
        );
        if (!ok) {
          console.warn("rejected: bad slack signature");
          return new Response("invalid signature", { status: 401 });
        }
      }

      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(rawBody) as SlackEnvelope;
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      if (envelope.type === "url_verification") {
        return new Response(envelope.challenge, {
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (envelope.type === "event_callback") {
        await env.EVENTS.send(envelope);
        return new Response("ok");
      }

      return new Response("unknown envelope type", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  },

  async queue(
    batch: MessageBatch<SlackEventCallback>,
    env: Env,
  ): Promise<void> {
    for (const msg of batch.messages) {
      const envelope = msg.body;
      const eventId = envelope.event_id ?? "?";
      const ev = envelope.event;
      try {
        // 1. lossless archive first
        const rawResult = await writeSlackRaw(envelope, env);
        console.log("event", eventId, rawResult);

        // 2. dispatch by event type
        let derive = "skip non-publishable type";
        if (ev?.type === "message") {
          derive = await publishMessage(ev as SlackMessageEvent, env, eventId);
        } else if (ev?.type === "reaction_added") {
          derive = await publishReaction(ev as SlackReactionEvent, env, eventId);
        } else if (ev?.type === "reaction_removed") {
          derive = await unpublishReaction(ev as SlackReactionEvent, env, eventId);
        }
        console.log("event", eventId, derive);
        msg.ack();
      } catch (err) {
        console.error(
          "event",
          eventId,
          "FAILED",
          err instanceof Error ? err.message : err,
        );
        msg.retry();
      }
    }
  },
};
