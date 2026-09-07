// com.feelingofcomputing.bridge.event — the append-only feed a reader tails.
//
// Both halves log one record per change to a FoC Colibri record. Pointers only:
// the content stays in the `social.colibri.*` record that `subject` names, which
// for a native post lives in the author's own repo, not the bot's. A reader
// tails this one collection on the bot repo newest-first and stops at the last
// rkey it holds; no fan-out over member repos, no full re-crawl to notice an
// edit or a delete.
//
// Why not reuse com.feelingofcomputing.bridge.slackMirror: that map is keyed by
// the source rkey and rewritten in place, because Slack's `ts` cannot be chosen
// and the mapping has to survive queue redelivery. Rewriting in place is exactly
// what a log must not do — an edit leaves the rkey where it was and a delete
// removes it, so a newest-first tail sees neither. The two collections answer
// different questions and both are kept.
//
// Ordering: rkey is a TID minted when the bridge observes the change, so
// listRecords' rkey order is observation order. That is deliberately not the
// record's own creation time — a log is ordered by when things happened to it.
//
// Duplicates: the log entry is written before the Slack call, so a Slack failure
// that lands the queue message back for retry can log the same change twice. A
// reader must be idempotent on (subject, cid, op), which it is if it merges
// records by uri. The alternative, logging only after Slack succeeds, would let
// a Slack outage silently drop a record from the feed that exists on atproto.

import { putRecord, tidFromMicros } from "./atproto";

export const EVENT_COLLECTION = "com.feelingofcomputing.bridge.event";

export interface BridgeEvent {
  $type: typeof EVENT_COLLECTION;
  /** What happened to `subject`, in Jetstream's vocabulary. */
  op: "create" | "update" | "delete";
  /** at-uri of the social.colibri.* record. Any repo. */
  subject: string;
  /** Record cid at the time of the event; absent for a delete. */
  cid?: string;
  /** FoC channel, as the pre-migration rkey the bridge writes. Absent when the
   *  event is a reaction whose target could not be resolved to a channel. */
  channel?: string;
  /** Which half logged it: `slack` = the bridge authored the record from a
   *  Slack event; `colibri` = a member authored it and the bridge saw it. */
  via: "slack" | "colibri";
  /** When the bridge observed the change, not when the record was created.
   *  On a backfilled entry there was no observation, so this is the record's
   *  own time and `backfill` says so. */
  at: string;
  /** Set on an entry synthesised from a record that already existed, rather
   *  than logged as it happened. Such an entry's rkey is derived from the
   *  subject's own TID so the log stays chronological across the switch-over. */
  backfill?: true;
}

export interface EventInput {
  op: BridgeEvent["op"];
  subject: string;
  cid?: string;
  channel?: string;
  via: BridgeEvent["via"];
  backfill?: true;
}

// TIDs are microsecond-resolution; Date.now() is milliseconds, so two events in
// the same millisecond would collide. Step forward instead, which keeps the log
// strictly increasing within an isolate. The clock id disambiguates isolates.
let lastMicros = 0n;
const CLOCK_ID = Math.floor(Math.random() * 1024);

export function nextEventRkey(now: number = Date.now(), clockId: number = CLOCK_ID): string {
  let micros = BigInt(Math.floor(now)) * 1000n;
  if (micros <= lastMicros) micros = lastMicros + 1n;
  lastMicros = micros;
  return tidFromMicros(micros, clockId);
}

export function buildEvent(ev: EventInput, at: string = new Date().toISOString()): BridgeEvent {
  return {
    $type: EVENT_COLLECTION,
    op: ev.op,
    subject: ev.subject,
    ...(ev.cid ? { cid: ev.cid } : {}),
    ...(ev.channel ? { channel: ev.channel } : {}),
    via: ev.via,
    at,
    ...(ev.backfill ? { backfill: true as const } : {}),
  };
}

// Never throws: a feed that cannot be written must not take the bridge down
// with it. The failure is returned as a note and logged.
export async function logEvent(
  sess: { did: string; accessJwt: string },
  ev: EventInput,
): Promise<string> {
  const rkey = nextEventRkey();
  try {
    await putRecord(sess, EVENT_COLLECTION, rkey, buildEvent(ev));
    return ` event=${rkey}`;
  } catch (e) {
    console.error(`event log ${ev.op} ${ev.subject}:`, e);
    return " event=FAILED";
  }
}
