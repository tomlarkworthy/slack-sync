// Run one drain against the live firehose with Bun's WebSocket.
//   bun scripts/tail-smoke.ts                 # cursor = now - 30 s
//   bun scripts/tail-smoke.ts <cursor_us> [budget_ms]
import { drainOnce, type SocketLike } from "../src/tail";
const cursor = Number(process.argv[2] ?? Date.now() * 1000 - 30_000_000);
const budget = Number(process.argv[3] ?? 8000);
const open = async (url: string): Promise<SocketLike> => {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", (e) => rej(e)); });
  return ws as unknown as SocketLike;
};
const r = await drainOnce(open, cursor, { budgetMs: budget });
console.log(JSON.stringify({ seen: r.seen, wanted: r.wanted.length, caughtUp: r.caughtUp, ms: r.ms, behindS: r.caughtUp ? 0 : (Date.now() * 1000 - r.lastTimeUs) / 1e6 }));
for (const w of r.wanted) console.log(" ", w.did, w.commit.collection, w.commit.operation, w.commit.rkey, (w.commit.record as { text?: string })?.text?.slice(0, 40) ?? "");
