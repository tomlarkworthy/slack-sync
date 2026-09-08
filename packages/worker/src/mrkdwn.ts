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

export function renderFacets(text: string, facets: ColibriFacet[] | undefined, opts: RenderOpts): string {
  const bytes = enc.encode(text);
  const sorted = (facets ?? [])
    .filter((f) => f?.index && f.index.byteEnd > f.index.byteStart && f.index.byteStart >= 0)
    .sort((a, b) => a.index.byteStart - b.index.byteStart);
  const out: string[] = [];
  let pos = 0;
  for (const f of sorted) {
    const start = Math.min(f.index.byteStart, bytes.length);
    const end = Math.min(f.index.byteEnd, bytes.length);
    if (start < pos) continue; // overlapping facet: first one wins
    if (start > pos) out.push(escapeMrkdwn(dec.decode(bytes.subarray(pos, start))));
    out.push(renderSpan(dec.decode(bytes.subarray(start, end)), f, opts));
    pos = end;
  }
  if (pos < bytes.length) out.push(escapeMrkdwn(dec.decode(bytes.subarray(pos))));
  return out.join("");
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
