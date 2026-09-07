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
//   queue() also drains `atproto-events` (Colibri -> Slack, see reverse.ts).
//   That queue has no producer wired yet: POST /atproto/inject feeds it by
//   hand while the reverse half is under test, so nothing can loop.
//
// Channel map lives in channels.ts — channel additions require a redeploy.

import { didForSlackUser } from "./slack-to-did";
import { CHANNEL_MAP } from "./channels";
import { emojiForName } from "./emoji";
import {
  deleteRecord,
  getBskySession,
  hash10,
  PDS,
  putRecord,
  tidFromSlackTs,
} from "./atproto";
import { handleAtprotoEvent, isJetstreamCommit, MIRROR_EVENT_TYPE, type JetstreamEvent } from "./reverse";
export { JetstreamTail } from "./tail";

const BOT_SLACK_USER_ID = "U0B7685PHGD"; // focbridge
const SLACK_RAW_COLLECTION = "com.feelingofcomputing.bridge.slackRaw";

export interface Env {
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
  INJECT_TOKEN?: string; // bearer for POST /atproto/inject
  EVENTS: Queue<SlackEventCallback>;
  EVENTS_ATPROTO: Queue<JetstreamEvent>;
  JETSTREAM_TAIL: DurableObjectNamespace;
}
const SLACK_QUEUE = "slack-events";
const ATPROTO_QUEUE = "atproto-events";

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

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}
interface SlackMessageInner {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
  edited?: { user: string; ts: string };
  files?: SlackFile[];
  metadata?: { event_type?: string };
}
interface SlackMessageEvent extends SlackMessageInner {
  type: "message";
  subtype?: string;
  channel?: string;
  // subtype: "message_changed"
  message?: SlackMessageInner;
  previous_message?: SlackMessageInner;
  // subtype: "message_deleted"
  deleted_ts?: string;
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

// Collect Slack user_ids referenced as inline `<@U…>` mentions. The walker
// is sync but getDisplayName is async, so we pre-resolve into userNameCache
// before walking — otherwise inline mentions render as raw `@U…` ids.
function collectMentionedUserIds(blocks: SlackBlock[]): string[] {
  const ids = new Set<string>();
  const walk = (els?: SlackBlockElement[]) => {
    if (!els) return;
    for (const el of els) {
      if (el.type === "user" && el.user_id) ids.add(el.user_id);
      walk(el.elements);
    }
  };
  for (const block of blocks) walk(block.elements);
  return [...ids];
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

// ── file attachment bridging ───────────────────────────────────────────────
// Per file: GET Slack's url_private (auth'd with bot token), POST bytes to
// PDS uploadBlob, return the blob ref for inclusion in message.attachments.
// PDS errors throw (caller retries the whole message); Slack 4xx + oversize
// downgrade to a placeholder in the message text — the slackRaw archive still
// holds the original URL so a manual re-run can recover.
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

type BridgedFile =
  | { ok: true; attachment: { blob: unknown; name?: string } }
  | { ok: false; reason: string; name: string };

async function bridgeSlackFile(
  file: SlackFile,
  sess: { did: string; accessJwt: string },
  botToken: string,
): Promise<BridgedFile> {
  const displayName = file.name ?? file.title ?? file.id;
  if (!file.url_private) {
    return { ok: false, reason: "no url_private", name: displayName };
  }
  if (typeof file.size === "number" && file.size > MAX_BLOB_BYTES) {
    return { ok: false, reason: `too large (${file.size}b)`, name: displayName };
  }
  let bytes: Uint8Array;
  try {
    const r = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!r.ok) {
      return { ok: false, reason: `slack fetch ${r.status}`, name: displayName };
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_BLOB_BYTES) {
      return { ok: false, reason: `fetched too large (${buf.byteLength}b)`, name: displayName };
    }
    bytes = new Uint8Array(buf);
  } catch (e) {
    return {
      ok: false,
      reason: `slack fetch ${e instanceof Error ? e.message : "error"}`,
      name: displayName,
    };
  }
  const mime = file.mimetype || "application/octet-stream";
  const upload = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      "Content-Type": mime,
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: bytes,
  });
  if (!upload.ok) {
    throw new Error(`uploadBlob ${file.id}: ${upload.status} ${await upload.text()}`);
  }
  const j = (await upload.json()) as { blob: unknown };
  const attachment: { blob: unknown; name?: string } = { blob: j.blob };
  if (file.name) attachment.name = file.name.slice(0, 256);
  return { ok: true, attachment };
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
//
// Subtype dispatch (new/edit/delete) happens in queue(). This function builds
// + writes the social.colibri.message record from the message fields. Same
// rkey (`tidFromSlackTs(ts)`) is reused on edit — putRecord overwrites in
// place, so the message keeps its original at-uri and createdAt.
async function publishMessage(
  fields: SlackMessageInner & { channel?: string },
  env: Env,
  _eventId: string,
  opts: { edited?: boolean } = {},
): Promise<string> {
  if (fields.user === BOT_SLACK_USER_ID) return "skip self";
  if (!fields.channel || !fields.ts) return "skip missing-fields";
  const hasFiles = Array.isArray(fields.files) && fields.files.length > 0;
  if (!fields.text && !hasFiles) return "skip empty";

  const colibriChannel = CHANNEL_MAP[fields.channel];
  if (!colibriChannel) return `skip unmapped channel ${fields.channel}`;

  const author = fields.user ? await getDisplayName(fields.user, env.SLACK_BOT_TOKEN!) : "unknown";
  const resolveUser = (id: string) => userNameCache.get(id) ?? id;
  const authorDid = fields.user ? didForSlackUser(fields.user) : undefined;

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
  if (Array.isArray(fields.blocks) && fields.blocks.some((x) => x?.type === "rich_text")) {
    const mentioned = collectMentionedUserIds(fields.blocks);
    await Promise.all(
      mentioned.map((id) => getDisplayName(id, env.SLACK_BOT_TOKEN!)),
    );
    walkBlocks(fields.blocks, b, resolveUser);
  } else if (fields.text) {
    b.emit(fields.text);
  }

  // File attachments: upload to PDS as blobs, downgrade failures to text notes.
  const sess = await getBskySession(env);
  const attachments: Array<{ blob: unknown; name?: string }> = [];
  const fileSkipNotes: string[] = [];
  if (Array.isArray(fields.files) && fields.files.length > 0) {
    for (const file of fields.files) {
      const res = await bridgeSlackFile(file, sess, env.SLACK_BOT_TOKEN!);
      if (res.ok) attachments.push(res.attachment);
      else fileSkipNotes.push(`[file '${res.name}' ${res.reason}]`);
    }
  }
  if (fileSkipNotes.length > 0) {
    b.emit("\n" + fileSkipNotes.join("\n"));
  }

  let { text, facets } = b.finish();
  if (text.length > 2048) {
    text = text.slice(0, 2048);
    const maxBytes = utf8Len(text);
    facets = facets.filter((f) => f.index.byteEnd <= maxBytes);
  }

  const rkey = tidFromSlackTs(fields.ts);
  const parentRkey =
    fields.thread_ts && fields.thread_ts !== fields.ts ? tidFromSlackTs(fields.thread_ts) : undefined;

  const record: Record<string, unknown> = {
    $type: "social.colibri.message",
    text,
    channel: colibriChannel,
    createdAt: new Date(parseFloat(fields.ts) * 1000).toISOString(),
    facets,
    attachments,
  };
  if (parentRkey) record["parent"] = parentRkey;
  if (opts.edited) record["edited"] = true;

  await putRecord(sess, "social.colibri.message", rkey, record);
  return `${opts.edited ? "edited" : "published"} message rkey=${rkey} channel=${fields.channel}->${colibriChannel} files=${attachments.length}${fileSkipNotes.length ? `+${fileSkipNotes.length}skipped` : ""}`;
}

async function unpublishMessage(
  ev: SlackMessageEvent,
  env: Env,
  _eventId: string,
): Promise<string> {
  const channel = ev.channel;
  const deletedTs = ev.deleted_ts ?? ev.previous_message?.ts;
  if (!channel || !deletedTs) return "skip delete missing-fields";
  if (!CHANNEL_MAP[channel]) return `skip unmapped channel ${channel}`;
  const rkey = tidFromSlackTs(deletedTs);
  const sess = await getBskySession(env);
  await deleteRecord(sess, "social.colibri.message", rkey);
  return `deleted message rkey=${rkey} channel=${channel}`;
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
    // Colibri's lexicon (main, 2026-09-07) requires `parent` as an at-uri; the
    // appview does not render records without it. `targetMessage` (bare rkey)
    // is our pre-lexicon field, kept for readers of the bot repo (foc-viewer).
    parent: `at://${sess.did}/social.colibri.message/${targetRkey}`,
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

// ── loop guard ─────────────────────────────────────────────────────────────
// Everything the reverse half writes into Slack comes back through the Events
// API. Skip it before it is archived or derived. Three signals, any one is
// enough: the bot's own user id, a bot_id (no other bot has ever posted in a
// bridged channel: 0 of 3072 archived events, 2026-09-07), or the metadata
// event_type the reverse half stamps on every post.
export function isSelfSlackEvent(ev: SlackEvent | undefined): boolean {
  if (!ev) return false;
  if (ev.type === "message") {
    const m = ev as SlackMessageEvent;
    const inner: SlackMessageInner | undefined =
      m.subtype === "message_changed" ? m.message
      : m.subtype === "message_deleted" ? m.previous_message
      : m;
    return (
      inner?.user === BOT_SLACK_USER_ID ||
      !!inner?.bot_id ||
      inner?.subtype === "bot_message" ||
      inner?.metadata?.event_type === MIRROR_EVENT_TYPE
    );
  }
  if (ev.type === "reaction_added" || ev.type === "reaction_removed") {
    return (ev as SlackReactionEvent).user === BOT_SLACK_USER_ID;
  }
  return false;
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

    // Manual producer for the reverse half: a Jetstream-shaped commit event
    // (or an array of them), bearer-authenticated, straight onto the queue.
    if (request.method === "POST" && url.pathname === "/atproto/inject") {
      if (!env.INJECT_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.INJECT_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const events = Array.isArray(body) ? body : [body];
      if (!events.every(isJetstreamCommit)) {
        return new Response("expected jetstream commit event(s)", { status: 400 });
      }
      for (const e of events) await env.EVENTS_ATPROTO.send(e as JetstreamEvent);
      return new Response(JSON.stringify({ enqueued: events.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Jetstream tail control, same bearer as /atproto/inject.
    if (url.pathname.startsWith("/tail/")) {
      if (!env.INJECT_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.INJECT_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = env.JETSTREAM_TAIL.get(env.JETSTREAM_TAIL.idFromName("tail"));
      return stub.fetch(`https://tail${url.pathname.slice("/tail".length)}`, { method: request.method });
    }

    return new Response("not found", { status: 404 });
  },

  // Cron: re-arm the tail's alarm if it was ever lost. A no-op while it is set.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const stub = env.JETSTREAM_TAIL.get(env.JETSTREAM_TAIL.idFromName("tail"));
    await stub.fetch("https://tail/poke", { method: "POST" });
  },

  async queue(
    batch: MessageBatch<SlackEventCallback | JetstreamEvent>,
    env: Env,
  ): Promise<void> {
    if (batch.queue === ATPROTO_QUEUE) {
      for (const msg of batch.messages as Message<JetstreamEvent>[]) {
        const e = msg.body;
        const label = isJetstreamCommit(e) ? `${e.did}/${e.commit.collection}/${e.commit.rkey} ${e.commit.operation}` : e.kind;
        try {
          const result = await handleAtprotoEvent(e, env);
          console.log("atproto", label, result);
          msg.ack();
        } catch (err) {
          console.error("atproto", label, "FAILED", err instanceof Error ? err.message : err);
          msg.retry();
        }
      }
      return;
    }
    if (batch.queue !== SLACK_QUEUE) {
      console.warn("unknown queue", batch.queue);
      for (const msg of batch.messages) msg.ack();
      return;
    }
    for (const msg of batch.messages as Message<SlackEventCallback>[]) {
      const envelope = msg.body;
      const eventId = envelope.event_id ?? "?";
      const ev = envelope.event;
      if (isSelfSlackEvent(ev)) {
        const m = (ev as SlackMessageEvent).message ?? (ev as SlackMessageEvent).previous_message ?? (ev as SlackMessageInner);
        console.log("event", eventId, "skip self", JSON.stringify({
          type: ev?.type, subtype: (ev as SlackMessageEvent).subtype, user: (ev as SlackReactionEvent).user ?? m.user,
          bot_id: m.bot_id, metadata: m.metadata?.event_type,
        }));
        msg.ack();
        continue;
      }
      try {
        // 1. lossless archive first
        const rawResult = await writeSlackRaw(envelope, env);
        console.log("event", eventId, rawResult);

        // 2. dispatch by event type (+ subtype for messages)
        let derive = "skip non-publishable type";
        if (ev?.type === "message") {
          const m = ev as SlackMessageEvent;
          if (!m.subtype || m.subtype === "file_share") {
            derive = await publishMessage(m, env, eventId);
          } else if (m.subtype === "message_changed" && m.message) {
            derive = await publishMessage(
              { ...m.message, channel: m.channel },
              env,
              eventId,
              { edited: true },
            );
          } else if (m.subtype === "message_deleted") {
            derive = await unpublishMessage(m, env, eventId);
          } else {
            derive = `skip subtype=${m.subtype}`;
          }
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
