import { describe, expect, test } from "bun:test";
import { renderFacets, escapeMrkdwn } from "../src/mrkdwn";

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

  test("list feature and unknown types render as plain text", () => {
    const t = "1. one";
    const facets = [{ index: { byteStart: 0, byteEnd: 6 }, features: [{ $type: `${F}#list`, ordered: true }] }];
    expect(renderFacets(t, facets, opts)).toBe("1. one");
  });

  test("escapeMrkdwn", () => {
    expect(escapeMrkdwn("<@U1> & <#C1>")).toBe("&lt;@U1&gt; &amp; &lt;#C1&gt;");
  });
});
