# @slack-sync/worker

Cloudflare Worker for the real-time forward bridge. Slack Events API webhook -> CF Queue -> atproto.

Forward half live since 2026-05-31; reverse half (Colibri -> Slack) landed 2026-09-07 without its Jetstream producer.

## Bring up

```sh
# install
bun install

# secrets (after the Slack app exists - see ../../manifest/README.md)
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put BSKY_HANDLE
wrangler secret put BSKY_APP_PASSWORD

# infra (uncomment the corresponding bindings in wrangler.toml first)
wrangler queues create slack-events
wrangler queues create slack-events-dlq
wrangler queues create atproto-events
wrangler queues create atproto-events-dlq
wrangler secret put INJECT_TOKEN
wrangler d1 create slack-sync-cache

# dev (tunnel + live reload)
wrangler dev

# deploy
wrangler deploy
```

After deploy, set the Slack app's **Event Subscriptions -> Request URL** to `https://<your-worker-domain>/slack/events`. Slack will issue a one-shot `url_verification` challenge; the worker responds with the challenge string.

## What it does

| Path | Role |
|---|---|
| `POST /slack/events` | Verify HMAC, enqueue payload, ack <3s. |
| Queue consumer | Capture as `slackRaw`, derive `social.colibri.message`, link via `slackOrigin`, project reactions, upload file blobs. |
| `GET /health` | Liveness check for monitoring. |
| `POST /atproto/inject` | Reverse half test producer: bearer `INJECT_TOKEN`, body = one Jetstream commit event or an array, enqueued to `atproto-events`. `bun scripts/inject.ts at://…` builds one from a live record. |
| Queue consumer `atproto-events` | Reverse half (`src/reverse.ts`): mirror `social.colibri.message` / `.reaction` from any author except the bot into Slack as the bot user, `@name:` byline, `slackMirror` record per mirrored record for idempotency and lookups. No Jetstream producer is wired yet. |

See the design proposal (PR #20) for HMAC verification details, the dedupe model (deterministic rkeys -> putRecord upsert), and the read-modify-write pattern for category `channelOrder` updates.
