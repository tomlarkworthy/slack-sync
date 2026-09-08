// The Slack rich-text walker: Slack `blocks` -> Colibri text + facets.
//
// One implementation, used by both the live worker and the backfill CLI. It
// used to be one per package: rich_text_list, message_mention and facet#channel
// were each handled in one copy and missing from the other, silently, for
// months. Everything workspace-specific — display names, the DID map, the
// channel table, custom emoji — arrives through WalkContext, so there is
// nothing left to drift.
//
// Colibri's model is clean text plus facets: no "> " prefixes, no "• " bullets.
// The client draws the blockquote rule, the list marker and the code frame.
// Lexicon: https://colibri.social lexicon record for social.colibri.richtext.facet
// (resolve _lexicon.colibri.social; the vendored checkout goes stale).

export interface WalkContext {
  /** Display name for a Slack user id, without the leading "@". */
  nameForUser: (id: string) => string;
  /** Claimed atproto DID for a Slack user id, for facet#mention. */
  didForUser: (id: string) => string | undefined;
  /**
   * Channel name + the at-uri facet#channel carries. Undefined for a channel
   * this deployment does not map; the reference then stays plain text rather
   * than becoming a facet the client cannot resolve.
   */
  channelRef: (id: string) => { name: string; uri: string } | undefined;
  /** Unicode for a Slack emoji shortcode, for custom workspace emoji. */
  emojiFor: (name: string) => string;
}

export type SlackBlock = { type: string; elements?: SlackBlockElement[] };
export type SlackBlockElement = {
  type: string;
  elements?: SlackBlockElement[];
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  name?: string;
  unicode?: string;
  range?: string;
  value?: string; // color
  // rich_text_section items carry a style object; rich_text_list carries
  // "bullet" | "ordered" in the same field.
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean } | string;
  indent?: number; // rich_text_list nesting depth
};


// ── facet builder + blocks walker ──────────────────────────────────────────
const utf8enc = new TextEncoder();
export const utf8Len = (s: string) => utf8enc.encode(s).length;

export type Facet = {
  $type: "social.colibri.richtext.facet";
  index: { byteStart: number; byteEnd: number };
  features: unknown[];
};

export class FacetBuilder {
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

export function walkBlocks(
  blocks: SlackBlock[],
  b: FacetBuilder,
  ctx: WalkContext,
) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== "rich_text") continue;
    walkRichTextElements(block.elements ?? [], b, ctx);
    if (i < blocks.length - 1) b.emit("\n");
  }
}

// Collect Slack user_ids referenced as inline `<@U…>` mentions. The walker
// is sync but getDisplayName is async, so we pre-resolve into userNameCache
// before walking — otherwise inline mentions render as raw `@U…` ids.
export function collectMentionedUserIds(blocks: SlackBlock[]): string[] {
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
  ctx: WalkContext,
) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    switch (el.type) {
      case "rich_text_section":
        for (const item of el.elements ?? []) walkSectionItem(item, b, ctx);
        break;
      case "rich_text_quote": {
        // Colibri renders a #quote facet as a <blockquote>; the text stays
        // clean. We used to synthesise "> " prefixes, which showed up
        // literally and made the facet offsets need re-indexing.
        const sub = new FacetBuilder();
        for (const item of el.elements ?? []) walkSectionItem(item, sub, ctx);
        spliceInto(b, sub, [{ $type: "social.colibri.richtext.facet#quote" }]);
        break;
      }
      case "rich_text_list":
        walkList(el, b, ctx);
        break;
      case "rich_text_preformatted": {
        const pre = new FacetBuilder();
        for (const item of el.elements ?? []) walkSectionItem(item, pre, ctx);
        // Slack's preformatted blocks carry no language.
        spliceInto(b, pre, [{ $type: "social.colibri.richtext.facet#codeblock" }]);
        break;
      }
    }
    if (i < elements.length - 1) b.emit("\n");
  }
}

// Append a sub-builder's text to `b`, shifting its facets to the new offsets,
// and cover the whole span with one block-level feature.
function spliceInto(b: FacetBuilder, sub: FacetBuilder, features: unknown[]) {
  const { text, facets } = sub.finish();
  if (!text) return;
  const start = b.byteOffset;
  b.parts.push(text);
  b.byteOffset += utf8Len(text);
  b.facets.push({
    $type: "social.colibri.richtext.facet",
    index: { byteStart: start, byteEnd: b.byteOffset },
    features,
  });
  for (const f of facets) {
    b.facets.push({
      ...f,
      index: { byteStart: start + f.index.byteStart, byteEnd: start + f.index.byteEnd },
    });
  }
}

// Slack sends a bulleted or numbered list as its own element, a sibling of the
// sections around it, with `indent` for nesting depth. Colibri's model is one
// #list facet per item line and no bullet in the text — the client draws the
// marker. Depth comes from the facet's `indent` (lexicon rev 5) with a
// fallback to the leading whitespace before the item, so we write both and
// stay readable on the published rev 4.
function walkList(
  list: SlackBlockElement,
  b: FacetBuilder,
  ctx: WalkContext,
) {
  const ordered = list.style === "ordered";
  const indent = Math.max(0, list.indent ?? 0);
  const items = list.elements ?? [];
  for (let i = 0; i < items.length; i++) {
    if (indent > 0) b.emit("  ".repeat(indent));
    const start = b.byteOffset;
    for (const item of items[i]!.elements ?? []) walkSectionItem(item, b, ctx);
    if (b.byteOffset > start) {
      b.facets.push({
        $type: "social.colibri.richtext.facet",
        index: { byteStart: start, byteEnd: b.byteOffset },
        features: [
          indent > 0
            ? { $type: "social.colibri.richtext.facet#list", ordered, indent }
            : { $type: "social.colibri.richtext.facet#list", ordered },
        ],
      });
    }
    if (i < items.length - 1) b.emit("\n");
  }
}

function walkSectionItem(
  item: SlackBlockElement,
  b: FacetBuilder,
  ctx: WalkContext,
) {
  switch (item.type) {
    case "text": {
      const features: unknown[] = [];
      const s = typeof item.style === "object" && item.style !== null ? item.style : {};
      if (s.bold) features.push({ $type: "social.colibri.richtext.facet#bold" });
      if (s.italic) features.push({ $type: "social.colibri.richtext.facet#italic" });
      if (s.strike) features.push({ $type: "social.colibri.richtext.facet#strikethrough" });
      if (s.code) features.push({ $type: "social.colibri.richtext.facet#code" });
      b.emit(item.text ?? "", ...features);
      break;
    }
    // message_mention is a permalink to another Slack message; it carries the
    // same url + text as a link, plus channel_id/message_ts we do not use.
    case "message_mention":
    case "link":
      if (item.url)
        b.emit(item.text || item.url, {
          $type: "social.colibri.richtext.facet#link",
          uri: item.url,
        });
      break;
    case "user":
      if (item.user_id) {
        const did = ctx.didForUser(item.user_id);
        const text = `@${ctx.nameForUser(item.user_id)}`;
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
    case "channel": {
      // The lexicon has facet#channel, keyed by the Colibri channel rkey, and
      // channels.ts already carries both that and the name — emitting the raw
      // Slack id as plain text left a Colibri reader with an opaque `#C…` and
      // gave the reverse leg nothing to rebuild `<#C…>` from. backfill has
      // done this since it was written.
      if (!item.channel_id) break;
      const ch = ctx.channelRef(item.channel_id);
      if (ch) {
        b.emit(`#${ch.name}`, {
          $type: "social.colibri.richtext.facet#channel",
          channel: ch.uri,
        });
      } else {
        b.emit(`#${item.channel_id}`);
      }
      break;
    }
    case "emoji": {
      let unicode = "";
      if (item.unicode) {
        try {
          unicode = String.fromCodePoint(
            ...item.unicode.split("-").map((h) => parseInt(h, 16)),
          );
        } catch {}
      }
      b.emit(unicode || ctx.emojiFor(item.name ?? ""));
      break;
    }
    case "broadcast":
      if (item.range) b.emit(`@${item.range}`);
      break;
    // A hex colour swatch. backfill has always emitted the value; the worker's
    // copy had no case, so it dropped one silently. No archived message
    // carries one, which is exactly why only one copy ever grew the case.
    case "color":
      if (item.value) b.emit(item.value);
      break;
  }
}

