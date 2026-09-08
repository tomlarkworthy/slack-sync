import { describe, expect, test } from "bun:test";
import { renderFacets, escapeMrkdwn } from "../src/mrkdwn";
import { CHANNELS, channelFacetUri, channelForRef } from "@slack-sync/shared";

const F = "social.colibri.richtext.facet";
const opts = { slackUserForDid: (did: string) => (did === "did:plc:tom" ? "U02E4DAQGSZ" : undefined) };
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("renderFacets", () => {
  test("plain text is entity-escaped", () => {
    expect(renderFacets("a < b & c > d", [], opts)).toBe("a &lt; b &amp; c &gt; d");
  });

  test("bold / italic / strike / code", () => {
    const t = "bold italic strike code";
    const f = (kind: string, from: string) => ({
      index: { byteStart: t.indexOf(from), byteEnd: t.indexOf(from) + from.length },
      features: [{ $type: `${F}#${kind}` }],
    });
    expect(
      renderFacets(t, [f("bold", "bold"), f("italic", "italic"), f("strikethrough", "strike"), f("code", "code")], opts),
    ).toBe("*bold* _italic_ ~strike~ `code`");
  });

  test("link with text and bare link", () => {
    const t = "see docs or https://x.y/";
    const facets = [
      { index: { byteStart: 4, byteEnd: 8 }, features: [{ $type: `${F}#link`, uri: "https://a.b/?q=1&r=2" }] },
      { index: { byteStart: 12, byteEnd: t.length }, features: [{ $type: `${F}#link`, uri: "https://x.y/" }] },
    ];
    // `&` is entity-escaped inside the URI too — that is how Slack spells its
    // own links, and it unescapes on parse.
    expect(renderFacets(t, facets, opts)).toBe("see <https://a.b/?q=1&amp;r=2|docs> or <https://x.y/>");
  });

  test("mention maps to a Slack user, unknown DID stays text", () => {
    const t = "@Tom and @Someone";
    const facets = [
      { index: { byteStart: 0, byteEnd: 4 }, features: [{ $type: `${F}#mention`, did: "did:plc:tom" }] },
      { index: { byteStart: 9, byteEnd: 17 }, features: [{ $type: `${F}#mention`, did: "did:plc:nobody" }] },
    ];
    expect(renderFacets(t, facets, opts)).toBe("<@U02E4DAQGSZ> and @Someone");
  });

  test("byte offsets survive multi-byte text", () => {
    const t = "héllo 💜 wörld";
    const start = bytes("héllo 💜 ");
    const facets = [{ index: { byteStart: start, byteEnd: bytes(t) }, features: [{ $type: `${F}#bold` }] }];
    expect(renderFacets(t, facets, opts)).toBe("héllo 💜 *wörld*");
  });

  test("markers stay inside surrounding whitespace; overlapping facets: first wins", () => {
    const t = "ab cd";
    const facets = [
      { index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: `${F}#bold` }] },
      { index: { byteStart: 1, byteEnd: 5 }, features: [{ $type: `${F}#italic` }] },
    ];
    expect(renderFacets(t, facets, opts)).toBe("*ab* cd");
  });

  test("unknown feature types render as plain text", () => {
    const t = "whatever";
    const facets = [{ index: { byteStart: 0, byteEnd: 8 }, features: [{ $type: `${F}#nosuchthing` }] }];
    expect(renderFacets(t, facets, opts)).toBe("whatever");
  });

  test("escapeMrkdwn", () => {
    expect(escapeMrkdwn("<@U1> & <#C1>")).toBe("&lt;@U1&gt; &amp; &lt;#C1&gt;");
  });
});

describe("channel facets", () => {
  const withChannel = {
    ...opts,
    slackChannelForRkey: (ref: string) => channelForRef(ref)?.slack,
  };
  test("a channel facet becomes <#C…>; an unmapped rkey stays text", () => {
    const t = "see #devlog-together and #elsewhere";
    const f = (from: string, rkey: string) => ({
      index: { byteStart: t.indexOf(from), byteEnd: t.indexOf(from) + from.length },
      features: [{ $type: `${F}#channel`, channel: rkey }],
    });
    const uri = channelFacetUri(CHANNELS.find((c) => c.slack === "C03RR0W5DGC")!);
    expect(renderFacets(t, [f("#devlog-together", uri), f("#elsewhere", "at://did:plc:x/social.colibri.channel/nope")], withChannel))
      .toBe("see <#C03RR0W5DGC> and #elsewhere");
  });
});

describe("block facets", () => {
  const at = (t: string, from: string, type: string, extra: object = {}) => ({
    index: { byteStart: t.indexOf(from), byteEnd: t.indexOf(from) + new TextEncoder().encode(from).length },
    features: [{ $type: `${F}#${type}`, ...extra }],
  });

  test("a quote becomes Slack's blockquote, marker unescaped, links inside kept", () => {
    const t = "he said this\nand that";
    expect(
      renderFacets(t, [at(t, t, "quote"), at(t, "this", "link", { uri: "https://x.y/" })], opts),
    ).toBe("> he said <https://x.y/|this>\n> and that");
  });

  test("list items get Slack's own markers; ordered items count from 1", () => {
    const t = "alpha\nbeta";
    expect(renderFacets(t, [at(t, "alpha", "list", { ordered: false }), at(t, "beta", "list", { ordered: false })], opts))
      .toBe("• alpha\n• beta");
    expect(renderFacets(t, [at(t, "alpha", "list", { ordered: true }), at(t, "beta", "list", { ordered: true })], opts))
      .toBe("1. alpha\n2. beta");
  });

  test("a codeblock is fenced", () => {
    const t = "one\ntwo";
    expect(renderFacets(t, [at(t, t, "codeblock")], opts)).toBe("```one\ntwo```");
  });
});
