import { describe, expect, test } from "bun:test";
import corpus from "./fixtures/slack-corpus.json";
import { canonMrkdwn, derive, lostWords } from "./support/compare";
import { renderFacets } from "../src/mrkdwn";
import { SLACK_USER_DID_MAP } from "../src/slack-to-did";

// A frozen covering subset of the live slackRaw archive: one real message per
// distinct combination of rich-text element types, rebuilt with
// `bun scripts/build-fixture.ts`. Hand-written cases are what let
// rich_text_list and message_mention through — this corpus is here so a block
// type nobody thought of still has to survive the walk.

const DID_TO_SLACK = Object.fromEntries(Object.entries(SLACK_USER_DID_MAP).map(([u, d]) => [d, u]));

describe("archive corpus: the walker loses nothing Slack put in its own plaintext", () => {
  test("the fixture still covers every element type seen in production", () => {
    const types = new Set<string>();
    const walk = (els: any[] | undefined) => {
      for (const e of els ?? []) { if (e?.type) types.add(e.type); walk(e.elements); }
    };
    for (const f of corpus as any[]) for (const b of f.blocks) { types.add(b.type); walk(b.elements); }
    expect([...types].sort()).toEqual([
      "channel", "emoji", "link", "message_mention", "rich_text", "rich_text_list",
      "rich_text_preformatted", "rich_text_quote", "rich_text_section", "text", "user",
    ]);
  });

  for (const f of corpus as any[]) {
    test(`${f.ts} [${f.shape}]`, () => {
      expect(lostWords(f.blocks, f.text)).toEqual([]);
    });
  }
});

describe("round trip: blocks -> Colibri -> Slack mrkdwn", () => {
  // mrkdwn.ts calls itself the inverse of the walker. These are the cases in
  // this corpus where it is not; over the whole archive 898 of 916 distinct
  // messages (98%) round-trip exactly. Each entry is a known defect, not an
  // accepted equivalence — delete the entry when the defect is fixed, and
  // `bun scripts/roundtrip.ts` reports the live population of each class.
  const KNOWN: Record<string, string> = {
    "1784310984.808249":
      "forward: a `channel` element becomes the raw id `#C…`, so the reverse leg cannot rebuild `<#C…>` and a Colibri reader sees an opaque id",
    "1788143009.008369":
      "reverse: a single-line code block renders as inline `code` — Colibri's lexicon has no block-code facet, so blockness is not carried",
    "1781908847.430869":
      "reverse: a bold span crossing a link is emitted as separate markers around each segment",
  };

  for (const f of corpus as any[]) {
    test(`${f.ts} [${f.shape}]${KNOWN[f.ts] ? " — known gap" : ""}`, () => {
      const { text, facets } = derive(f.blocks, (id) => id);
      const back = renderFacets(text, facets, { slackUserForDid: (did) => DID_TO_SLACK[did] })
        .replace(/(?<!<)@([UW][A-Z0-9]{6,})(?!>)/g, "<@$1>");
      if (KNOWN[f.ts]) expect(canonMrkdwn(back)).not.toBe(canonMrkdwn(f.text));
      else expect(canonMrkdwn(back)).toBe(canonMrkdwn(f.text));
    });
  }
});
