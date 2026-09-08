// Colibri rich text (text + byte-indexed facets) -> Slack mrkdwn.
//
// Inverse of the blocks walker in index.ts. Slack mrkdwn is not Markdown:
// *bold*, _italic_, ~strike~, `code`, <url|text>, <@U…>, and `&`, `<`, `>`
// must be entity-escaped everywhere or Slack reads them as control sequences.

export interface ColibriFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string; channel?: string; ordered?: boolean }>;
}

export interface RenderOpts {
  // atproto DID -> Slack user id, for `facet#mention` -> `<@U…>`.
  slackUserForDid: (did: string) => string | undefined;
  // Colibri channel rkey -> Slack channel id, for `facet#channel` -> `<#C…>`.
  slackChannelForRkey?: (rkey: string) => string | undefined;
}

export function escapeMrkdwn(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function featureKind(t: string): string {
  const i = t.indexOf("#");
  return i >= 0 ? t.slice(i + 1) : t;
}

const BLOCK_KINDS = new Set(["quote", "list", "codeblock"]);
const blockFeatureOf = (f: ColibriFacet) =>
  f.features.find((x) => BLOCK_KINDS.has(featureKind(x.$type)));

export function renderFacets(text: string, facets: ColibriFacet[] | undefined, opts: RenderOpts): string {
  const bytes = enc.encode(text);
  const valid = (facets ?? []).filter(
    (f) => f?.index && f.index.byteEnd > f.index.byteStart && f.index.byteStart >= 0,
  );
  // Block facets (quote, list, codeblock) span the inline ones inside them, so
  // they cannot go through the same first-one-wins pass — a link inside a
  // quote would be swallowed. Segment on blocks, render inline within.
  const blocks = valid.filter(blockFeatureOf).sort((a, b) => a.index.byteStart - b.index.byteStart);
  const inline = valid.filter((f) => !blockFeatureOf(f)).sort((a, b) => a.index.byteStart - b.index.byteStart);

  const renderInline = (from: number, to: number): string => {
    const out: string[] = [];
    let pos = from;
    for (const f of inline) {
      const start = Math.min(f.index.byteStart, bytes.length);
      const end = Math.min(f.index.byteEnd, bytes.length);
      if (start < pos || start >= to) continue;
      if (end > to) continue;
      if (start > pos) out.push(escapeMrkdwn(dec.decode(bytes.subarray(pos, start))));
      out.push(renderSpan(dec.decode(bytes.subarray(start, end)), f, opts));
      pos = end;
    }
    if (pos < to) out.push(escapeMrkdwn(dec.decode(bytes.subarray(pos, to))));
    return out.join("");
  };

  const renderRange = (from: number, to: number, within: ColibriFacet[]): string => {
    const out: string[] = [];
    let pos = from;
    let ordinal = 0;
    for (let i = 0; i < within.length; i++) {
      const f = within[i]!;
      const start = Math.max(f.index.byteStart, pos);
      const end = Math.min(f.index.byteEnd, to);
      if (end <= start) continue;
      if (start > pos) out.push(renderInline(pos, start));
      const feature = blockFeatureOf(f)!;
      const kind = featureKind(feature.$type);
      if (kind === "quote") {
        // Slack's own blockquote marker; not entity-escaped, or Slack shows a
        // literal ">" instead of quoting.
        const nested = within.slice(i + 1).filter((x) => x.index.byteEnd <= end);
        const inner = renderRange(start, end, nested);
        out.push(inner.split("\n").map((l) => `> ${l}`).join("\n"));
        i += nested.length;
      } else if (kind === "codeblock") {
        out.push("```" + escapeMrkdwn(dec.decode(bytes.subarray(start, end))) + "```");
      } else {
        // Slack has no list markup: it writes the bullet as text, as do we.
        ordinal = within[i - 1] && featureKind(blockFeatureOf(within[i - 1]!)!.$type) === "list" ? ordinal + 1 : 1;
        out.push((feature.ordered ? `${ordinal}. ` : "• ") + renderInline(start, end));
      }
      pos = end;
    }
    if (pos < to) out.push(renderInline(pos, to));
    return out.join("");
  };

  return renderRange(0, bytes.length, blocks);
}

function renderSpan(raw: string, f: ColibriFacet, opts: RenderOpts): string {
  const kinds = new Set(f.features.map((x) => featureKind(x.$type)));
  const link = f.features.find((x) => featureKind(x.$type) === "link" && x.uri);
  const mention = f.features.find((x) => featureKind(x.$type) === "mention" && x.did);
  const channel = f.features.find((x) => featureKind(x.$type) === "channel" && x.channel);

  if (channel) {
    const c = opts.slackChannelForRkey?.(channel.channel!);
    return c ? `<#${c}>` : escapeMrkdwn(raw);
  }
  if (mention) {
    const u = opts.slackUserForDid(mention.did!);
    return u ? `<@${u}>` : escapeMrkdwn(raw);
  }
  if (link) {
    // Slack entity-escapes `&` inside a link URI in its own output (every
    // `<…?v=x&amp;t=y|label>` in the archive), and unescapes on parse.
    const uri = link.uri!.replaceAll("&", "&amp;").replaceAll("|", "%7C").replaceAll(">", "%3E");
    return raw === link.uri ? `<${uri}>` : `<${uri}|${escapeMrkdwn(raw)}>`;
  }
  if (kinds.has("code")) {
    // Slack has no fenced-code facet on the Colibri side; a multi-line code
    // span is what the forward walker emits for rich_text_preformatted.
    return raw.includes("\n") ? "```" + escapeMrkdwn(raw) + "```" : "`" + escapeMrkdwn(raw) + "`";
  }
  // Slack's inline markers only take effect against non-space neighbours, so
  // keep leading/trailing whitespace outside the markers.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw)!;
  let inner = escapeMrkdwn(m[2]!);
  if (!inner) return escapeMrkdwn(raw);
  if (kinds.has("strikethrough")) inner = `~${inner}~`;
  if (kinds.has("italic")) inner = `_${inner}_`;
  if (kinds.has("bold")) inner = `*${inner}*`;
  return m[1] + inner + m[3];
}
