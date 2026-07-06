#!/usr/bin/env bash
# Adaptive backfill drainer for the sermon transcripts.
#
# The caption endpoint rate-limits by IP, so we can't blast all 443 at once.
# This loop downloads a small batch, ingests whatever landed, and adapts:
#   - made progress  -> short pause, keep going (we're flowing)
#   - no progress    -> exponential backoff (we're blocked, wait it out)
# It finishes when the downloader reports "Remaining to fetch: 0" — i.e. every
# video is either ingested, on disk, or genuinely has no captions. Fully
# resumable: killing and restarting loses nothing.

set -u
cd "$(dirname "$0")" || exit 1

BATCH=15             # small batches so a mid-batch re-throttle costs little
INITIAL_COOLDOWN=600 # let the current throttle ease before the first attempt
PROGRESS_PAUSE=60    # short pause between batches while captions are flowing
backoff=900          # starting backoff when blocked (15 min)
MAX_BACKOFF=1800     # cap each wait at 30 min so it keeps probing
stall=0
MAX_STALL=50         # effectively "keep going through any realistic block"

dbcount() {
  node --env-file=.env -e "import('./db.ts').then(async m=>{const db=await m.connect();const s=await m.ingestedVideoIds(db);console.log(s.size)})" 2>/dev/null | tail -1
}

echo "[$(date +%H:%M:%S)] drainer start. DB has $(dbcount) videos. Cooling ${INITIAL_COOLDOWN}s first…"
sleep "$INITIAL_COOLDOWN"

while true; do
  before=$(dbcount)

  echo "[$(date +%H:%M:%S)] downloading up to $BATCH…"
  out=$(node download_transcripts.ts "$BATCH" 2>&1)
  echo "$out" | grep -iE "missing; fetching|Phase|Remaining to fetch|Nothing to download" | tail -6

  echo "[$(date +%H:%M:%S)] ingesting…"
  node --env-file=.env ingest_from_disk.ts 2>&1 | grep -iE "Done\.|Already in DB" | tail -2

  after=$(dbcount)
  remaining=$(echo "$out" | grep -oE "Remaining to fetch: [0-9]+" | grep -oE "[0-9]+" | tail -1)
  echo "[$(date +%H:%M:%S)] DB now $after videos. Remaining to fetch: ${remaining:-?}"

  # Clean finish: nothing left that we can fetch.
  if [ "${remaining:-1}" = "0" ] || echo "$out" | grep -q "Nothing to download"; then
    echo "[$(date +%H:%M:%S)] all obtainable transcripts fetched. Done. Final DB: $(dbcount) videos."
    break
  fi

  if [ "$after" -gt "$before" ]; then
    stall=0
    backoff=900
    echo "[$(date +%H:%M:%S)] progress (+$((after - before))). pause ${PROGRESS_PAUSE}s."
    sleep "$PROGRESS_PAUSE"
  else
    stall=$((stall + 1))
    echo "[$(date +%H:%M:%S)] no progress (blocked). stall $stall/$MAX_STALL. backoff ${backoff}s."
    if [ "$stall" -ge "$MAX_STALL" ]; then
      echo "[$(date +%H:%M:%S)] hit $MAX_STALL straight blocked cycles; pausing. Re-run drain.sh to continue."
      break
    fi
    sleep "$backoff"
    backoff=$((backoff * 2))
    [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
  fi
done

echo "[$(date +%H:%M:%S)] drainer finished. Final DB count: $(dbcount) videos."
