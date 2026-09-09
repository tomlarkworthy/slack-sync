# Shared by run-days.sh and repair-days.sh: run the backfill over a list of days
# and print one total at the end.
#
# Reading a multi-day run meant re-parsing its per-day "DIFF vs PUBLISHED" lines
# by hand every time, which is how "28 of 299" reached a commit message when the
# real figure was 269.
#
# Days arrive on stdin, one YYYY/MM/DD per line. $BACKFILL_ARGS holds the flags
# to pass through. Run from the repository root.

run_days() {
  _log=$(mktemp)
  while read -r d; do
    [ -n "$d" ] || continue
    if [ ! -f "vendor/feeling-of-computing/history/$d.json" ]; then
      echo "$d  (no dump)"
      continue
    fi
    bun vendor/slack-sync/packages/backfill/src/index.ts --src-day "$d" $BACKFILL_ARGS |
      tee -a "$_log"
  done
  python3 - "$_log" <<'PY'
import re, sys
c = n = u = t = days = 0
for line in open(sys.argv[1]):
    m = re.search(r": (\d+) would change \((\d+) new\), (\d+) unchanged, of (\d+)", line)
    if m:
        days += 1
        c += int(m[1]); n += int(m[2]); u += int(m[3]); t += int(m[4])
if days:
    print(f"\nTOTAL over {days} days: {c} would change ({n} new), {u} unchanged, of {t}")
PY
  rm -f "$_log"
}
