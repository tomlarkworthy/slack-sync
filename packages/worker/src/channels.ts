// Slack channel <-> Colibri channel, both directions.
//
// The FoC community was created on the owner's DID on 2026-05-31 and migrated
// to its own identity on 2026-08-12. Every channel therefore has two rkeys:
// the bridge still writes the pre-migration one (bare, which Colibri resolves
// through `migratedFrom`); the Colibri client writes the migrated one as an
// at-uri. The reverse map accepts all three spellings.
//
// Mirror of tools/slack-to-colibri-channel.json on the backfill side.

export const OLD_OWNER_DID = "did:plc:j7nm3lrd5h7fm3sfhcv3lhfv";
export const COMMUNITY_DID = "did:plc:dl3d3fftr4tk3yf3xqxouus7";

export interface Channel {
  slack: string;
  name: string;
  oldRkey: string; // on OLD_OWNER_DID, community 3mn5nudqvhs2x
  newRkey: string; // on COMMUNITY_DID, community `self`
}

export const CHANNELS: Channel[] = [
  { slack: "C01932BJGE8", name: "present-company",    oldRkey: "3mn5tlwafrh2k", newRkey: "3msvih7djjqmu" },
  { slack: "CCL5VVBAN",   name: "share-your-work",    oldRkey: "3mn5tmbyexz27", newRkey: "3msvih7djjbh2" },
  { slack: "C5T9GPWFL",   name: "thinking-together",  oldRkey: "3mn5tmllqd72d", newRkey: "3msvih7djjlku" },
  { slack: "C050QK4917D", name: "of-ai",              oldRkey: "3mn5tlntcfa2f", newRkey: "3msvih7djjm5k" },
  { slack: "C03RR0W5DGC", name: "devlog-together",    oldRkey: "3mn5tk5v4yr2s", newRkey: "3msvih7djji3e" },
  { slack: "C5U3SEW6A",   name: "linking-together",   oldRkey: "3mn5tle5l7c2z", newRkey: "3msvih7djjpb2" },
  { slack: "CEXED56UR",   name: "administrivia",      oldRkey: "3mn5tjjdnai2t", newRkey: "3msvih7djjo7j" },
  { slack: "CGMJ7323Z",   name: "announcements",      oldRkey: "3mn5tjsyuvt2t", newRkey: "3msvih7djjrdp" },
  { slack: "CC2JRGVLK",   name: "introduce-yourself", oldRkey: "3mn5tkvfo2j2s", newRkey: "3msvih7djjfxt" },
  { slack: "C0120A3L30R", name: "two-minute-week",    oldRkey: "3mn5tn53kwy2w", newRkey: "3msvih7djjha6" },
  { slack: "C0B7BGKT8MP", name: "test-01",            oldRkey: "3mn5tckh3ij24", newRkey: "3msvih7djjklu" },
];

// Forward direction: Slack channel id -> the rkey the bridge writes.
export const CHANNEL_MAP: Record<string, string> = Object.fromEntries(
  CHANNELS.map((c) => [c.slack, c.oldRkey]),
);

const BY_REF = new Map<string, Channel>();
for (const c of CHANNELS) {
  BY_REF.set(c.oldRkey, c);
  BY_REF.set(c.newRkey, c);
  BY_REF.set(`at://${OLD_OWNER_DID}/social.colibri.channel/${c.oldRkey}`, c);
  BY_REF.set(`at://${COMMUNITY_DID}/social.colibri.channel/${c.newRkey}`, c);
}

// Reverse direction: a `channel` field in any spelling -> the channel, or
// undefined for a room that is not FoC's.
export function channelForRef(ref: string | undefined): Channel | undefined {
  if (!ref) return undefined;
  return BY_REF.get(ref);
}

const BY_SLACK = new Map(CHANNELS.map((c) => [c.slack, c]));

// A Slack channel id -> the channel. Used where only the Slack side is known,
// e.g. a slackMirror record, which stores Slack coordinates and no rkey.
export function channelForSlackId(id: string | undefined): Channel | undefined {
  if (!id) return undefined;
  return BY_SLACK.get(id);
}
