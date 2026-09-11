# What the backfill did not carry

The full-corpus backfill ran 2026-09-10/11 and published 77,010 records
(75,867 created, 2 updated, 1,139 already present, 2 transient PDS failures
re-posted afterwards). This is what it left behind, so a later repair knows what
it is repairing.

Every number here comes from `bun packages/backfill/scripts/gaps.ts`, run from
the repository root against `vendor/feeling-of-computing/history` on 2026-09-11.
Re-run it after changing the channel map or the walker; the counts below are a
snapshot, not a definition.

```
78718 dump messages, 75221 published (95.6%)
```

## Not published at all — 3,497 messages

```
  2116  unmapped channel
  1105  subtype
   276  no text field
```

### Unmapped channels — 2,116 messages, repairable today

```
   884  CLYCGTCPL #of-end-user-programming
   853  CE1R695T7 #of-graphics
   303  CEZ6QTHL1 #of-music
    76  C0133ED5811 #of-functional-programming
```

These four have no Colibri channel, so `--skip-unmapped-channels` drops them.
The alternative — the CLI's lazy-create path — writes the channel into the
**bot's** repo while the facet at-uri points at the community's DID, which is
what produced the unresolved chip repaired on 2026-09-08. Dropping was chosen
deliberately over publishing into a channel nothing can resolve.

**Repair**: create the four channels in Colibri, add them to
`tools/slack-to-colibri-channel.json` and `packages/shared/src/channels.ts`
(a channel created after the 2026-08-12 migration has no `oldRkey` — see
`bridgeChannelRkey`), then re-run `derive-all.sh` and `post-records.ts`.
Everything already published comes back `unchanged`. This is exactly the
procedure that added #of-logic-programming and #reading-together on 2026-09-08;
it took one commit and published 8 messages plus 7 reactions.

### Subtypes — 1,105 messages

```
   551  channel_join
   407  thread_broadcast
    92  bot_message
    21  channel_topic
    10  tombstone
     9  channel_name
     6  channel_purpose
     4  file_comment
     3  me_message
     2  reply_broadcast
```

`src/index.ts` filters on `!m.subtype`. Most of this is noise a reader does not
want — `channel_join`, `channel_topic`, `channel_name`, `channel_purpose`,
`tombstone` are 597 of the 1,105 and carry no conversation.

**`thread_broadcast` (407) is the one worth revisiting.** It is a real reply
that the author also sent to the channel, so the text is a genuine message that
is currently dropped entirely. Whether it should publish as an ordinary reply,
or as a reply plus a channel-level pointer, is a product question nobody has
asked yet. `reply_broadcast` (2) is its older spelling.

`bot_message` (92) is undecided: some are integrations worth keeping (RSS,
GitHub), some are noise. Not inspected.

`me_message` (3) is `/me` — trivially publishable as ordinary text if anyone
cares.

### No `text` field — 276 messages

Filtered by `!m.text`. Not inspected further; likely file-only posts, which
would be empty text with an attachment. Given attachments are not bridged
either (below), publishing these would produce 276 empty messages, so the filter
is currently doing the right thing for the wrong reason.

## Published, but not everything the message carried

```
  10019 carry files or attachments (not bridged)
  11584 are marked edited (the dump has only the final text)
    853 exceed the 2048-char cap, losing 677955 characters
```

### Attachments — 10,019 messages

Slack file uploads. The message text publishes; the file does not. Top types:

```
  1225 png    227 jpg    191 mp4    119 mov     88 gif
    68 webm    51 pdf     18 text    11 mkv      7 webp
```

The live worker does bridge blobs, and `@tomlarkworthy/at-read`'s
`cachedBlob(pds, did, cid)` already resolves them in the viewer, so the reading
half exists. What is missing on the backfill side is fetching each file from
Slack (the dump stores URLs, not bytes) and uploading it as an atproto blob.
That needs a Slack token with `files:read` and is the largest single piece of
work on this list.

Not attempted. Unknown whether the dump's `url_private` links still resolve for
8-year-old files.

### The 2048-character cap — 853 messages, 677,955 characters

`publishMessage` truncates at 2048 and drops the facets past it, and the
backfill applies the same limit. **This one is not ours to change**: the
published lexicon says so. Read from the network on 2026-09-11 —
`getRecord repo=did:plc:mprdjqjluoswa7awzggaggj3
collection=com.atproto.lexicon.schema rkey=social.colibri.message`:

```json
"text": {"type": "string", "maxLength": 2048, "description": "The message content."}
```

So a repair means either splitting a long message across several records, or
asking Colibri to raise the limit. Splitting changes the rkey-is-the-Slack-
timestamp property that makes every derivation replayable, so it is not a small
change. Nothing decided.

These records are also invisible to the repair tooling by design:
`replay.ts`'s `atCap` guard excludes them, because a capped record always looks
improvable and would be re-selected on every run forever.

### Edits — 11,584 messages

The dump carries only the final text of an edited message, so the archive has
the final text and no history. Nothing is lost relative to the dump; recording
it here because "11,584 messages were edited" is easy to mistake for "11,584
messages are wrong".

## Legacy messages — 27,094 published without `rich_text` blocks

Slack only started sending the `blocks` tree in 2019. Before that the walker
falls back to `legacyTextFallback`, which is regex link extraction over the
plain `text` field — no bold, italic, code, lists or quotes, because the input
does not carry them.

```
  2017    556/556  100%
  2018   5106/5106  100%
  2019  21104/23762  89%
  2020    323/21536   1%
  2021      4/6637   0%
  2022+        0     0%
```

The cutover is inside 2019 and is sharp. **This is not repairable** — the
structure was never in the dump. What can be improved is the fallback: of those
27,094 messages, **326 contain a line starting with a bullet character and 733 a
line starting with `>`**, which a human wrote as markup and which currently
publish as literal text. Promoting those to `#list` and `#quote` facets is a
heuristic on the legacy path only, and it would be guessing where the structured
path knows. Untried, and the risk is a false positive on a line that genuinely
starts with `-` or `>`.

The by-month scan in `scripts/coverage.ts` flags these as "literal • / >
markers". They are not the 2026-era defect that scan was written to catch (a
walker dropping block facets, repaired 2026-09-08); they are pre-2019 messages
with nothing better available.

## What is verified sound

Stated so a later session does not re-derive it:

- **No rkey collisions.** 104,208 emitted records collapse to 77,010 distinct
  keys, and every duplicate is byte-identical — thread replies appearing in more
  than one day's replies file. Zero cases of different content sharing an rkey,
  checked across the whole corpus before publishing.
- **No unhandled rich-text element types.** `scripts/dump-fidelity.ts` walks all
  2,919 dump days: 49,532 messages with blocks, 99 (0.20%) losing a word of
  Slack's own plaintext, all comparator artifacts.
- **Both 2026 ranges converge.** `repair-days.sh` and `run-days.sh 2026/04/05
  2026/05/04` each report 0 changed.
