#!/bin/sh
# Re-derive the days the original backfill covered, in place.
#
# Run from the repository root. Default is a preview:
#   sh vendor/slack-sync/packages/backfill/scripts/repair-days.sh
#   sh …/repair-days.sh --emit /tmp/repair.jsonl
#
# The day list is exactly the days that already have published records
# (packages/backfill/scripts/coverage.ts derives it). 2026/05/01, 05/03 and
# 05/04 have dumps but were never backfilled — running them would add 31 new
# messages rather than repair anything, so they are not here.
set -e
. "$(dirname "$0")/lib/run-days.sh"
BACKFILL_ARGS="$*"
[ -n "$BACKFILL_ARGS" ] || BACKFILL_ARGS="--diff-published"
tr ' ' '\n' <<'DAYS' | run_days
2026/05/05 2026/05/06 2026/05/07 2026/05/08 2026/05/10 2026/05/11
2026/05/12 2026/05/13 2026/05/14 2026/05/16 2026/05/18 2026/05/19 2026/05/20
2026/05/21 2026/05/22 2026/05/23 2026/05/24 2026/05/25 2026/05/26 2026/05/27
2026/05/28 2026/05/29 2026/05/30 2026/05/31 2026/06/01
DAYS
