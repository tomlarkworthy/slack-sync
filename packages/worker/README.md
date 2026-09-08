# @slack-sync/worker

Cloudflare Worker for the real-time forward bridge. Slack Events API webhook -> CF Queue -> atproto.

Forward half live since 2026-05-31; reverse half (Colibri -> Slack) landed 2026-09-07, fed by a Jetstream tail Durable Object.

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
| `POST /slack/replay` | Re-derive archived messages after a derivation fix: bearer `INJECT_TOKEN`, body = one `event_callback` envelope from `slackRaw` or an array, enqueued to `slack-events`. rkeys are `tidFromSlackTs(ts)`, so records are overwritten in place. `bun scripts/replay.ts --has-list [--dry-run]` picks the envelopes (newest per message, deletes excluded). |
| `POST /atproto/inject` | Reverse half test producer: bearer `INJECT_TOKEN`, body = one Jetstream commit event or an array, enqueued to `atproto-events`. `bun scripts/inject.ts at://…` builds one from a live record. |
| Forward lookup on mirrored posts | A Slack reply or reaction whose target was posted by the reverse half (author = bot) reads the post's `colibri_mirror` metadata via `conversations.replies` and writes `parent` as the native at-uri instead of a bot-repo rkey. |
| Queue consumer `atproto-events` | Reverse half (`src/reverse.ts`): mirror `social.colibri.message` / `.reaction` from any author except the bot into Slack as the bot user, author as the post name and avatar (`@name:` byline only without `chat:write.customize`), `slackMirror` record per mirrored record for idempotency and lookups. |
| Durable Object `JetstreamTail` (`src/tail.ts`) | Producer for `atproto-events`. Alarm every 10 s: open Jetstream at the stored cursor, forward bot-free commits whose channel maps (messages) or that need a lookup (reactions, deletes), close once an event is past the drain start. Cron `*/1` re-arms a lost alarm. |
| `GET /tail/status`, `POST /tail/start`, `POST /tail/stop` | Tail control, bearer `INJECT_TOKEN`. Status carries cursor, last drain size/duration, caught-up flag, last error, next alarm. `bun scripts/tail-smoke.ts [cursor_us] [budget_ms]` runs one drain locally. |

## Checking the transforms

The forward walker (Slack `blocks` -> Colibri text+facets, `src/index.ts`) and
the reverse renderer (`src/mrkdwn.ts`, which calls itself its inverse) are
checked against Slack's own output rather than against hand-written cases.
Every Slack message event carries both `blocks` and `text` — Slack's own
plaintext of the same message — so the archive in
`com.feelingofcomputing.bridge.slackRaw` is an independent oracle.

| Command | What it asserts |
|---|---|
| `bun scripts/fidelity.ts [--detail]` | No word of Slack's plaintext is missing from what the walker produces. 1261 of 1263 archived messages lossless; the 2 are Slack autolinking in its fallback text something the block tree carries as plain text. |
| `bun scripts/roundtrip.ts [--detail]` | blocks -> walker -> renderer -> mrkdwn equals the mrkdwn Slack sent. 898 of 916 distinct messages (98%) exact; divergences are grouped by class. |
| `bun test test/corpus.test.ts` | The same two checks offline, over `test/fixtures/slack-corpus.json` — one real message per distinct combination of element types. Known reverse-leg gaps are listed by ts with a reason. |
| `bun scripts/build-fixture.ts` | Rebuilds that fixture from the live archive. Run it after a new element type appears. |
| `bun scripts/replay.ts --stale --dry-run` | Which published records a fixed walker would improve: the record drops words of Slack's plaintext that a fresh derivation keeps. Drop `--dry-run` (with `INJECT_TOKEN`) to re-derive them through `/slack/replay`. |

Hand-written cases are what let `rich_text_list` and `message_mention` through:
both were dropped silently for months because an unhandled element type falls
out of the `switch` without an error. The corpus test exists so a block type
nobody thought of still has to survive the walk.

See the design proposal (PR #20) for HMAC verification details, the dedupe model (deterministic rkeys -> putRecord upsert), and the read-modify-write pattern for category `channelOrder` updates.
