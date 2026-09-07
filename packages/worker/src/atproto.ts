// atproto helpers shared by the forward (Slack -> Colibri) and reverse
// (Colibri -> Slack) halves: bot session, record CRUD on the bot repo, reads
// from any repo via its own PDS, and the TID <-> Slack ts derivation.

export const PDS = "https://bsky.social";
export const BOT_DID = "did:plc:4gcxakknd6hxtnhf33miwsob"; // feelingofcomputing.bsky.social

export interface AtprotoEnv {
  BSKY_HANDLE?: string;
  BSKY_APP_PASSWORD?: string;
}
export interface Session {
  did: string;
  accessJwt: string;
  expiresAt: number;
}

// ── bot session (cached per isolate) ───────────────────────────────────────
let cachedSession: Session | null = null;
export async function getBskySession(env: AtprotoEnv): Promise<Session> {
  if (cachedSession && cachedSession.expiresAt > Date.now() + 60_000) {
    return cachedSession;
  }
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  });
  if (!r.ok) throw new Error(`bsky login: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { did: string; accessJwt: string };
  cachedSession = { ...j, expiresAt: Date.now() + 90 * 60 * 1000 };
  return cachedSession;
}

export async function putRecord(
  sess: { did: string; accessJwt: string },
  collection: string,
  rkey: string,
  record: unknown,
) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({ repo: sess.did, collection, rkey, record }),
  });
  if (!r.ok) throw new Error(`putRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}

export async function deleteRecord(
  sess: { did: string; accessJwt: string },
  collection: string,
  rkey: string,
) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({ repo: sess.did, collection, rkey }),
  });
  // 404 = already gone; treat as success (idempotent)
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`deleteRecord ${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return await r.json();
}

// ── reads from any repo ────────────────────────────────────────────────────
// A repo's records are served by its own PDS; bsky.social only answers for
// repos it hosts. Resolve the DID document once per isolate.
const didDocCache = new Map<string, { pds?: string; handle?: string }>();
export async function resolveDid(did: string): Promise<{ pds?: string; handle?: string }> {
  const hit = didDocCache.get(did);
  if (hit) return hit;
  let url: string;
  if (did.startsWith("did:plc:")) url = `https://plc.directory/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${did.slice(8)}/.well-known/did.json`;
  else return {};
  const out: { pds?: string; handle?: string } = {};
  try {
    const r = await fetch(url);
    if (r.ok) {
      const doc = (await r.json()) as {
        alsoKnownAs?: string[];
        service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
      };
      out.pds = doc.service?.find((s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer")
        ?.serviceEndpoint;
      const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
      if (aka) out.handle = aka.slice(5);
    }
  } catch {}
  didDocCache.set(did, out);
  return out;
}

export async function getRecord<T = unknown>(
  repo: string,
  collection: string,
  rkey: string,
): Promise<{ uri: string; cid: string; value: T } | null> {
  const base = repo === BOT_DID ? PDS : (await resolveDid(repo)).pds ?? PDS;
  const u = new URL(`${base}/xrpc/com.atproto.repo.getRecord`);
  u.searchParams.set("repo", repo);
  u.searchParams.set("collection", collection);
  u.searchParams.set("rkey", rkey);
  const r = await fetch(u);
  if (r.status === 400 || r.status === 404) {
    // bsky PDSes answer RecordNotFound with 400
    const t = await r.text();
    if (/RecordNotFound|Could not locate record|not found/i.test(t) || r.status === 404) return null;
    throw new Error(`getRecord ${repo}/${collection}/${rkey}: ${r.status} ${t}`);
  }
  if (!r.ok) throw new Error(`getRecord ${repo}/${collection}/${rkey}: ${r.status} ${await r.text()}`);
  return (await r.json()) as { uri: string; cid: string; value: T };
}

// ── at-uri parsing ─────────────────────────────────────────────────────────
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
