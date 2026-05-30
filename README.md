# slack-sync

Slack to atproto (Colibri) bridge for the [Feeling of Computing](https://feelingof.com/community) community.

Companion code to the design proposal in [feelingofcomputing/wiki PR #20](https://github.com/feelingofcomputing/wiki/pull/20) (`pages/slack-colibri-bridge.md`).

## Layout

```
.
├── manifest/                Slack app manifest (paste-create at api.slack.com/apps)
│   ├── slack-app.yaml
│   └── README.md
└── packages/
    ├── backfill/            CLI: historical seed. Reads Mariano's
    │                        Feeling-of-Computing dumps and publishes
    │                        social.colibri.message + social.colibri.reaction
    │                        records on the bot's atproto repo.
    └── worker/              Cloudflare Worker: forward bridge. Slack Events
                             API producer (HMAC verify, enqueue) + CF Queue
                             consumer (derive + publish).
```

## Why two surfaces

- `backfill` is a one-time-then-occasional CLI driven by a JSON dump on disk. No webhook, no queue, no rate limit handling beyond a fixed delay.
- `worker` runs forever. Different deployment, different latency requirements, different failure modes (rate-limited Slack redelivery, queue retries). They share lexicon definitions, the Slack-blocks-to-Colibri-facets walker, and atproto write helpers — those will land in a `packages/shared/` workspace when the second consumer arrives. Premature today.

## Quick start

```sh
bun install

# Backfill: see packages/backfill/README.md
bun --filter @slack-sync/backfill start --src-day 2026/05/30

# Worker: see packages/worker/README.md
bun --filter @slack-sync/worker dev
```

## Slack app

Create the bridge's Slack app from `manifest/slack-app.yaml`. The existing "FoC Conversation Archiver" app is a user-token archiver owned by a different individual and is not modified. The bridge's app is a separate bot-token app with its own Events API subscription.

## Identity

The bridge publishes to a dedicated atproto identity on `bsky.social`. See the design proposal (PR #20) for the authorship model.
