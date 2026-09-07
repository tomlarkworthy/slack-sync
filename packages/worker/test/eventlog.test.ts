// The tail feed: com.feelingofcomputing.bridge.event.
//
// What matters to a reader is that rkey order is event order, that a pointer
// carries no content, and that a failed log write cannot take the bridge down.
import { describe, expect, test } from "bun:test";
import { slackTsFromTid } from "../src/atproto";
import { buildEvent, EVENT_COLLECTION, logEvent, nextEventRkey } from "../src/eventlog";

const SUBJECT = "at://did:plc:fway37p6xwk2hu3c3t3rqs5t/social.colibri.message/3mtfaw67lfcvs";

// The minter is monotonic across the whole module, so these run as one ascending
// sequence: the wall clock first, then a fixed time well past it.
const T0 = 4_000_000_000_000; // ms, later than any Date.now() this suite sees

describe("rkey is a TID minted at observation time", () => {
  test("strictly increasing, so listRecords order is event order", () => {
    const keys = Array.from({ length: 50 }, () => nextEventRkey());
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("13 characters of the TID alphabet, like every other rkey here", () => {
    expect(nextEventRkey()).toMatch(/^[2-7a-z]{13}$/);
  });
  test("decodes back to the wall clock it was minted at", () => {
    expect(slackTsFromTid(nextEventRkey(T0))).toBe("4000000000.000000");
  });
  test("two events inside one millisecond still order", () => {
    const a = nextEventRkey(T0);
    const b = nextEventRkey(T0);
    const c = nextEventRkey(T0);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
  test("a clock that goes backwards does not rewind the log", () => {
    const back = nextEventRkey(T0 - 60_000);
    expect(back > nextEventRkey(T0 - 120_000, 0)).toBe(false);
    expect(slackTsFromTid(back).startsWith("4000000000")).toBe(true);
  });
});

describe("the record is a pointer, never content", () => {
  test("full shape", () => {
    expect(buildEvent(
      { op: "create", subject: SUBJECT, cid: "bafyreiabc", channel: "3mn5tk5v4yr2s", via: "colibri" },
      "2026-09-07T18:00:00.000Z",
    )).toEqual({
      $type: EVENT_COLLECTION,
      op: "create",
      subject: SUBJECT,
      cid: "bafyreiabc",
      channel: "3mn5tk5v4yr2s",
      via: "colibri",
      at: "2026-09-07T18:00:00.000Z",
    });
  });
  test("no text, facets or emoji leak in whatever is passed", () => {
    const ev = buildEvent({ op: "create", subject: SUBJECT, via: "slack" }) as Record<string, unknown>;
    expect(Object.keys(ev).sort()).toEqual(["$type", "at", "op", "subject", "via"]);
  });
  test("absent cid and channel are omitted, not written as undefined", () => {
    const ev = buildEvent({ op: "delete", subject: SUBJECT, via: "colibri" });
    expect("cid" in ev).toBe(false);
    expect("channel" in ev).toBe(false);
  });
});

describe("logEvent", () => {
  const sess = { did: "did:plc:4gcxakknd6hxtnhf33miwsob", accessJwt: "jwt" };
  const withFetch = async <T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  };

  test("writes one putRecord to the bot repo in the event collection", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const note = await withFetch(
      (async (url: string, init: { body: string }) => {
        seen = { url: String(url), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ uri: "at://x", cid: "c" }), { status: 200 });
      }) as never,
      () => logEvent(sess, { op: "create", subject: SUBJECT, cid: "bafy", channel: "3mn5tk5v4yr2s", via: "colibri" }),
    );
    expect(seen!.url).toContain("com.atproto.repo.putRecord");
    expect(seen!.body.repo).toBe(sess.did);
    expect(seen!.body.collection).toBe(EVENT_COLLECTION);
    expect(String(seen!.body.rkey)).toMatch(/^[2-7a-z]{13}$/);
    expect((seen!.body.record as { subject: string }).subject).toBe(SUBJECT);
    expect(note).toBe(` event=${seen!.body.rkey}`);
  });

  test("a PDS failure is swallowed: the bridge must not fall over for the feed", async () => {
    const note = await withFetch(
      (async () => new Response("upstream boom", { status: 502 })) as never,
      () => logEvent(sess, { op: "create", subject: SUBJECT, via: "slack" }),
    );
    expect(note).toBe(" event=FAILED");
  });

  test("a thrown fetch is swallowed too", async () => {
    const note = await withFetch(
      (async () => {
        throw new Error("network");
      }) as never,
      () => logEvent(sess, { op: "delete", subject: SUBJECT, via: "slack" }),
    );
    expect(note).toBe(" event=FAILED");
  });
});
