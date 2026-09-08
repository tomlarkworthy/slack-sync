import { describe, expect, test } from "bun:test";
import { parseAtUri, slackTsFromTid, tidFromSlackTs } from "../src/atproto";
import { CHANNEL_MAP, channelForRef, COMMUNITY_DID, OLD_OWNER_DID } from "@slack-sync/shared";
import { emojiForName, emojiNameFor } from "@slack-sync/shared";
import { isJetstreamCommit } from "../src/reverse";

describe("tid <-> slack ts", () => {
  test("round trip on a real bridged rkey", () => {
    // 3muc5hdq7vl22 is Tom's 2026-08-30 message; decoded by hand in plan/colibri-to-slack-bridge.md
    expect(slackTsFromTid("3muc5hdq7vl22")).toBe("1788084452.267889");
    expect(tidFromSlackTs("1788084452.267889")).toBe("3muc5hdq7vl22");
  });
  test("round trip with a short fractional part", () => {
    const ts = "1700000000.5";
    expect(slackTsFromTid(tidFromSlackTs(ts))).toBe("1700000000.500000");
  });
  test("reaction rkeys decode to the target ts regardless of clock id", () => {
    expect(slackTsFromTid("3muc5hdq7vlof")).toBe("1788084452.267889");
  });
});

describe("channels", () => {
  const ch = CHANNEL_MAP["C03RR0W5DGC"]!;
  test("forward map still points at the pre-migration rkey", () => {
    expect(ch).toBe("3mn5tk5v4yr2s");
  });
  test("reverse map accepts all three spellings", () => {
    for (const ref of [
      "3mn5tk5v4yr2s",
      "3msvih7djji3e",
      `at://${OLD_OWNER_DID}/social.colibri.channel/3mn5tk5v4yr2s`,
      `at://${COMMUNITY_DID}/social.colibri.channel/3msvih7djji3e`,
    ]) {
      expect(channelForRef(ref)?.slack).toBe("C03RR0W5DGC");
    }
  });
  test("another community's room is not mapped", () => {
    expect(channelForRef("at://did:plc:2nnan56zdm4vmrsh64257hww/social.colibri.channel/3mtmohai2oth2")).toBeUndefined();
    expect(channelForRef(undefined)).toBeUndefined();
  });
});

describe("emoji", () => {
  test("unicode -> slack name, both directions", () => {
    expect(emojiNameFor("💜")).toBe("purple_heart");
    expect(emojiNameFor("🫡")).toBe("saluting_face");
    expect(emojiForName(emojiNameFor("👍")!)).toBe("👍");
  });
  test("variation selector tolerance", () => {
    expect(emojiNameFor("❤️")).toBe("heart");
    expect(emojiNameFor("❤")).toBe("heart");
  });
  test("custom emoji pass through as their name; unknown is undefined", () => {
    expect(emojiNameFor(":partyparrot:")).toBe("partyparrot");
    expect(emojiNameFor("not an emoji")).toBeUndefined();
  });
});

describe("at-uri + jetstream shape", () => {
  test("parseAtUri", () => {
    expect(parseAtUri("at://did:plc:abc/social.colibri.message/3muwl2r2ehcww")).toEqual({
      did: "did:plc:abc",
      collection: "social.colibri.message",
      rkey: "3muwl2r2ehcww",
    });
    expect(parseAtUri("3muwl2r2ehcww")).toBeNull();
  });
  test("isJetstreamCommit", () => {
    expect(
      isJetstreamCommit({
        did: "did:plc:x",
        time_us: 1,
        kind: "commit",
        commit: { operation: "create", collection: "social.colibri.message", rkey: "3a", record: {} },
      }),
    ).toBe(true);
    expect(isJetstreamCommit({ did: "did:plc:x", time_us: 1, kind: "identity" })).toBe(false);
    expect(isJetstreamCommit({ kind: "commit", commit: { operation: "nope" } })).toBe(false);
  });
});
