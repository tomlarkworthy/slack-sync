# slack-sync

Two-way bridge between the [Feeling of Computing](https://feelingof.com/community) Slack workspace
and the [Colibri](https://colibri.social) atproto network.

- **Slack -> Colibri** live since 2026-05-31.
- **Colibri -> Slack** live since 2026-09-07 15:40Z (`a5e808d` consumer, `aadfe9c` Jetstream tail).

The operational record lives on the wiki: **<https://wiki.feelingof.com/slack-colibri-bridge/>** —
identifiers (Slack app, DIDs, queues, routes), the lexicons, the channel and user maps, measured
latency, and the known gaps. Read it before changing anything here. This README says only what is
in the repo and how to run it.

One correction against that page as of `014270f` (2026-09-08): its Maintenance section still points
at `packages/worker/src/channels.ts` and `src/slack-to-did.ts`. Both moved to `packages/shared/src/`.

## Layout

```
.
├── manifest/                Slack app manifest (paste-create at api.slack.com/apps)
└── packages/
    ├── backfill/            CLI: historical seed. Reads Mariano's
    │                        Feeling-of-Computing dumps and publishes
    │                        social.colibri.message + social.colibri.reaction
    │                        records on the bot's atproto repo.
    ├── shared/              One copy of the domain model: the Slack blocks
    │                        walker, the channel table, the Slack->DID map, the
    │                        emoji table, TID derivation, and the harness that
    │                        checks a walk against Slack's own plaintext.
    └── worker/              Cloudflare Worker: both directions.
        src/index.ts           Slack receiver + slack-events consumer (forward)
        src/reverse.ts         atproto-events consumer (reverse)
        src/tail.ts            JetstreamTail Durable Object, the reverse producer
        src/mrkdwn.ts          Colibri facets -> Slack mrkdwn
        src/eventlog.ts        com.feelingofcomputing.bridge.event, one collection
                               a reader can tail for both directions
```

## The two directions

| | Slack -> Colibri | Colibri -> Slack |
|---|---|---|
| Producer | `POST /slack/events`: HMAC-verify, enqueue, ack within Slack's 3 s | `JetstreamTail` DO (`src/tail.ts`): alarm every 10 s opens `wss://jetstream2.us-east.bsky.network` at the stored cursor, forwards the wanted commits, closes once an event is past the drain start; cron `*/1` re-arms a lost alarm |
| Queue | `slack-events` | `atproto-events` |
| Consumer | `src/index.ts`: archive the envelope as `slackRaw`, then derive `social.colibri.message` / `.reaction` | `src/reverse.ts`: `chat.postMessage` / `chat.update` / `chat.delete` / `reactions.*` as the bot, under the Colibri author's name and avatar (`chat:write.customize`) |
| Idempotency | Deterministic rkeys — `tidFromSlackTs(ts)` — so a redelivery `putRecord`s over itself | Slack's `ts` cannot be chosen, so each mirrored record gets a `com.feelingofcomputing.bridge.slackMirror` record keyed by the source rkey, holding the Slack coordinates. `update` and `delete` commits carry no record body on the wire and resolve through it |

The tail was chosen over contrail's cron indexer on latency measured 2026-09-07: Jetstream delivered
a native post 684 ms after it was written, against ~30 s median for a 1-minute cron cycle. A
persistent socket would have cost 82% of the Durable Object duration allowance; the 10 s alarm costs
16%. The measurements are in `plan/colibri-to-slack-bridge.md` in `lopecode-dev`.

### Loop safety

Two writers, one per direction, and each direction drops the other's account before any network
call: `reverse.ts` skips every commit where `did === BOT_DID`, `index.ts` skips every Slack event
from the bot (`isSelfSlackEvent`, three independent signals — the bot user id `U0B7685PHGD`, a
`bot_id`, or the `colibri_mirror` metadata the reverse half stamps on its own posts). The `bot_id`
signal is safe because no other bot has ever posted in a bridged channel: 0 of 3072 archived events
on 2026-09-07. Both guards are pinned in `packages/worker/test/echo.test.ts`, including the case
that must *not* be dropped — a human replying or reacting to the bot's own post.

A Slack reply or reaction on a post the reverse half mirrored reads that post's `colibri_mirror`
metadata through `conversations.replies` and writes `parent` as the native at-uri, so the round trip
lands back on the original record rather than on a bot-repo rkey (`18152fb`).

## Why two surfaces

- `backfill` is a one-time-then-occasional CLI driven by a JSON dump on disk. No webhook, no queue, no rate limit handling beyond a fixed delay.
- `worker` runs forever. Different deployment, different latency requirements, different failure modes (rate-limited Slack redelivery, queue retries).

They share `packages/shared/`: the Slack-blocks-to-Colibri-facets walker, the
channel table, the Slack-user-to-DID map, the emoji table, the TID derivation,
and the verification harness. That package exists because the alternative was
tried — each package kept its own copy, and `rich_text_list`, `message_mention`
and `facet#channel` were each handled in one copy and silently missing from the
other. Anything deployment-specific reaches the walker through `WalkContext`,
so backfill can still prefer the DID map in its dumps without forking the code.

`channels.ts` is the map both directions read. Since the community migrated on 2026-08-12 a channel
has two rkeys; the reverse map accepts the bare old rkey, the old at-uri and the new at-uri, because
the bridge writes the pre-migration rkey and native clients write the migrated at-uri.

## Quick start

```sh
bun install
bun run typecheck        # all three packages

# Backfill: see packages/backfill/README.md
bun --filter @slack-sync/backfill start --src-day 2026/05/30

# Worker: see packages/worker/README.md
bun --filter @slack-sync/worker dev

# Tests: 116 pass across 6 files, 2026-09-08
bun test packages/worker
```

The transform checks (`scripts/fidelity.ts`, `scripts/roundtrip.ts`, `test/corpus.test.ts`) run the
walker and the mrkdwn renderer against Slack's own plaintext of the same messages rather than
against hand-written cases. See `packages/worker/README.md` for what each one asserts and where the
remaining divergences are.

## Slack app

Create the bridge's Slack app from `manifest/slack-app.yaml`. The existing "FoC Conversation
Archiver" app is a user-token archiver owned by a different individual and is not modified. The
bridge's app is a separate bot-token app with its own Events API subscription. The reverse half
added `chat:write`, `chat:write.customize` and `reactions:write` on 2026-09-07; the event
subscriptions are unchanged. The bot must be `/invite`d into a channel to both receive its events
and post into it.

## Identity

The bridge publishes to a dedicated atproto identity on `bsky.social`
(`did:plc:4gcxakknd6hxtnhf33miwsob`, `@feelingofcomputing.bsky.social`). It authors messages into
channels it does not own. See the wiki page's **Identity** section for why — authorship on atproto
is immutable, and Colibri's appview constructs a channel's community URI from the channel record's
author DID.
