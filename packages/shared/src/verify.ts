// Shared harness for checking the forward walker against Slack's own output.
//
// Slack sends every message twice: as `blocks` (the tree we walk) and as
// `text` (Slack's own plaintext of the same message). The second is an
// independent reference — content in it and not in ours is content we dropped.
// The worker's corpus test, its fidelity/roundtrip scripts and backfill's
// dump check all use this, so the comparison is defined once.
import {
  channelFacetUri,
  channelForSlackId,
  didForSlackUser,
  emojiForName,
  emojiNameFor,
  walkBlocks,
  type WalkContext,
} from "./index";

const enc = new TextEncoder();

export class Builder {
  parts: string[] = [];
  facets: any[] = [];
  byteOffset = 0;
  emit(text: string, ...features: any[]) {
    if (!text) return;
    const start = this.byteOffset;
    this.parts.push(text);
    this.byteOffset += enc.encode(text).length;
    if (features.length)
      this.facets.push({ index: { byteStart: start, byteEnd: this.byteOffset }, features });
  }
  finish() {
    return { text: this.parts.join(""), facets: this.facets };
  }
}

/**
 * The production walk context, with only display-name lookup stubbed — the DID
 * map, channel table and emoji table are the ones the worker ships, so the
 * corpus checks exercise the real mappings.
 */
export const walkContext = (nameForUser: (id: string) => string = () => "M"): WalkContext => ({
  nameForUser,
  didForUser: didForSlackUser,
  channelRef: (id) => {
    const ch = channelForSlackId(id);
    return ch ? { name: ch.name, uri: channelFacetUri(ch) } : undefined;
  },
  emojiFor: emojiForName,
});

/** Blocks -> Colibri text + facets, with no author byline in the way. */
export function derive(blocks: unknown[], nameForUser: (id: string) => string = () => "M") {
  const b = new Builder();
  walkBlocks(blocks as any, b as any, walkContext(nameForUser));
  return b.finish();
}

/**
 * Both sides reduced to a bag of words, with the constructs that legitimately
 * differ collapsed: mentions, channel refs, emoji spelling, `<url|label>`
 * syntax, entity escaping and our list bullets.
 */
export function words(s: string): string[] {
  return s
    .replace(/<@[UW][A-Z0-9]+(\|[^>]*)?>/g, "@M")
    .replace(/@M\b/g, " ")
    .replace(/<#C[A-Z0-9]+(\|[^>]*)?>/g, " ")
    .replace(/#C[A-Z0-9]{6,}/g, " ")
    .replace(/<!(here|channel|everyone)[^>]*>/g, " ")
    .replace(/<([^|>]+)\|([^>]*)>/g, " $1 $2 ")
    .replace(/<(https?:[^>]+)>/g, " $1 ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    // List markers are structure, not content: Slack spells them in its
    // plaintext ("• x", "1. x"), we carry them as #list facets.
    .replace(/^[ \t]*(?:•|\d+\.)[ \t]/gm, " ")
    .replace(/•/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().toLowerCase().split(" ").filter(Boolean);
}

/**
 * Words present in Slack's reference text and absent from ours. A URL we carry
 * in a link facet counts as present: Slack's plaintext spells `<url|label>`
 * out in full, our text holds only the label.
 */
export function lostWords(blocks: unknown[], reference: string): string[] {
  const { text, facets } = derive(blocks);
  return lostFrom(text, facets, reference);
}

/**
 * The same question asked of an already-published record rather than a fresh
 * derivation: which of Slack's words does this Colibri message not carry?
 * Non-empty means the record was derived by a walker that has since been
 * fixed — scripts/replay.ts --stale uses this to find what needs re-deriving.
 */
export function lostFrom(
  text: string,
  facets: Array<{ features: Array<{ uri?: string }> }> | undefined,
  reference: string,
): string[] {
  const uris = (facets ?? []).flatMap((f) => f.features.map((x) => x.uri ?? ""));
  const have = new Set(words([text, ...uris].join(" ")));
  return words(reference).filter((w) => !have.has(w));
}

/** Spellings of the same mrkdwn that Slack treats as equivalent. */
export function canonMrkdwn(s: string): string {
  return s
    // Slack's plaintext escapes the blockquote marker it requires unescaped on
    // input, and is not consistent about it. Either spelling is the same quote.
    .replace(/^&gt; /gm, "> ")
    .replace(/<(https?:[^|>]+)\|\1>/g, "<$1>")
    .replace(/\p{Extended_Pictographic}️?(‍\p{Extended_Pictographic}️?)*/gu, (m) => `:${emojiNameFor(m) ?? "e"}:`)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
