// What the backfill does not carry. Every dump message the pipeline drops, and
// every category it publishes lossily, counted from the dumps themselves.
//
//   bun packages/backfill/scripts/gaps.ts          (run from the repository root)
//
// The output is the evidence behind GAPS.md; re-run it after changing the
// channel map or the walker and update the numbers there.
import { readdirSync, readFileSync, statSync } from "node:fs";

const ROOT = process.env.FOC_HISTORY ?? "vendor/feeling-of-computing/history";
const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = `${d}/${e}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".json")) files.push(p);
  }
};
walk(ROOT);

const mapped = new Set(
  Object.keys(JSON.parse(readFileSync("tools/slack-to-colibri-channel.json", "utf8"))).filter((k) => !k.startsWith("_")),
);
const chanName = new Map<string, string>(
  JSON.parse(readFileSync(`${ROOT}/channels.json`, "utf8")).map((c: any) => [c.id, c.name]),
);

const reasons = new Map<string, number>();
const subtypes = new Map<string, number>();
const unmapped = new Map<string, number>();
const yearNoBlocks = new Map<string, [number, number]>();
const fileTypes = new Map<string, number>();
let total = 0, published = 0, withFiles = 0, edited = 0, overCap = 0, capLost = 0;
let literalBullet = 0, literalQuote = 0;
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const f of files) {
  if (/users\.json|channels\.json|index\.json/.test(f)) continue;
  const isRepliesFile = f.includes(".replies.");
  let arr: any[];
  try { arr = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const m of arr) {
    // A thread reply appears in both the day file and the replies file; count
    // each message once, in the file src/index.ts actually takes it from.
    const isReply = m.thread_ts && m.thread_ts !== m.ts;
    if (isRepliesFile !== !!isReply) continue;
    total++;
    if (m.type !== "message") { bump(reasons, `type=${m.type}`); continue; }
    if (m.subtype) { bump(reasons, "subtype"); bump(subtypes, m.subtype); continue; }
    if (!m.text) { bump(reasons, "no text field"); continue; }
    if (!mapped.has(m.channel_id)) { bump(reasons, "unmapped channel"); bump(unmapped, m.channel_id); continue; }
    published++;
    const year = new Date(Number(String(m.ts).split(".")[0]) * 1000).getUTCFullYear().toString();
    const y = yearNoBlocks.get(year) ?? [0, 0];
    y[1]++;
    if (!Array.isArray(m.blocks)) {
      y[0]++;
      if (/(^|\n)\s*[•*-]\s/.test(m.text)) literalBullet++;
      if (/(^|\n)(&gt;|>)\s/.test(m.text)) literalQuote++;
    }
    yearNoBlocks.set(year, y);
    if (m.files?.length || m.attachments?.length) withFiles++;
    if (m.edited) edited++;
    if (m.text.length > 2048) { overCap++; capLost += m.text.length - 2048; }
    for (const fl of m.files ?? []) bump(fileTypes, fl.filetype ?? fl.mimetype ?? "?");
  }
}

const pad = (n: number) => n.toString().padStart(6);
console.log(`${total} dump messages, ${published} published (${((published / total) * 100).toFixed(1)}%)\n`);
console.log("NOT published:");
for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(n)}  ${k}`);
console.log("\n  by subtype:");
for (const [k, n] of [...subtypes].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(n)}  ${k}`);
console.log("\n  unmapped channels:");
for (const [c, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(n)}  ${c} #${chanName.get(c) ?? "?"}`);
console.log("\nPublished, but not everything the message carried:");
console.log(`  ${withFiles} carry files or attachments (not bridged)`);
console.log(`  ${edited} are marked edited (the dump has only the final text)`);
console.log(`  ${overCap} exceed the 2048-char cap, losing ${capLost} characters`);
console.log("\nno rich_text blocks — the walker falls back to the legacy text field:");
for (const [y, [n, t]] of [...yearNoBlocks].sort()) console.log(`  ${y}  ${pad(n)}/${t}  ${((n / t) * 100).toFixed(0)}%`);
console.log(`  of those, ${literalBullet} contain a literal bullet line and ${literalQuote} a literal quote line`);
console.log("\nfile types attached:");
for (const [k, n] of [...fileTypes].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${pad(n)}  ${k}`);
