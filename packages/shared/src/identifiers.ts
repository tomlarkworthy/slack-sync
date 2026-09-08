// Identifier derivation shared by the worker and the backfill CLI: the Colibri
// rkey for a Slack message is its timestamp, so the mapping is reversible and
// needs no lookup table. Kept apart from the networked half of atproto.ts so
// both packages can import it without pulling in a session.

export const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob"; // feelingofcomputing.bsky.social

export function parseAtUri(ref: string): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(ref);
  return m ? { did: m[1]!, collection: m[2]!, rkey: m[3]! } : null;
}

// ── TID derivation (matches backfill) ──────────────────────────────────────
const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
export function tidFromMicros(microseconds: bigint, clockId = 0): string {
  let n = (microseconds << 10n) | BigInt(clockId & 0x3ff);
  const chars: string[] = [];
  for (let i = 0; i < 13; i++) {
    chars.push(TID_ALPHABET[Number(n & 0x1fn)]!);
    n >>= 5n;
  }
  return chars.reverse().join("");
}
export function tidFromSlackTs(ts: string, clockId = 0): string {
  const [sec, usecRaw = ""] = ts.split(".");
  const usec = (usecRaw + "000000").slice(0, 6);
  return tidFromMicros(BigInt(sec!) * 1_000_000n + BigInt(usec), clockId);
}
// Inverse of tidFromSlackTs: the bridge's message rkeys carry the Slack ts in
// their top 54 bits, so a bridged message's Slack coordinates need no lookup.
export function slackTsFromTid(tid: string): string {
  let n = 0n;
  for (const c of tid) {
    const v = TID_ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`bad tid ${tid}`);
    n = (n << 5n) | BigInt(v);
  }
  const micros = n >> 10n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}
export function hash10(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) & 0x3ff;
}
