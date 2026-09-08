// Jetstream tail: the Durable Object producer for the reverse half.
//
// Every DRAIN_INTERVAL_MS an alarm opens a Jetstream socket at the stored
// cursor, forwards the commits the consumer wants onto the atproto-events
// queue, and closes the socket as soon as it is caught up. `identity` and
// `account` events flow regardless of the collection filter (~0.5/s), so
// "caught up" = any event whose time_us is past the moment the drain began.
// See plan/colibri-to-slack-bridge.md (observation 4, Cost on Cloudflare).

import { BOT_DID } from "./atproto";
import { channelForRef } from "@slack-sync/shared";
import { isJetstreamCommit, type JetstreamCommit, type JetstreamEvent } from "./reverse";

export const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";
export const COLLECTIONS = ["social.colibri.message", "social.colibri.reaction"];
export const DRAIN_INTERVAL_MS = 10_000;
export const DRAIN_BUDGET_MS = 8_000;
const FIRST_CURSOR_LOOKBACK_US = 60_000_000;

// The commits worth a queue op. Bot-repo writes are the bridge's own
// (dropped here as well as in the consumer); messages are dropped unless their
// channel maps to Slack; reactions and deletes carry no channel, so they pass
// and the consumer resolves them (unmapped ones end as no-ops).
export function wantEvent(e: unknown): JetstreamCommit | null {
  if (!isJetstreamCommit(e)) return null;
  if (e.did === BOT_DID) return null;
  if (!COLLECTIONS.includes(e.commit.collection)) return null;
  if (e.commit.collection === "social.colibri.message" && e.commit.operation !== "delete") {
    const rec = e.commit.record as { channel?: string } | undefined;
    if (!channelForRef(rec?.channel)) return null;
  }
  return e;
}

export function jetstreamUrl(cursorUs: number): string {
  const u = new URL(JETSTREAM_URL);
  for (const c of COLLECTIONS) u.searchParams.append("wantedCollections", c);
  u.searchParams.set("cursor", String(cursorUs));
  return u.toString();
}

export interface SocketLike {
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: () => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export interface DrainResult {
  seen: number;
  wanted: JetstreamCommit[];
  lastTimeUs: number;
  caughtUp: boolean;
  ms: number;
}

// One drain: read from `cursorUs` until an event at/after `startUs` arrives
// (caught up) or `budgetMs` elapses. Pure apart from the socket, so a Bun
// script can run it against the live firehose.
export async function drainOnce(
  open: (url: string) => Promise<SocketLike>,
  cursorUs: number,
  opts: { startUs?: number; budgetMs?: number } = {},
): Promise<DrainResult> {
  const startUs = opts.startUs ?? Date.now() * 1000;
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS;
  const t0 = Date.now();
  const ws = await open(jetstreamUrl(cursorUs));
  const out: DrainResult = { seen: 0, wanted: [], lastTimeUs: cursorUs, caughtUp: false, ms: 0 };
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close(1000, "drained");
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, budgetMs);
    ws.addEventListener("message", (m) => {
      let e: JetstreamEvent;
      try {
        e = JSON.parse(typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
      } catch {
        return;
      }
      out.seen++;
      if (typeof e.time_us === "number" && e.time_us > out.lastTimeUs) out.lastTimeUs = e.time_us;
      const w = wantEvent(e);
      if (w) out.wanted.push(w);
      if (typeof e.time_us === "number" && e.time_us >= startUs) {
        out.caughtUp = true;
        finish();
      }
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);
  });
  out.ms = Date.now() - t0;
  return out;
}

async function openWorkerSocket(url: string): Promise<SocketLike> {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`jetstream upgrade failed: ${res.status}`);
  ws.accept();
  return ws as unknown as SocketLike;
}

interface TailStats {
  enabled: boolean;
  cursorUs: number | null;
  lastDrainAt?: string;
  lastDrainMs?: number;
  lastSeen?: number;
  lastEnqueued?: number;
  lastCaughtUp?: boolean;
  lastError?: string;
  drains: number;
  enqueued: number;
  alarmAt: number | null;
}

export interface TailEnv {
  EVENTS_ATPROTO: Queue<JetstreamEvent>;
}

// Single instance, addressed by name "tail". POST /start, POST /stop, POST
// /poke (cron: re-arm the alarm if it was lost), GET /status.
export class JetstreamTail {
  constructor(
    private state: DurableObjectState,
    private env: TailEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const s = this.state.storage;
    if (request.method === "POST" && path === "/start") {
      await s.put("enabled", true);
      await s.setAlarm(Date.now());
    } else if (request.method === "POST" && path === "/stop") {
      await s.put("enabled", false);
      await s.deleteAlarm();
    } else if (request.method === "POST" && path === "/poke") {
      if ((await s.get<boolean>("enabled")) && (await s.getAlarm()) === null) {
        await s.setAlarm(Date.now());
      }
    } else if (!(request.method === "GET" && path === "/status")) {
      return new Response("not found", { status: 404 });
    }
    return Response.json(await this.stats());
  }

  async alarm(): Promise<void> {
    const s = this.state.storage;
    if (!(await s.get<boolean>("enabled"))) return;
    // Re-arm first so a thrown drain cannot stop the tail.
    await s.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    const cursor = (await s.get<number>("cursor")) ?? Date.now() * 1000 - FIRST_CURSOR_LOOKBACK_US;
    const t = new Date().toISOString();
    try {
      const r = await drainOnce(openWorkerSocket, cursor);
      for (let i = 0; i < r.wanted.length; i += 100) {
        await this.env.EVENTS_ATPROTO.sendBatch(r.wanted.slice(i, i + 100).map((body) => ({ body })));
      }
      // Caught up with nothing new: the clock, not the last event, is the cursor.
      const next = r.caughtUp ? Math.max(r.lastTimeUs, Date.now() * 1000 - 1_000_000) : r.lastTimeUs;
      await s.put({
        cursor: next,
        lastDrainAt: t,
        lastDrainMs: r.ms,
        lastSeen: r.seen,
        lastEnqueued: r.wanted.length,
        lastCaughtUp: r.caughtUp,
        lastError: null,
        drains: ((await s.get<number>("drains")) ?? 0) + 1,
        enqueued: ((await s.get<number>("enqueued")) ?? 0) + r.wanted.length,
      });
      if (r.wanted.length) console.log("tail", t, `enqueued ${r.wanted.length} of ${r.seen} in ${r.ms}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("tail", t, "drain FAILED", msg);
      await s.put({ lastDrainAt: t, lastError: msg, drains: ((await s.get<number>("drains")) ?? 0) + 1 });
    }
  }

  private async stats(): Promise<TailStats> {
    const s = this.state.storage;
    const m = await s.list();
    const g = <T>(k: string) => m.get(k) as T | undefined;
    return {
      enabled: g<boolean>("enabled") ?? false,
      cursorUs: g<number>("cursor") ?? null,
      lastDrainAt: g("lastDrainAt"),
      lastDrainMs: g("lastDrainMs"),
      lastSeen: g("lastSeen"),
      lastEnqueued: g("lastEnqueued"),
      lastCaughtUp: g("lastCaughtUp"),
      lastError: g("lastError") ?? undefined,
      drains: g<number>("drains") ?? 0,
      enqueued: g<number>("enqueued") ?? 0,
      alarmAt: await s.getAlarm(),
    };
  }
}
