// Slack user ID -> claimed atproto DID. Used by the worker to attach
// `social.colibri.richtext.facet#mention` facets to both the `@Author:`
// byline and inline `<@U…>` mentions so Colibri renders them as proper
// pings into the user's record.
//
// Source of truth at backfill time is `tools/slack-to-did.json` (gitignored).
// This file is the runtime copy bundled into the worker. Keep in sync.
//
// Add a new entry by uncommenting the line and pasting the user's DID (look
// it up via the user's bsky handle). Entries without a known DID are simply
// omitted — the byline / mention falls back to plain `@Name` text.

export const SLACK_USER_DID_MAP: Record<string, string> = {
  U02E4DAQGSZ: "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv", // Tom Larkworthy
  UJBAJNFLK:   "did:plc:r5lx5cznmnj6fftfy4hudgmm", // Konrad Hinsen
  UBN9AFS0N:   "did:plc:34jj3u665cbmkr6aklhtqmsc", // Mariano Guerra
  UC2A2ARPT:   "did:plc:fway37p6xwk2hu3c3t3rqs5t", // Ivan Reese
  UBKNXPBAB:   "did:plc:l5rqatj7wcih5xh6o43wub6h", // Joshua Horowitz
  U018S42NMMM: "did:plc:nwvtsa2zqyhpn5dvecdgec6p", // Nilesh Trivedi
  UCUSW7WVD:   "did:plc:tjjg4apdy6trfahz65f54duy", // Kartik Agaram
  U05UK5T7LPP: "did:plc:zlpfp5xn43tpzre5icmeuhcu", // Jasmine Otto
};

export function didForSlackUser(userId: string): string | undefined {
  return SLACK_USER_DID_MAP[userId];
}
