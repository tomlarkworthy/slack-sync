#!/bin/sh
# Phase 1 of a full backfill: derive every day in the dumps into one JSONL.
# Entirely offline — no network, so it can be re-run at any time, and a bad
# link only affects phase 2.
#
#   sh vendor/slack-sync/packages/backfill/scripts/derive-all.sh [out.jsonl] [from] [to]
#
# Then publish it, resumably:
#   INJECT_TOKEN=… bun packages/backfill/scripts/post-records.ts out.jsonl
#
# Days are emitted oldest first, so an interrupted phase 2 has published a
# prefix of the community's history rather than a scatter. Channels with no
# Colibri channel are skipped (--skip-unmapped-channels); adding one and
# re-running picks its messages up.
set -e
OUT="${1:-tools/backfill-all.jsonl}"
FROM="${2:-2017/01/01}"
TO="${3:-2026/12/31}"
H=vendor/feeling-of-computing/history
[ -d "$H" ] || { echo "no $H — run from the repository root"; exit 1; }
: > "$OUT"
n=0
# Dates are zero-padded, so a lexical range is a date range.
for f in $(find "$H" -name '*.json' ! -name '*.replies.json' ! -name 'index.json' \
             ! -name 'users.json' ! -name 'channels.json' |
           sed "s|^$H/||;s|\.json$||" | sort |
           awk -v a="$FROM" -v b="$TO" '$0 >= a && $0 <= b'); do
  bun vendor/slack-sync/packages/backfill/src/index.ts \
    --src-day "$f" --skip-unmapped-channels --emit "$OUT" > /dev/null
  n=$((n + 1))
  [ $((n % 100)) -eq 0 ] && printf '\r%s days, %s records  ' "$n" "$(wc -l < "$OUT" | tr -d ' ')"
done
printf '\r%s days, %s records\n' "$n" "$(wc -l < "$OUT" | tr -d ' ')"
