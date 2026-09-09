#!/bin/sh
# Run the backfill over a date range, skipping days the dump does not have.
# Run from the repository root.
#
#   sh …/run-days.sh 2026/04/05 2026/05/04
#   sh …/run-days.sh 2026/04/05 2026/05/04 --skip-unmapped-channels --emit /tmp/out.jsonl
#
# Defaults to --diff-published, so a bare run reports what would change rather
# than a preview with no comparison. --emit writes the records that differ from
# what is published; scripts/post-records.ts publishes them through the worker.
set -e
. "$(dirname "$0")/lib/run-days.sh"
FROM="$1"; TO="$2"; shift 2
BACKFILL_ARGS="$*"
[ -n "$BACKFILL_ARGS" ] || BACKFILL_ARGS="--diff-published"
python3 -c "
import datetime
f=datetime.date(*map(int,'$FROM'.split('/')))
t=datetime.date(*map(int,'$TO'.split('/')))
while f<=t:
    print(f.strftime('%Y/%m/%d')); f+=datetime.timedelta(days=1)
" | run_days
