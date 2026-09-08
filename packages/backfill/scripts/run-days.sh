#!/bin/sh
# Run the backfill over a date range, skipping days the dump does not have.
# Run from the repository root.
#
#   sh …/run-days.sh 2026/04/05 2026/05/04 --skip-unmapped-channels --emit /tmp/out.jsonl
#
# With no trailing flags it previews. --emit writes the records that differ
# from what is published; scripts/post-records.ts publishes them through the
# worker.
set -e
FROM="$1"; TO="$2"; shift 2
for d in $(python3 -c "
import datetime,sys
f=datetime.date(*map(int,'$FROM'.split('/')))
t=datetime.date(*map(int,'$TO'.split('/')))
while f<=t:
    print(f.strftime('%Y/%m/%d')); f+=datetime.timedelta(days=1)
"); do
  [ -f "vendor/feeling-of-computing/history/$d.json" ] || { echo "$d  (no dump)"; continue; }
  bun vendor/slack-sync/packages/backfill/src/index.ts --src-day "$d" "$@"
done
