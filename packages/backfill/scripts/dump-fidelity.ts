// Does the walker survive the input backfill will actually be given?
//
// The live bridge's archive covers three months; these dumps are the whole
// community from 2017. Run the shared walker over every eligible message and
// check it against Slack's own plaintext, the same oracle the worker's corpus
// test uses — plus report any rich-text element type the walker has no case
// for, which is how rich_text_list and message_mention were lost.
//
//   bun packages/backfill/scripts/dump-fidelity.ts [--detail]
//
// Run from the repository root: the dump paths are relative to it, as they are
// in src/index.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { derive, lostWords } from "@slack-sync/shared";

const ROOT = process.env.FOC_HISTORY ?? "vendor/feeling-of-computing/history";
const HANDLED = new Set([
  "rich_text", "rich_text_section", "rich_text_list", "rich_text_quote",
  "rich_text_preformatted", "text", "link", "message_mention", "user",
  "channel", "emoji", "broadcast", "color",
]);

const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const p = `${dir}/${entry}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".json") && !p.includes(".replies.")) files.push(p);
  }
};
walk(ROOT);

const collect = (els: any[] | undefined, into: Set<string>) => {
  for (const e of els ?? []) { if (e?.type) into.add(e.type); collect(e.elements, into); }
};

let eligible = 0, withBlocks = 0;
const facetCounts = new Map<string, number>();
const unhandled = new Map<string, string>();
const lossy: Array<{ ts: string; file: string; types: string[]; lost: string[] }> = [];

for (const file of files) {
  let day: any;
  try { day = JSON.parse(readFileSync(file, "utf-8")); } catch { continue; }
  if (!Array.isArray(day)) continue;
  for (const m of day) {
    if (m?.type !== "message" || m.subtype || !m.text) continue;
    eligible++;
    if (!Array.isArray(m.blocks) || !m.blocks.some((b: any) => b?.type === "rich_text")) continue;
    withBlocks++;

    const types = new Set<string>();
    for (const b of m.blocks) { types.add(b.type); collect(b.elements, types); }
    for (const t of types) if (!HANDLED.has(t) && !unhandled.has(t)) unhandled.set(t, `${file} ${m.ts}`);

    for (const f of derive(m.blocks).facets) {
      for (const x of f.features as any[]) {
        const k = String(x.$type).split("#")[1]!;
        facetCounts.set(k, (facetCounts.get(k) ?? 0) + 1);
      }
    }
    const lost = lostWords(m.blocks, m.text);
    if (lost.length) lossy.push({ ts: m.ts, file, types: [...types], lost });
  }
}

console.log(`${files.length} dump files, ${eligible} eligible messages, ${withBlocks} with rich_text blocks`);
console.log(`losing a word of Slack's plaintext: ${lossy.length} (${((100 * lossy.length) / withBlocks).toFixed(2)}%)\n`);
console.log("facets the walker produces over the whole history:");
for (const [k, v] of [...facetCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);

if (unhandled.size > 0) {
  console.log("\nELEMENT TYPES WITH NO CASE IN THE WALKER:");
  for (const [t, where] of unhandled) console.log(`  ${t}  first at ${where}`);
} else {
  console.log("\nno unhandled element types");
}
if (process.argv.includes("--detail")) {
  console.log("\nlossy messages:");
  for (const l of lossy.slice(0, 40)) console.log(`  ${l.ts} [${l.types.join(",")}] lost: ${l.lost.slice(0, 10).join(" ")}`);
}
process.exit(unhandled.size > 0 ? 1 : 0);
