// Feed one Colibri record into the reverse half by hand, as the Jetstream
// commit event the tail would have produced. Test producer only.
//
//   INJECT_TOKEN=… bun scripts/inject.ts at://did:plc:…/social.colibri.message/3muwl2r2ehcww
//   INJECT_TOKEN=… bun scripts/inject.ts --delete at://…            # a delete commit (no record)
//   WORKER_URL defaults to the deployed worker.
//
// The record + cid are read from the author's own PDS (resolved through the
// DID document), so the event carries exactly what Jetstream would carry.

const WORKER_URL = process.env.WORKER_URL ?? "https://slack-sync-bridge.endpointservices.workers.dev";
const token = process.env.INJECT_TOKEN;
if (!token) throw new Error("INJECT_TOKEN not set");

const args = process.argv.slice(2);
const del = args.includes("--delete");
const uri = args.find((a) => a.startsWith("at://"));
if (!uri) throw new Error("usage: inject.ts [--delete] at://did/collection/rkey");
const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
if (!m) throw new Error(`bad at-uri ${uri}`);
const [, did, collection, rkey] = m as unknown as [string, string, string, string];

async function pdsFor(did: string): Promise<string> {
  const url = did.startsWith("did:web:") ? `https://${did.slice(8)}/.well-known/did.json` : `https://plc.directory/${did}`;
  const doc = (await (await fetch(url)).json()) as { service?: Array<{ id: string; serviceEndpoint: string }> };
  const pds = doc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error(`no PDS in DID document for ${did}`);
  return pds;
}

let commit: Record<string, unknown> = { operation: "delete", collection, rkey };
if (!del) {
  const pds = await pdsFor(did);
  const u = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
  u.searchParams.set("repo", did);
  u.searchParams.set("collection", collection);
  u.searchParams.set("rkey", rkey);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`getRecord ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { cid: string; value: unknown };
  commit = { operation: "create", collection, rkey, record: j.value, cid: j.cid };
}
const event = { did, time_us: Date.now() * 1000, kind: "commit", commit };

const res = await fetch(`${WORKER_URL}/atproto/inject`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(event),
});
console.log(res.status, await res.text());
