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

describe("rich_text_list", () => {
  // Regression: Ev0C056P675G (Kartik, #general 2026-09-07 19:53:08.677819) lost
  // its whole 15-item bullet list — the walker had no rich_text_list case, so
  // social.colibri.message/3muxbvu4e7v22 published as the lead-in line alone.
  test("a bulleted list survives the walk", () => {
    const { text } = render([
      {
        type: "rich_text",
        elements: [
          section("Some past affordances text has acquired:\n"),
          list("bullet", ["spaces", "lowercase ", "hyperlinks "]),
        ],
      },
    ]);
    expect(text).toBe(
      "Some past affordances text has acquired:\n\n• spaces\n• lowercase \n• hyperlinks ",
    );
  });

  test("ordered lists number from 1; indent nests two spaces per level", () => {
    expect(render([{ type: "rich_text", elements: [list("ordered", ["a", "b"])] }]).text)
      .toBe("1. a\n2. b");
    expect(render([{ type: "rich_text", elements: [list("bullet", ["deep"], 2)] }]).text)
      .toBe("    • deep");
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
    expect(text).toBe("• Colibri");
    expect(facets).toHaveLength(1);
    const bytes = new TextEncoder().encode(text);
    expect(
      new TextDecoder().decode(bytes.slice(facets[0].index.byteStart, facets[0].index.byteEnd)),
    ).toBe("Colibri"); // "•" is 3 bytes — offsets are byte offsets, not JS indices
    expect(facets[0].features[0].uri).toBe("https://colibri.social");
  });
});
