// Run the Durable Object's own drain against the live firehose with Bun's
// WebSocket. No Cloudflare credentials, so it answers the question the DO's
// /tail/status cannot: did Jetstream ever carry this commit, and when.
//
//   bun scripts/tail-smoke.ts                          # one drain, cursor = now - 30 s
//   bun scripts/tail-smoke.ts <cursor_us> [budget_ms]  # one drain from a cursor
//   bun scripts/tail-smoke.ts --watch <iso> [seconds]  # every commit from <iso>, with arrival times
//
// --watch exists because a missing message looks identical whether the tail is
// down or the write simply has not federated yet. On 2026-09-07 a post written
// at 20:38:11 reached Jetstream at 20:42:25 — 255 s — while an earlier post from
// the same repo took under 2 s. Only the arrival time separates the two.
import { drainOnce, jetstreamUrl, wantEvent, type SocketLike } from "../src/tail";

const open = async (url: string): Promise<SocketLike> => {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(e));
  });
  return ws as unknown as SocketLike;
};

// rkeys are TIDs, so a commit carries the moment it was written; the difference
// against time_us is how long the PDS and relay took.
const TID = "234567abcdefghijklmnopqrstuvwxyz";
const tidMicros = (rkey: string): number | null => {
  if (!/^[2-7a-z]{13}$/.test(rkey)) return null;
  let n = 0n;
  for (const c of rkey) n = n * 32n + BigInt(TID.indexOf(c));
  return Number(n >> 10n);
};

if (process.argv[2] === "--watch") {
  const from = Date.parse(process.argv[3] ?? "");
  if (Number.isNaN(from)) throw new Error("usage: --watch <iso timestamp> [seconds]");
  const seconds = Number(process.argv[4] ?? 60);
  const ws = new WebSocket(jetstreamUrl(from * 1000));
  let seen = 0;
  let lastUs = 0;
  await new Promise<void>((resolve) => {
    const stop = () => { try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(stop, seconds * 1000);
    ws.addEventListener("message", (m: MessageEvent) => {
      let e: { time_us?: number; did?: string; commit?: { collection: string; rkey: string; operation: string } };
      try { e = JSON.parse(m.data as string); } catch { return; }
      seen++;
      if (typeof e.time_us === "number") lastUs = e.time_us;
      if (!e.commit || typeof e.time_us !== "number") return;
      const wrote = tidMicros(e.commit.rkey);
      const lag = wrote ? ` lag ${((e.time_us - wrote) / 1e6).toFixed(1)}s` : "";
      const verdict = wantEvent(e) ? "WANTED" : "dropped";
      console.log(
        `${new Date(e.time_us / 1000).toISOString()}  ${e.did}  ${e.commit.collection}/${e.commit.rkey} ${e.commit.operation}  ${verdict}${lag}`,
      );
    });
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", () => { clearTimeout(timer); resolve(); });
  });
  console.log(`seen ${seen} events, reached ${new Date(lastUs / 1000).toISOString()}`);
} else {
  const cursor = Number(process.argv[2] ?? Date.now() * 1000 - 30_000_000);
  const budget = Number(process.argv[3] ?? 8000);
  const r = await drainOnce(open, cursor, { budgetMs: budget });
  console.log(JSON.stringify({ seen: r.seen, wanted: r.wanted.length, caughtUp: r.caughtUp, ms: r.ms, behindS: r.caughtUp ? 0 : (Date.now() * 1000 - r.lastTimeUs) / 1e6 }));
  for (const w of r.wanted) console.log(" ", w.did, w.commit.collection, w.commit.operation, w.commit.rkey, (w.commit.record as { text?: string })?.text?.slice(0, 40) ?? "");
}
