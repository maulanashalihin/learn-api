#!/bin/bash
# writer.sh — write N records rapid-fire, report write time in ms
NUM=$1
SCHEME=$2
PORT=3001
START_MS=$(date +%s%N)
START_MS=$((START_MS / 1000000))
for i in $(seq 1 $NUM); do
  curl -sk -X POST ${SCHEME}://localhost:${PORT}/write \
    -H 'Content-Type: application/json' \
    -d "{\"id\": $i, \"name\": \"User$i\", \"city\": \"SG\"}" >/dev/null 2>&1 &
done
wait
END_MS=$(date +%s%N)
END_MS=$((END_MS / 1000000))
echo "WRITE_DONE $((END_MS - START_MS))"
