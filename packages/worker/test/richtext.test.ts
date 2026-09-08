import { describe, expect, test } from "bun:test";
import { walkBlocks } from "../src/index";

// Minimal stand-in for the builder the message path seeds with the byline.
class B {
  parts: string[] = [];
  facets: any[] = [];
  byteOffset = 0;
  emit(text: string, ...features: any[]) {
    if (!text) return;
    const start = this.byteOffset;
    this.parts.push(text);
    this.byteOffset += new TextEncoder().encode(text).length;
    if (features.length > 0)
      this.facets.push({
        $type: "social.colibri.richtext.facet",
        index: { byteStart: start, byteEnd: this.byteOffset },
        features,
      });
  }
  finish() {
    return { text: this.parts.join(""), facets: this.facets };
  }
}
const F = "social.colibri.richtext.facet";
const render = (blocks: any[]) => {
  const b = new B();
  walkBlocks(blocks as any, b as any, (id) => id);
  return b.finish();
};
const section = (...text: string[]) => ({
  type: "rich_text_section",
  elements: text.map((t) => ({ type: "text", text: t })),
});
const list = (style: string, items: string[], indent = 0) => ({
  type: "rich_text_list",
  style,
  indent,
  elements: items.map((t) => section(t)),
});

const listFacets = (r: { text: string; facets: any[] }) =>
  r.facets
    .filter((f) => f.features.some((x: any) => x.$type?.endsWith("#list")))
    .map((f) => ({
      ...f.features.find((x: any) => x.$type.endsWith("#list")),
      item: new TextDecoder().decode(new TextEncoder().encode(r.text).slice(f.index.byteStart, f.index.byteEnd)),
    }));

describe("rich_text_list", () => {
  // Regression: Ev0C056P675G (Kartik, #general 2026-09-07 19:53:08.677819) lost
  // its whole 15-item bullet list — the walker had no rich_text_list case, so
  // social.colibri.message/3muxbvu4e7v22 published as the lead-in line alone.
  // Colibri's model is one #list facet per item line, no bullet in the text.
  test("a bulleted list survives the walk, as facets", () => {
    const r = render([
      {
        type: "rich_text",
        elements: [
          section("Some past affordances text has acquired:\n"),
          list("bullet", ["spaces", "lowercase ", "hyperlinks "]),
        ],
      },
    ]);
    expect(r.text).toBe("Some past affordances text has acquired:\n\nspaces\nlowercase \nhyperlinks ");
    expect(listFacets(r)).toEqual([
      { $type: `${F}#list`, ordered: false, item: "spaces" },
      { $type: `${F}#list`, ordered: false, item: "lowercase " },
      { $type: `${F}#list`, ordered: false, item: "hyperlinks " },
    ]);
  });

  test("ordered lists set ordered; indent is carried and mirrored as leading space", () => {
    expect(listFacets(render([{ type: "rich_text", elements: [list("ordered", ["a", "b"])] }])))
      .toEqual([
        { $type: `${F}#list`, ordered: true, item: "a" },
        { $type: `${F}#list`, ordered: true, item: "b" },
      ]);
    const nested = render([{ type: "rich_text", elements: [list("bullet", ["deep"], 2)] }]);
    // Leading whitespace so a rev-4 client (no `indent` in the lexicon) still
    // infers depth from indentWidthAt; the facet itself starts after it.
    expect(nested.text).toBe("    deep");
    expect(listFacets(nested)).toEqual([{ $type: `${F}#list`, ordered: false, indent: 2, item: "deep" }]);
  });

  test("inline facets inside list items keep their byte ranges", () => {
    const { text, facets } = render([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            style: "bullet",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "link", text: "Colibri", url: "https://colibri.social" }],
              },
            ],
          },
        ],
      },
    ]);
    expect(text).toBe("Colibri");
    const link = facets.find((f) => f.features[0].$type === `${F}#link`)!;
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(link.index.byteStart, link.index.byteEnd))).toBe("Colibri");
    expect(link.features[0].uri).toBe("https://colibri.social");
  });
});

describe("rich_text_quote and rich_text_preformatted", () => {
  test("a quote is a #quote facet over clean text, not a '> ' prefix", () => {
    const r = render([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_quote",
            elements: [
              { type: "text", text: "see " },
              { type: "link", text: "this", url: "https://x.y/" },
            ],
          },
        ],
      },
    ]);
    expect(r.text).toBe("see this");
    const kinds = r.facets.map((f) => f.features[0].$type);
    expect(kinds).toContain(`${F}#quote`);
    // The link inside the quote keeps its URI — it used to be discarded.
    expect(r.facets.find((f) => f.features[0].$type === `${F}#link`)!.features[0].uri).toBe("https://x.y/");
  });

  test("a preformatted block is #codeblock, not inline #code", () => {
    const r = render([
      {
        type: "rich_text",
        elements: [
          { type: "rich_text_preformatted", elements: [{ type: "text", text: "one\ntwo" }] },
        ],
      },
    ]);
    expect(r.text).toBe("one\ntwo");
    expect(r.facets.map((f) => f.features[0].$type)).toEqual([`${F}#codeblock`]);
  });
});
