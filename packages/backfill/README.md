# @slack-sync/backfill

CLI for the historical seed. Reads a day's worth of Slack history JSON and publishes the messages, replies, and reactions to a bot's atproto repo as `social.colibri.message` + `social.colibri.reaction` records.

This is the **one-time-then-occasional** path. The real-time forward bridge is `@slack-sync/worker`. Both should share the lexicon / blocks-walker code once the worker lands; for now this package is self-contained.

## Inputs

It reads from disk, all paths CWD-relative:

| Path | Source |
|---|---|
| `vendor/feeling-of-computing/history/users.json` | Mariano's dump |
| `vendor/feeling-of-computing/history/channels.json` | Mariano's dump |
| `vendor/feeling-of-computing/history/YYYY/MM/DD.json` | one day's top-level messages |
| `vendor/feeling-of-computing/history/YYYY/MM/DD.replies.json` | thread replies for that day |
| `vendor/feeling-of-computing/conversations/src/emoji-data.js` | Slack-emoji to unicode (loaded dynamically) |
| `tools/slack-to-did.json` | Slack user id -> claimed atproto DID (gitignored, optional) |
| `tools/slack-to-colibri-channel.json` | Slack channel id -> Colibri channel rkey (gitignored) |

The two `tools/` JSONs are workspace-specific. See PR #20 for the format.

## Usage

```sh
# Dry-run preview
bun src/index.ts --src-day 2026/05/30 --limit 50

# Live publish
BSKY_HANDLE=focbridge.bsky.social \
BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
bun src/index.ts --src-day 2026/05/30 --live
```

Per-day, idempotent (all rkeys derived deterministically from Slack identifiers; `putRecord` upserts). Re-running over the same day after changing the derivation re-derives every record in place.

When some channels need lazy-creation (not in `slack-to-colibri-channel.json`), additionally set `COLIBRI_COMMUNITY_URI` + `COLIBRI_CATEGORY_RKEY`.

## Design

See [the proposal](https://github.com/feelingofcomputing/wiki/pull/20) for: write order (slackRaw -> message -> slackOrigin), authorship constraints, channel-ownership constraint, lossless archival via `com.feelingofcomputing.bridge.slackRaw`, and the full upstream-asks list.

## Implementation note

The single-file structure is intentional for v0: easier to read end-to-end while the design is still moving. As the worker lands and we extract shared logic, this file decomposes into `packages/shared/` modules (TID derivation, blocks walker, emoji map, atproto put/get helpers).
