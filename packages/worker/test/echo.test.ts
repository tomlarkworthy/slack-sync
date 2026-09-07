// Loop safety: each direction must drop the other direction's writes before
// touching a network. These pin the guards to the event shapes Slack and
// Jetstream actually deliver.
import { describe, expect, test } from "bun:test";
import { BOT_DID } from "../src/atproto";
import { isSelfSlackEvent } from "../src/index";
import { handleAtprotoEvent, MIRROR_EVENT_TYPE } from "../src/reverse";
import { wantEvent } from "../src/tail";

const BOT = "U0B7685PHGD";
const HUMAN = "U02E4DAQGSZ";
const base = { channel: "C03RR0W5DGC", ts: "1788794724.510389", event_ts: "1788794724.510389" };
const meta = { event_type: MIRROR_EVENT_TYPE, event_payload: { uri: "at://x/social.colibri.message/y", cid: "z" } };

describe("forward guard: Slack events written by the bridge bot are dropped", () => {
  test("chat.postMessage as the bot user (user id, bot_id, metadata all present)", () => {
    expect(isSelfSlackEvent({ type: "message", user: BOT, bot_id: "B0B7XXXXXXX", app_id: "A0B7XXXXXXX", text: "@tom: hi", metadata: meta, ...base } as never)).toBe(true);
  });
  test("each signal alone is enough", () => {
    expect(isSelfSlackEvent({ type: "message", user: BOT, text: "x", ...base } as never)).toBe(true);
    expect(isSelfSlackEvent({ type: "message", user: HUMAN, bot_id: "B1", text: "x", ...base } as never)).toBe(true);
    expect(isSelfSlackEvent({ type: "message", subtype: "bot_message", username: "tom (Colibri)", text: "x", ...base } as never)).toBe(true);
    expect(isSelfSlackEvent({ type: "message", user: HUMAN, metadata: meta, text: "x", ...base } as never)).toBe(true);
  });
  test("chat.update -> message_changed carries the bot in the nested message", () => {
    expect(isSelfSlackEvent({ type: "message", subtype: "message_changed", ...base, message: { type: "message", user: BOT, text: "edited", ts: base.ts, metadata: meta }, previous_message: { user: BOT, text: "x", ts: base.ts } } as never)).toBe(true);
  });
  test("chat.delete -> message_deleted carries the bot in previous_message", () => {
    expect(isSelfSlackEvent({ type: "message", subtype: "message_deleted", ...base, deleted_ts: base.ts, previous_message: { type: "message", user: BOT, bot_id: "B1", text: "x", ts: base.ts } } as never)).toBe(true);
  });
  test("reactions.add / reactions.remove by the bot", () => {
    for (const type of ["reaction_added", "reaction_removed"]) {
      expect(isSelfSlackEvent({ type, user: BOT, reaction: "purple_heart", item: { type: "message", channel: base.channel, ts: base.ts }, item_user: HUMAN, event_ts: base.event_ts } as never)).toBe(true);
    }
  });
  test("human activity still flows, including on the bot's own posts", () => {
    expect(isSelfSlackEvent({ type: "message", user: HUMAN, text: "hello", ...base } as never)).toBe(false);
    expect(isSelfSlackEvent({ type: "message", user: HUMAN, text: "reply", thread_ts: base.ts, parent_user_id: BOT, ...base } as never)).toBe(false);
    expect(isSelfSlackEvent({ type: "reaction_added", user: HUMAN, reaction: "+1", item: { type: "message", channel: base.channel, ts: base.ts }, item_user: BOT, event_ts: base.event_ts } as never)).toBe(false);
    expect(isSelfSlackEvent({ type: "message", subtype: "message_changed", ...base, message: { user: HUMAN, text: "edited", ts: base.ts } } as never)).toBe(false);
    expect(isSelfSlackEvent(undefined)).toBe(false);
  });
});

const commit = (did: string, collection: string, operation: string, record?: unknown) => ({
  did, time_us: 1, kind: "commit", commit: { operation, collection, rkey: "3a", record, cid: "c" },
});
const ourMsg = { $type: "social.colibri.message", text: "hi", channel: "at://did:plc:dl3d3fftr4tk3yf3xqxouus7/social.colibri.channel/3msvih7djji3e" };
const otherMsg = { ...ourMsg, channel: "at://did:plc:2nnan56zdm4vmrsh64257hww/social.colibri.channel/3mtmohai2oth2" };

describe("reverse guard: bot-repo commits are dropped before any network call", () => {
  // env is empty: any fetch or session lookup would throw
  const env = {} as never;
  test("consumer skips the bot repo for every collection and operation", async () => {
    for (const col of ["social.colibri.message", "social.colibri.reaction"]) {
      for (const op of ["create", "update", "delete"]) {
        expect(await handleAtprotoEvent(commit(BOT_DID, col, op, ourMsg) as never, env)).toBe("skip self (bot repo)");
      }
    }
  });
  test("consumer skips rooms outside the channel map without a lookup", async () => {
    expect(await handleAtprotoEvent(commit("did:plc:someone", "social.colibri.message", "create", otherMsg) as never, env)).toMatch(/^skip unmapped channel/);
  });
  test("tail forwards only what the consumer can use", () => {
    expect(wantEvent(commit(BOT_DID, "social.colibri.message", "create", ourMsg))).toBeNull();
    expect(wantEvent(commit(BOT_DID, "social.colibri.reaction", "create", {}))).toBeNull();
    expect(wantEvent(commit("did:plc:someone", "social.colibri.message", "create", otherMsg))).toBeNull();
    expect(wantEvent(commit("did:plc:someone", "social.colibri.message", "create", ourMsg))).not.toBeNull();
    expect(wantEvent(commit("did:plc:someone", "social.colibri.message", "delete"))).not.toBeNull();
    expect(wantEvent(commit("did:plc:someone", "social.colibri.reaction", "create", { parent: "at://x/social.colibri.message/y" }))).not.toBeNull();
    expect(wantEvent(commit("did:plc:someone", "app.bsky.feed.post", "create", {}))).toBeNull();
    expect(wantEvent({ did: "did:plc:someone", time_us: 1, kind: "identity" })).toBeNull();
  });
});
