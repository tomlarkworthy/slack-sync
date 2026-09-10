# @slack-sync/backfill

CLI for the historical seed. Reads a day's worth of Slack history JSON and publishes the messages, replies, and reactions to a bot's atproto repo as `social.colibri.message` + `social.colibri.reaction` records.

This is the **one-time-then-occasional** path. The real-time forward bridge is `@slack-sync/worker`. Both walk Slack blocks with the one implementation in `@slack-sync/shared`; this package supplies the dump-specific names, DIDs and emoji through `WalkContext`.

**Run it from the repository root** — the dump and mapping paths are relative to
it. A missing day file is an error rather than an empty day, so a wrong CWD says
so instead of reporting "0 messages".

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

Both drivers default to `--diff-published` and print one `TOTAL` line for the
whole range.

```sh
# what would change over a range (skips days the dump does not have)
sh vendor/slack-sync/packages/backfill/scripts/run-days.sh 2026/04/05 2026/05/04

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

## Backfilling the whole corpus

Two phases, so a link that drops only affects the second.

```sh
# 1. derive every day in the dumps — entirely offline, ~2 min, re-runnable
sh vendor/slack-sync/packages/backfill/scripts/derive-all.sh tools/backfill-all.jsonl

# 2. publish, resumably
INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts tools/backfill-all.jsonl
```

Phase 2 writes `<input>.watermark.json` after every batch of 20 and resumes from
it, so re-running the same command after a drop, a ^C or a reboot continues
where it stopped. `--limit N` stops after N records, `--restart` discards the
watermark, `--dry-run` counts the input.

Every batch is retried with exponential backoff — 12 attempts capped at 5 min,
about half an hour of outage tolerated — and a 429 honours `Retry-After`. One
bad record no longer costs its batch: the worker reports it in `failed` and the
run carries on, with the first 200 recorded in the watermark.

The PDS meters writes per repo. `/backfill/records` returns the remaining
budget with every response and the run pauses for the window to reset when it
runs low, rather than discovering the limit as a 429. Measured 2026-09-10:
`3000;w=300` — 3000 points per 5 minutes, ~1.2 points per write, so ~8 writes/s
available. The observed rate is ~3/s, so the round trip binds first, not the
budget.

As of 2026-09-10 the dumps are 2919 days, 2017–2026: **104,208 derived records,
77,010 distinct** (54,633 messages, 22,377 reactions) — the difference is thread
replies appearing in more than one day's replies file, byte-identical each time.
No two records with different content share an rkey.

Four channels have no Colibri channel and are skipped, 2116 messages in total:
**#of-end-user-programming** (884), **#of-graphics** (853), **#of-music** (303),
**#of-functional-programming** (76). Creating them and re-running picks them up.

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

The two `tools/` JSONs are workspace-specific; `packages/shared/src/channels.ts` and
`slack-to-did.ts` are the worker's copies of the same two maps and must agree with them. See the
[wiki page's Maintenance section](https://wiki.feelingof.com/slack-colibri-bridge/) for the format.

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

See <https://wiki.feelingof.com/slack-colibri-bridge/> for: write order (slackRaw -> message ->
slackOrigin), authorship constraints, the channel-ownership constraint, lossless archival via
`com.feelingofcomputing.bridge.slackRaw`, and the known gaps.

## Implementation note

The single-file structure is intentional for v0: easier to read end-to-end while the design is still moving. As the worker lands and we extract shared logic, this file decomposes into `packages/shared/` modules (TID derivation, blocks walker, emoji map, atproto put/get helpers).
