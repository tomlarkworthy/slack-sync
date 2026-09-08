# @slack-sync/backfill

CLI for the historical seed. Reads a day's worth of Slack history JSON and publishes the messages, replies, and reactions to a bot's atproto repo as `social.colibri.message` + `social.colibri.reaction` records.

This is the **one-time-then-occasional** path. The real-time forward bridge is `@slack-sync/worker`. Both walk Slack blocks with the one implementation in `@slack-sync/shared`; this package supplies the dump-specific names, DIDs and emoji through `WalkContext`.

**Run it from the repository root** — the dump and mapping paths are relative to it.

Before a run, check the walker against the input it will be given:

```sh
bun packages/backfill/scripts/dump-fidelity.ts
```

It walks every eligible message in the dumps and compares against Slack's own
plaintext, and exits nonzero if any rich-text element type has no case in the
walker. As of 2026-09-08: 49,532 messages with `rich_text` blocks, 99 (0.20%)
differing — all comparator artifacts (custom emoji shortcodes splitting a word,
Slack autolinking a bare domain its block tree carries as plain text, ordinals
inside a quote) — and no unhandled element types.

A `--dry-run` (the default) prints the messages, channels and reactions it would
publish. `--live` logs in and refuses to publish unless the session DID is the
bridge bot.

`--diff-published` additionally fetches each derived record's published version
and reports which ones would actually change. A re-run rewrites every record for
the day, so this is how the blast radius is known before writing. Facets are
compared by value: the PDS returns CBOR-decoded maps in canonical key order,
which is not the order the walker builds them in, and comparing the serialised
form makes every record look changed.

## Running without the bot's app password

`--live` writes directly and needs `BSKY_HANDLE` + `BSKY_APP_PASSWORD`. The
bot's app password lives only as a Cloudflare Worker secret and a secret cannot
be read back, so the usable path is: the CLI derives, the worker writes.

```sh
# preview a range (skips days the dump does not have)
sh vendor/slack-sync/packages/backfill/scripts/run-days.sh 2026/04/05 2026/05/04 --diff-published

# derive the records that differ from what is published
sh …/run-days.sh 2026/04/05 2026/05/04 --skip-unmapped-channels --emit /tmp/out.jsonl

# publish them through the worker
INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts /tmp/out.jsonl
```

`--emit` writes exactly what `--live` would put — top-level messages, replies
and reactions — minus the records already published in that form, so a re-run of
a converged day emits nothing. `post-records.ts` posts to `POST
/backfill/records`; `--repair-only` sends to `POST /repair/messages` instead,
which refuses an rkey that is not already published, so a run meant to fix
existing records cannot add any.

`--skip-unmapped-channels` drops messages in Slack channels that have no entry
in `slack-to-colibri-channel.json`. Lazy-create would write the channel into the
*bot's* repo while the facet at-uri points at the community's own DID, so the
chip renders unresolved — the defect the 2026-09-08 repair fixed. Adding a
channel means creating it in Colibri, then adding it to
`slack-to-colibri-channel.json` and `packages/shared/src/channels.ts`, and
re-running the days it appears in.

A channel created after the 2026-08-12 community migration has only the new
rkey and no `migratedFrom` to resolve an old one through, so `oldRkey` is
absent and `bridgeChannelRkey()` writes the new one. #of-logic-programming and
#reading-together are the first two of these.

## Repairing already-backfilled records

`scripts/repair-days.sh` re-derives the days the first backfill covered:

```sh
sh vendor/slack-sync/packages/backfill/scripts/repair-days.sh                    # preview
sh …/repair-days.sh --emit /tmp/repair.jsonl                                     # derive
INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts /tmp/repair.jsonl   # write
```

`scripts/coverage.ts` prints the published archive by month, flags any record
still carrying literal `• ` / `> ` markers, and derives that day list — the
messages with no archived Slack envelope, which `/slack/replay` cannot reach.

Run 2026-09-08:

| | |
|---|---|
| 28 of 269 message records | lists and quotes published as literal `• ` and `> ` text before the block facets landed, a `#channel` facet published as a bare rkey, links Slack autolinked that the old walker dropped |
| 157 of 269 reaction records | missing `parent`, the at-uri the Colibri lexicon requires — they carried only the pre-lexicon `targetMessage`. Found by widening the diff from text+facets to the whole record |
| 1 message record | missing `$type` |

Then 2026/04/05–2026/05/04 was backfilled: 272 messages and 113 reactions,
381 created, 4 updated. #of-logic-programming and #reading-together were created
in Colibri afterwards, and re-running the range added their 8 messages and 7
reactions, plus one message whose `<#…>` mention now resolves to a facet. Both
ranges report 0 changed; the archive is 1467 messages.

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
