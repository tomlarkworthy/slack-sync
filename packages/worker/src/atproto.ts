// atproto helpers shared by the forward (Slack -> Colibri) and reverse
// (Colibri -> Slack) halves: bot session, record CRUD on the bot repo, reads
// from any repo via its own PDS, and the TID <-> Slack ts derivation.

import { BOT_DID } from "@slack-sync/shared";

export const PDS = "https://bsky.social";

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

// Identifier derivation lives in @slack-sync/shared; re-exported so the
// worker's own modules keep importing it from here.
export {
  BOT_DID,
  hash10,
  parseAtUri,
  slackTsFromTid,
  tidFromMicros,
  tidFromSlackTs,
} from "@slack-sync/shared";
